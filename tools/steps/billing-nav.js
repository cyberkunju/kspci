'use strict';
/** Open a billing sub-page (Overview / Report / Budget) from the account settings. */
const ENV = process.env.CATALYST_ENV_ID || '60079622152';
module.exports = async (page, args) => {
  await page.goto(`https://console.catalyst.zoho.in/baas/${ENV}/index#/settings/billings/breakdown`,
    { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(9000);
  const t = page.locator(`text=${args[0]}`).first();
  if (await t.count()) { await t.click(); await page.waitForTimeout(11000); }
  await page.screenshot({ path: `/tmp/billing-${args[0]}.png`, fullPage: true });
  const text = (await page.locator('body').innerText().catch(() => '')).replace(/\n{2,}/g, '\n');
  const i = text.indexOf('Manage Billing');
  return { url: page.url(), text: (i > 0 ? text.slice(i) : text).slice(0, 1800) };
};
