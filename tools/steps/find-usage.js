'use strict';
/** Locate the console's usage/subscription page by scanning navigation links. */
const ENV = process.env.CATALYST_ENV_ID || '60079622152';

module.exports = async (page) => {
  await page.goto(`https://console.catalyst.zoho.in/baas/${ENV}/index`, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(10000);
  await page.screenshot({ path: '/tmp/home.png', fullPage: true });
  const links = await page.evaluate(() => Array.from(document.querySelectorAll('a[href],[data-zcqa]'))
    .map((a) => `${(a.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 30)} :: ${a.getAttribute('href') || a.getAttribute('data-zcqa')}`)
    .filter((s) => /usage|credit|subscri|billing|plan|payment|consum/i.test(s)));
  const text = (await page.locator('body').innerText().catch(() => '')).replace(/\n{2,}/g, '\n');
  return { url: page.url(), matches: links, text: text.slice(0, 1200) };
};
