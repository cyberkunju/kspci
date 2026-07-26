'use strict';
/** Cache-busted check of the hotspot map level control. Catalyst CDN caches the bundle, and a
 *  stale bundle has repeatedly looked like an unfixed bug during this work. */
module.exports = async (page, args) => {
  const role = args[0] || 'supervisor';
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await page.goto(`https://ksp.cyberkunju.com/app/?cb=${Date.now()}#/analytics`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(14000);
  const sel = page.locator('.sidenav-role select, .sidenav-role [role=combobox]').first();
  if (await sel.count()) { try { await sel.selectOption(role); } catch (_) {} await page.waitForTimeout(5000); }
  const tab = page.locator('text=Hotspot Map').first();
  if (await tab.count()) { await tab.click(); await page.waitForTimeout(28000); }
  return page.evaluate(() => ({
    mapShapes: document.querySelectorAll('.leaflet-overlay-pane path').length,
    levelControl: /District detail|State \/ UT roll-up/.test(document.body.innerText),
    caption: (document.body.innerText.match(/\d+ (districts|states & UTs)/) || [''])[0],
    title: (document.body.innerText.match(/Crime hotspots across \w+/) || [''])[0],
  }));
};
