'use strict';
/** Open Analytics > Hotspot Map and count rendered district circles. */
module.exports = async (page) => {
  await page.goto('https://ksp.cyberkunju.com/app/#/analytics', { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(18000);
  const tab = page.locator('text=Hotspot Map').first();
  if (await tab.count()) { await tab.click(); await page.waitForTimeout(26000); }
  await page.screenshot({ path: '/tmp/hotspot-tab.png', fullPage: true });
  return page.evaluate(() => ({
    mapShapes: document.querySelectorAll('.leaflet-overlay-pane path').length,
    tiles: document.querySelectorAll('.leaflet-tile').length,
    errors: (document.body.innerText.match(/could not be loaded/gi) || []).length,
  }));
};
