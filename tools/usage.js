'use strict';
/**
 * Read Catalyst spend from the console billing breakdown.
 *
 * Catalyst bills Data Store writes **per row**, not per API call — Insert at ₹0.006 and Delete
 * at ₹0.0048. That distinction is the whole reason this exists: a load sized against the API
 * call budget (200,000 calls) looks free and is not. 8.24M rows is ~₹49,000, and exhausting the
 * plan blocks *every* resource in the environment, so the app goes down with it.
 *
 * Requires the CDP-attached Chrome from DEVELOPMENT.md section 10.
 *
 *   node tools/usage.js            # spend summary
 *   node tools/usage.js --rows     # also print how many more rows the balance affords
 */
const { chromium } = require('playwright-core');

const ENV = process.env.CATALYST_ENV_ID || '60079622152';
const INSERT_COST = 0.006;

function money(s) {
  const m = String(s).replace(/[^\d.]/g, '');
  return m ? Number(m) : null;
}

async function read() {
  const browser = await chromium.connectOverCDP(process.env.CDP_URL || 'http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);
  try {
    await page.goto(`https://console.catalyst.zoho.in/baas/${ENV}/index#/settings/billings/breakdown`,
      { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(11000);
    // Per-resource figures (the Insert count that dominates spend) are only on the component
    // view; the default project view shows totals per project. The switcher is a native select
    // behind a styled wrapper, so it is set rather than clicked.
    const sel = page.locator('select').filter({ hasText: 'Component Usage Stats' }).first();
    if (await sel.count()) {
      await sel.selectOption({ label: 'Component Usage Stats' }, { force: true });
      await page.waitForTimeout(11000);
    }
    const text = (await page.locator('body').innerText()).replace(/\u00a0/g, ' ');

    const grab = (re) => { const m = text.match(re); return m ? m[1] : null; };
    const out = {
      plan: grab(/Plan\s*:\s*\n?([A-Za-z ]+)/),
      grossTotal: money(grab(/Gross Total\s*\n\s*₹([\d.]+)/)),
      balance: money(grab(/Gross Total\)\s*\n\s*₹([\d.]+)/)),
      inserts: (() => { const m = text.match(/Insert\s*\n\s*([\d,]+) Requests/); return m ? Number(m[1].replace(/,/g, '')) : null; })(),
      insertCost: money(grab(/Insert\s*\n\s*[\d,]+ Requests\s*\n\s*₹[\d.]+\s*\n\s*₹([\d.]+)/)),
      blocked: /exhausted your subscription plan/i.test(text),
    };

    // Total usable amount lives on the Overview page, not the breakdown.
    await page.goto(`https://console.catalyst.zoho.in/baas/${ENV}/index#/settings/billings/overview`,
      { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(9000);
    const ov = (await page.locator('body').innerText()).replace(/\u00a0/g, ' ');
    const um = ov.match(/Total Usable Amount:\s*₹([\d.]+)\s*\+\s*\n?₹([\d.]+)/);
    out.usable = um ? Number(um[1]) + Number(um[2]) : null;
    return out;
  } finally {
    await page.close().catch(() => {});
    await browser.close();
  }
}

/** Read with retries: the billing page renders its figures asynchronously and a first load
 *  sometimes returns the shell, which would report a blank balance as if it were zero. */
async function readRetry(attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i++) {
    const u = await read();
    if (u.grossTotal != null && u.usable != null) return u;
    last = u;
  }
  return last;
}

module.exports = { read, readRetry, INSERT_COST };

if (require.main === module) {
  readRetry().then((u) => {
    const left = u.usable != null && u.grossTotal != null ? u.usable - u.grossTotal : null;
    console.log(`plan            ${u.plan || '?'}`);
    console.log(`total usable    ₹${u.usable ?? '?'}`);
    console.log(`used            ₹${u.grossTotal ?? '?'}`);
    console.log(`remaining       ₹${left != null ? left.toFixed(2) : '?'}`);
    console.log(`datastore inserts ${(u.inserts ?? 0).toLocaleString('en-IN')}  (₹${u.insertCost ?? '?'})`);
    console.log(`blocked         ${u.blocked}`);
    if (left != null) {
      console.log(`\nrows affordable at ₹${INSERT_COST}/row: ` +
        `${Math.floor(Math.max(0, left) / INSERT_COST).toLocaleString('en-IN')}`);
    }
  }).catch((e) => { console.error('ERR', e.message); process.exit(1); });
}
