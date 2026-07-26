'use strict';
/** Visit analytics views after switching the demo role via the sidebar select. */
module.exports = async (page, args) => {
  const role = args[0] || 'supervisor';
  const views = args.slice(1);
  const out = {};
  await page.goto('https://ksp.cyberkunju.com/app/#/analytics', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(12000);
  // The role lives in React state (no persistence), so it must be set through the control.
  const sel = page.locator('.sidenav-role select, .sidenav-role [role=combobox]').first();
  if (await sel.count()) {
    try { await sel.selectOption(role); } catch (_) {
      await sel.click(); await page.waitForTimeout(700);
      await page.locator(`li:has-text("${role}"), [role=option]:has-text("${role}")`).first().click();
    }
    await page.waitForTimeout(6000);
  }
  for (const v of views) {
    const tabLabel = { map: 'Hotspot Map', money: 'Money Trail', network: 'Criminal Networks', offenders: 'Offenders & Finance' }[v] || v;
    const tab = page.locator(`text=${tabLabel}`).first();
    if (await tab.count()) { await tab.click(); await page.waitForTimeout(22000); }
    out[v] = await page.evaluate(() => {
      const txt = document.body.innerText;
      return {
        mapShapes: document.querySelectorAll('.leaflet-overlay-pane path').length,
        canvases: document.querySelectorAll('.ng-canvas').length,
        noData: (txt.match(/No data|could not be loaded/gi) || []).length,
        hubRowsSample: (txt.match(/Review/g) || []).length,
        bodyH: document.body.scrollHeight,
      };
    });
  }
  return { role, ...out };
};
