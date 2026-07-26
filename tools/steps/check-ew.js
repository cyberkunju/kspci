'use strict';
/** Cache-busted check of the Early Warning view's cards. */
module.exports = async (page, args) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await page.goto(`https://ksp.cyberkunju.com/app/?cb=${Date.now()}#/early-warning`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(14000);
  const sel = page.locator('.sidenav-role select, .sidenav-role [role=combobox]').first();
  if (await sel.count()) { try { await sel.selectOption(args[0] || 'supervisor'); } catch (_) {} }
  await page.waitForTimeout(26000);
  return page.evaluate(() => {
    const txt = document.body.innerText;
    return {
      mapCircles: document.querySelectorAll('.leaflet-overlay-pane path').length,
      header: (txt.match(/National total: [\d,]+ across \d+ districts/) || [''])[0],
      noData: (txt.match(/No data/gi) || []).length,
      roleGated: /available to the Analyst role/.test(txt),
      modelRows: (txt.match(/ENSEMBLE \(NNLS stacked\)|Historical pattern \(police baseline\)/g) || []).length,
      backtestChart: document.querySelectorAll('canvas').length,
      alerts: (txt.match(/\d+ critical/) || [''])[0],
    };
  });
};
