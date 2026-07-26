'use strict';
/** Visit each analytics view by URL and report rendered content. */
const VIEWS = ['overview', 'network', 'hotspots', 'sociology', 'money', 'offenders'];
module.exports = async (page, args) => {
  const out = {};
  const ids = args.length ? args : VIEWS;
  for (const v of ids) {
    const url = v === 'overview'
      ? 'https://ksp.cyberkunju.com/app/#/analytics'
      : `https://ksp.cyberkunju.com/app/#/analytics?view=${v}`;
    await page.goto('https://ksp.cyberkunju.com/app/#/', { waitUntil: 'domcontentloaded' });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(22000);
    out[v] = await page.evaluate(() => {
      const txt = document.body.innerText;
      return {
        mapShapes: document.querySelectorAll('.leaflet-overlay-pane path').length,
        graph: document.querySelectorAll('canvas').length,
        rows: document.querySelectorAll('[class*=row], tbody tr').length,
        noData: (txt.match(/No data|could not be loaded|No offenders/gi) || []).length,
        svg: document.querySelectorAll('svg').length,
      };
    });
  }
  return out;
};
