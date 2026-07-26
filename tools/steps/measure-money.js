'use strict';
/** Measure the money-trail graph container over time to confirm/refute unbounded growth. */
module.exports = async (page) => {
  await page.goto('https://ksp.cyberkunju.com/app/#/analytics?view=money', { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(16000);
  const tab = page.locator('text=Money Trail').first();
  if (await tab.count()) { await tab.click(); await page.waitForTimeout(14000); }
  const samples = [];
  for (let i = 0; i < 6; i++) {
    samples.push(await page.evaluate(() => {
      const w = document.querySelector('.ng-wrap');
      const c = document.querySelector('.ng-canvas');
      return {
        wrap: w ? [Math.round(w.clientWidth), Math.round(w.clientHeight)] : null,
        canvasAttr: c ? [c.width, c.height] : null,
        body: Math.round(document.body.scrollHeight),
      };
    }));
    await page.waitForTimeout(4000);
  }
  await page.screenshot({ path: '/tmp/money.png', fullPage: true });
  return samples;
};
