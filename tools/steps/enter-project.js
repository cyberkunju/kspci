'use strict';
/** Enter Project-Rainfall from the console home and report the navigation available. */
module.exports = async (page) => {
  await page.goto('https://console.catalyst.zoho.in/baas/index', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(7000);

  // Click the card for the project rather than guessing a URL — the console's route shape
  // includes ids that are not derivable from the project id alone.
  const card = page.locator('text=Project-Rainfall').first();
  if (await card.count()) {
    await card.click();
    await page.waitForTimeout(9000);
  }
  await page.screenshot({ path: '/tmp/proj.png' });

  const links = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]'))
    .map((a) => `${(a.innerText || '').trim().slice(0, 40)} :: ${a.getAttribute('href')}`)
    .filter((s) => s.length > 4).slice(0, 80));
  const text = (await page.locator('body').innerText().catch(() => '')).replace(/\n{2,}/g, '\n');
  return { url: page.url(), text: text.slice(0, 900), links };
};
