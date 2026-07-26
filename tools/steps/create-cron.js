'use strict';
/**
 * Create the recurring cron that pushes early-warning alerts to officers' handsets.
 *
 * Without this, `dispatchAlerts` is code nobody calls: the proactive half of the
 * WhatsApp channel simply never fires. There is no CLI for Cron, so it joins the
 * console-driven provisioning steps. Idempotent — an existing cron of the same name
 * is reported and skipped.
 *
 * The internal key is read from `functions/api/catalyst-config.json` (gitignored)
 * rather than taken as an argument, so the secret never appears in shell history or
 * in the process list.
 *
 * Daily rather than hourly, deliberately. The forecast horizon is a month, and the
 * dispatch dedupes on district + horizon + severity, so a daily run sends each
 * genuine signal once and then quietly no-ops until the horizon rolls over or a
 * district's severity changes. Hourly would burn the same work 24 times for the
 * same result. 06:30 IST puts the advisory in front of supervisors before the
 * morning shift is deployed, which is the only time it can change a decision.
 *
 *   node tools/drive.js tools/steps/create-cron.js
 *   node tools/drive.js tools/steps/create-cron.js --list
 */
const path = require('path');
const { BASE } = require('./table-columns');

const ROUTE = BASE + '#/cloudscale/cron';
// Underscores, not hyphens: the API rejects anything else with
// "cron_name must contain only alphanumeric and underscore" — and the console
// renders no error at all when it does, so the form just sits there looking saved.
const NAME = 'ksp_wa_early_warning';
const URL = 'https://ksp.cyberkunju.com/server/api/whatsapp/alerts/dispatch';
const HOUR = '06';
const MINUTE = '30';

function internalKey() {
  const cfg = require(path.join(__dirname, '../../functions/api/catalyst-config.json'));
  const key = cfg && cfg.deployment && cfg.deployment.env_variables
    && cfg.deployment.env_variables.WA_INTERNAL_KEY;
  if (!key) throw new Error('WA_INTERNAL_KEY missing from functions/api/catalyst-config.json');
  return key;
}

async function open(page) {
  await page.goto(ROUTE, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8000);
}

/** Existing cron names, from the rendered list. */
async function cronNames(page) {
  const text = await page.locator('body').innerText();
  return Array.from(new Set(
    text.split(/[\t\n]/).map((s) => s.trim()).filter((s) => /^ksp_[a-z0-9_]+$/.test(s))
  ));
}

/**
 * Select a lyte-styled radio. The underlying input is positioned off-viewport, so
 * Playwright's click refuses it; the styled ancestor is what the component listens
 * to. Clicking both covers either implementation.
 */
function pickRadio(page, hook) {
  return page.evaluate((h) => {
    const el = document.querySelector(`[data-zcqa="${h}"]`);
    if (!el) return false;
    (el.closest('lyte-radio') || el.parentElement).click();
    el.click();
    return true;
  }, hook);
}

module.exports = async (page, args) => {
  await open(page);
  const existing = await cronNames(page);
  if (args.includes('--list')) return { crons: existing };
  if (existing.includes(NAME)) return { cron: NAME, status: 'already present', crons: existing };

  const key = internalKey();

  // Capture the create call's own answer. The console shows nothing at all when the
  // API rejects the payload — no toast, no field highlight, the form simply stays
  // open — so without this a validation failure reads as "the click didn't work".
  const apiErrors = [];
  page.on('response', async (r) => {
    if (r.request().method() !== 'POST' || !/\/cron\b/.test(r.url()) || r.status() < 400) return;
    let body = '';
    try { body = (await r.text()).slice(0, 400); } catch (_) { /* body may be gone */ }
    apiErrors.push({ status: r.status(), body });
  });

  // The empty state and the populated list expose the same label but only the
  // populated one is a plain button, so match on the accessible name either way.
  await page.getByRole('button', { name: /Create Cron/i }).first().click();
  await page.waitForTimeout(4000);

  await page.locator('[data-zcqa="cron_input_name"]').first().fill(NAME);
  await page.locator('[data-zcqa="cron_input_description"]').first()
    .fill('Pushes flagged districts from the forecast snapshot to subscribed field officers over WhatsApp.');

  if (!await pickRadio(page, 'cron_for_thirdPartyURL')) throw new Error('third-party URL option not found');
  await page.waitForTimeout(2500);

  await page.locator('[data-zcqa="cron_input_thirdPartyURL"]').first().fill(URL);
  await page.locator('[data-zcqa="cron_select_requestMethod"]').first()
    .selectOption({ label: 'POST' }, { force: true });

  await page.locator('[data-zcqa="cron_header_name_1"]').first().fill('x-wa-internal-key');
  await page.locator('[data-zcqa="cron_header_value_1"]').first().fill(key);

  if (!await pickRadio(page, 'cron_type_recursive')) throw new Error('recursive option not found');
  await page.waitForTimeout(2500);

  await page.locator('[data-zcqa="cron_select_recursiveType"]').first()
    .selectOption({ label: 'Daily' }, { force: true });
  await page.waitForTimeout(1500);
  await page.locator('[data-zcqa="cron_select_hour"]').first().selectOption(HOUR, { force: true });
  await page.locator('[data-zcqa="cron_select_minutes"]').first().selectOption(MINUTE, { force: true });
  await page.locator('[data-zcqa="cron_select_seconds"]').first().selectOption('00', { force: true });
  await page.locator('[data-zcqa="cron_select_timezone"]').first()
    .selectOption('Asia/Kolkata', { force: true });

  await page.locator('[data-zcqa="cron_btn_save"]').first().click();
  await page.waitForTimeout(9000);
  if (apiErrors.length) throw new Error('cron create rejected: ' + JSON.stringify(apiErrors[0]));

  await open(page);
  const now = await cronNames(page);
  return {
    cron: NAME,
    status: now.includes(NAME) ? 'created' : 'NOT VISIBLE after save',
    schedule: `daily ${HOUR}:${MINUTE} Asia/Kolkata`,
    target: 'POST ' + URL,
    header: 'x-wa-internal-key (value from catalyst-config.json, not logged)',
    crons: now
  };
};
