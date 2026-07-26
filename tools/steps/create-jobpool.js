'use strict';
/**
 * Create the Job Scheduling pool that carries a WhatsApp turn off the webhook.
 *
 * The webhook has to answer Meta in seconds; an agent turn takes 10–20 (an LLM loop,
 * several ZCQL round-trips, up to a dozen Zia comparisons). Without a pool the
 * function processes the turn inline — still correct, because every inbound wamid is
 * claimed once and a redelivery is discarded rather than answered twice, but Meta
 * does redeliver, and each redelivery costs an invocation for nothing.
 *
 * With the pool, `acceptWebhook` authenticates, claims the id, submits the job and
 * returns; the turn runs in the job with retries and failure isolation. That path is
 * already written and unit-tested and is dead code until a pool exists, which is the
 * only reason this step is worth having.
 *
 * Type is **Webhook**: the job POSTs back to `/whatsapp/process` with the internal
 * key, so the slow half runs in the same Express app as the fast half and there is
 * one implementation of a turn rather than two.
 *
 * After running this, put the pool name in WA_JOBPOOL and redeploy the function.
 *
 *   node tools/drive.js tools/steps/create-jobpool.js
 *   node tools/drive.js tools/steps/create-jobpool.js --list
 */
const { BASE } = require('./table-columns');

const ROUTE = BASE + '#/jobscheduling/jobpool';
// Alphanumeric only — and note this is the exact opposite of the cron rule, which
// *requires* underscores over hyphens. A job pool name containing an underscore is
// refused by the console's own validation, which sends no request, logs nothing and
// leaves the dialog open, so the failure is indistinguishable from a dead button.
const NAME = 'kspwaturns';
const TYPE = 'Webhook';
/**
 * Concurrent turns the pool will run. Deliberately not the maximum on offer.
 *
 * A turn is latency-bound on the model, not on throughput, so a higher count does
 * not make any single officer's reply arrive sooner — it only puts more simultaneous
 * ZCQL queries against the same Data Store, and the measured concurrency ceiling
 * there is low (the analytics layer had to drop to four parallel queries before
 * aggregates over a million rows stopped failing). Five concurrent field turns is
 * well beyond real demand for a district roster and stays clear of that ceiling.
 */
const MAX_COUNT = '5';

async function open(page) {
  await page.goto(ROUTE, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(9000);
  // First visit to Job Scheduling lands on the service's onboarding panel rather
  // than the pool list.
  const start = page.getByRole('button', { name: /Start Exploring/i }).first();
  if (await start.count()) { await start.click(); await page.waitForTimeout(7000); }
}

async function poolNames(page) {
  const text = await page.locator('body').innerText();
  return Array.from(new Set(
    text.split(/[\t\n]/).map((s) => s.trim()).filter((s) => /^ksp[a-z0-9]+$/.test(s))
  ));
}

module.exports = async (page, args) => {
  await open(page);
  const existing = await poolNames(page);
  if (args.includes('--list')) return { jobPools: existing };
  if (existing.includes(NAME)) return { jobPool: NAME, status: 'already present', jobPools: existing };

  // Surface the API's own rejection. Like the cron form, this dialog stays open and
  // silent when the payload is refused — the cron API, for one, rejects any name
  // containing a hyphen and says so only in the response body.
  const apiErrors = [];
  page.on('response', async (r) => {
    if (r.request().method() !== 'POST' || !/job_?pool/i.test(r.url()) || r.status() < 400) return;
    let body = '';
    try { body = (await r.text()).slice(0, 400); } catch (_) { /* body may be gone */ }
    apiErrors.push({ status: r.status(), body });
  });

  await page.locator('[data-zcqa="jobpool_create_btn"]').first().click();
  await page.waitForTimeout(4000);
  // data-zcqa sits on the lyte-input wrapper, not the field, so target the real input.
  await page.locator('#jobpool_name').first().fill(NAME);

  // The type control is a lyte dropdown, not a <select>: open it and click the option
  // inside the dropbox. Matching on page-wide text picks up the sidebar instead, and
  // an unselected type makes the dialog refuse to submit without saying anything.
  const dropdown = page.locator('[data-zcqa="commonForm_dropdown_jobpool_type"]').first();
  await dropdown.click();
  await page.waitForTimeout(2000);
  await page.locator('lyte-drop-box, lyte-dropdown-body, [class*="dropBox"]')
    .locator(`text="${TYPE}"`).first().click();
  await page.waitForTimeout(1200);

  const chosen = (await dropdown.innerText()).trim();
  if (!new RegExp(TYPE, 'i').test(chosen)) {
    throw new Error(`job pool type did not select; dropdown reads "${chosen}"`);
  }

  // "Allocate Max Count" only appears once a type is chosen, and it is required —
  // leaving it empty makes Create a no-op with no message and no request sent.
  const maxCount = page.locator('#jobpool_max_memory').first();
  await maxCount.click();
  await page.waitForTimeout(1200);
  await maxCount.pressSequentially(MAX_COUNT, { delay: 120 });
  await page.waitForTimeout(1500);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  // Close the suggestion list by clicking a neutral label. It otherwise stays open
  // over the footer; Escape is not an option because it dismisses the whole dialog.
  await page.getByText('Job Pool Name', { exact: true }).first().click();
  await page.waitForTimeout(1200);
  if (!(await maxCount.inputValue())) throw new Error('allocate-max-count did not take a value');

  await page.locator('[data-zcqa="create_jobpool_btn"]').first().click();
  await page.waitForTimeout(8000);
  if (apiErrors.length) throw new Error('job pool create rejected: ' + JSON.stringify(apiErrors[0]));

  await open(page);
  const now = await poolNames(page);
  return {
    jobPool: NAME,
    type: TYPE,
    maxConcurrent: MAX_COUNT,
    status: now.includes(NAME) ? 'created' : 'NOT VISIBLE after save',
    jobPools: now,
    next: 'set WA_JOBPOOL=' + NAME + ' in functions/api/catalyst-config.json and redeploy'
  };
};
