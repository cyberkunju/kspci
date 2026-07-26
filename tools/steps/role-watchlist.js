'use strict';
/** Switch the demo role through the Astryx selector (not a native select) and check the watchlist. */
module.exports = async (page, args) => {
  const label = args[0] || 'Analyst';
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await page.goto(`https://ksp.cyberkunju.com/app/?cb=${Date.now()}#/early-warning`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(14000);
  const combo = page.locator('.sidenav-role').locator('button, [role=combobox], select').first();
  await combo.click();
  await page.waitForTimeout(1200);
  const opt = page.locator(`[role=option]:has-text("${label}"), li:has-text("${label}")`).first();
  if (await opt.count()) await opt.click();
  await page.waitForTimeout(28000);
  const t = await page.locator('body').innerText();
  return {
    activeRole: (t.match(/Working access context\s*\n\s*(\w+)/) || [])[1] || null,
    restricted: /Restricted for this access context/.test(t),
    watchlistRows: (t.match(/\b(High|Medium|Low)\b/g) || []).length,
    circles: await page.evaluate(() => document.querySelectorAll('.leaflet-overlay-pane path').length),
  };
};
