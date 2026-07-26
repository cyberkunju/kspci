'use strict';
/** Open each Analytics tab plus Early Warning and report what rendered. */
const TABS = ['Overview', 'Criminal Networks', 'Hotspot Map', 'Sociological Insights', 'Money Trail', 'Offenders & Finance'];
module.exports = async (page) => {
  const out = {};
  await page.goto('https://ksp.cyberkunju.com/app/#/analytics', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch (_) {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(18000);
  for (const t of TABS) {
    const tab = page.locator(`text=${t}`).first();
    if (await tab.count()) { await tab.click(); await page.waitForTimeout(20000); }
    out[t] = await page.evaluate(() => ({
      mapShapes: document.querySelectorAll('.leaflet-overlay-pane path').length,
      graph: !!document.querySelector('.ng-canvas'),
      tableRows: document.querySelectorAll('tbody tr, [role=row]').length,
      noData: (document.body.innerText.match(/No data|could not be loaded/gi) || []).length,
    }));
  }
  return out;
};
