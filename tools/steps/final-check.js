'use strict';
/** Cache-busted sweep of every view as a given role. */
const TABS = { overview: 'Overview', network: 'Criminal Networks', map: 'Hotspot Map',
  sociology: 'Sociological Insights', money: 'Money Trail', offenders: 'Offenders & Finance' };

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Switch the working access context.
 *
 * The control is an Astryx `Selector`, not a native `<select>`, so `selectOption`
 * silently does nothing and the whole sweep runs as the default role — which made a
 * correct RBAC refusal look like a broken panel. Throws rather than shrugging: a role
 * sweep that quietly checks the wrong role is worse than no sweep.
 */
async function setRole(page, role) {
  await page.locator('.sidenav-role').locator('input, [role="combobox"], button').first().click();
  await page.waitForTimeout(1500);
  await page.getByRole('option', { name: cap(role), exact: true }).first().click();
  await page.waitForTimeout(1500);
}

module.exports = async (page, args) => {
  const role = args[0] || 'admin';
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  const out = {};

  await page.goto(`https://ksp.cyberkunju.com/app/?cb=${Date.now()}#/early-warning`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(12000);
  await setRole(page, role);
  await page.waitForTimeout(26000);
  out['early-warning'] = await page.evaluate(() => {
    const t = document.body.innerText;
    return { circles: document.querySelectorAll('.leaflet-overlay-pane path').length,
      noData: (t.match(/No data/gi) || []).length,
      restricted: /Restricted for this access context/.test(t),
      modelTable: /ENSEMBLE \(NNLS stacked\)/.test(t),
      chart: document.querySelectorAll('canvas').length };
  });

  await page.goto(`https://ksp.cyberkunju.com/app/?cb=${Date.now()}#/analytics`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(12000);
  await setRole(page, role);
  await page.waitForTimeout(8000);
  for (const [id, label] of Object.entries(TABS)) {
    const tab = page.locator(`text=${label}`).first();
    if (await tab.count()) { await tab.click(); await page.waitForTimeout(22000); }
    out[id] = await page.evaluate(() => {
      const t = document.body.innerText;
      return { circles: document.querySelectorAll('.leaflet-overlay-pane path').length,
        noData: (t.match(/No data/gi) || []).length,
        failed: /could not be loaded/i.test(t),
        rows: (t.match(/High|Review/g) || []).length };
    });
  }
  return { role, ...out };
};
