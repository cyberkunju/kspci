'use strict';
/** Load each app view and report what rendered. Cache cleared: a stale bundle has repeatedly
 *  looked like "no change" during this work. */
const VIEWS = ['early-warning', 'analytics'];
module.exports = async (page) => {
  const out = {};
  for (const v of VIEWS) {
    await page.goto(`https://ksp.cyberkunju.com/app/#/${v}`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch (_) {} });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(24000);
    await page.screenshot({ path: `/tmp/view-${v}.png`, fullPage: true });
    out[v] = await page.evaluate(() => ({
      mapShapes: document.querySelectorAll('.leaflet-overlay-pane path').length,
      svgCharts: document.querySelectorAll('svg').length,
      errors: (document.body.innerText.match(/failed|error/gi) || []).length,
      numbers: (document.body.innerText.match(/\b\d{2,3},\d{3}\b/g) || []).slice(0, 4),
    }));
  }
  return out;
};
