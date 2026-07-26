'use strict';
/** Locate the console's usage/subscription page and read the credit figures. */
const ENV = process.env.CATALYST_ENV_ID || '60079622152';

module.exports = async (page, args) => {
  const url = args[0] || `https://console.catalyst.zoho.in/baas/${ENV}/index`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(11000);
  await page.screenshot({ path: '/tmp/home.png', fullPage: true });

  const nav = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('a,button,[data-zcqa],[title],[class*=user],[class*=avatar],[class*=profile]')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      out.push([
        el.tagName.toLowerCase(),
        (el.getAttribute('data-zcqa') || el.getAttribute('title') || el.id || '').slice(0, 40),
        (el.getAttribute('href') || '').slice(0, 70),
        (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 30),
      ].join(' | '));
    }
    return [...new Set(out)];
  });
  return { url: page.url(), nav: nav.slice(0, 70) };
};
