'use strict';
/**
 * Read the console's billing breakdown: plan, free credit, usage and per-component drivers.
 *
 * Reached by clicking the banner's own "View breakdown" link — the #/settings/billings/... route
 * only resolves from the account index, not from inside a project.
 */
const ENV = process.env.CATALYST_ENV_ID || '60079622152';

module.exports = async (page, args) => {
  await page.goto(`https://console.catalyst.zoho.in/baas/${ENV}/index`, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(9000);

  const link = page.locator('text=View breakdown').first();
  if (await link.count()) {
    await link.click();
    await page.waitForTimeout(12000);
  }

  // The view switcher is a native <select> behind a styled wrapper, so it is set directly
  // rather than clicked — the visible element is not the option.
  const tab = args[0];
  if (tab) {
    const sel = page.locator('select').filter({ hasText: tab }).first();
    if (await sel.count()) {
      await sel.selectOption({ label: tab }, { force: true });
      await page.waitForTimeout(12000);
    }
  }

  await page.screenshot({ path: '/tmp/billing.png', fullPage: true });
  const text = (await page.locator('body').innerText().catch(() => '')).replace(/\n{2,}/g, '\n');
  const i = text.indexOf('Breakdown\n');
  return { url: page.url(), text: (i > 0 ? text.slice(i) : text).slice(0, 3000) };
};
