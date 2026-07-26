'use strict';
module.exports = async (page, args) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await page.goto(`https://ksp.cyberkunju.com/app/?cb=${Date.now()}#/${args[0] || 'early-warning'}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(13000);
  const sel = page.locator('.sidenav-role select, .sidenav-role [role=combobox]').first();
  if (await sel.count()) { try { await sel.selectOption(args[1] || 'supervisor'); } catch (_) {} }
  await page.waitForTimeout(26000);
  return page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      if (el.children.length === 0 && /No data/i.test(el.textContent || '')) {
        let card = el, title = '';
        for (let i = 0; i < 8 && card; i++, card = card.parentElement) {
          const h = card.querySelector('h1,h2,h3,h4,[class*=card-title],[class*=viz]');
          if (h && h.innerText.trim()) { title = h.innerText.trim().slice(0, 70); break; }
        }
        out.push(title || '(unknown card)');
      }
    }
    return [...new Set(out)];
  });
};
