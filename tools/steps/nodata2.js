'use strict';
module.exports = async (page, args) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await page.goto(`https://ksp.cyberkunju.com/app/?cb=${Date.now()}#/${args[0] || 'early-warning'}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(13000);
  const sel = page.locator('.sidenav-role select, .sidenav-role [role=combobox]').first();
  if (await sel.count()) { try { await sel.selectOption(args[1] || 'supervisor'); } catch (_) {} }
  await page.waitForTimeout(26000);
  const txt = await page.locator('body').innerText();
  const i = txt.indexOf('No data');
  return { context: txt.slice(Math.max(0, i - 320), i + 120).replace(/\n{2,}/g, '\n') };
};
