'use strict';
/** Report the project's resource usage / subscription state from the console. */
const PROJECT = process.env.CATALYST_PROJECT_ID || '51589000000013024';
const ENV = process.env.CATALYST_ENV_ID || '60079622152';
const BASE = `https://console.catalyst.zoho.in/baas/${ENV}/project/${PROJECT}/Development`;

module.exports = async (page, args) => {
  const route = args[0] || '#/devops/usage';
  await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(11000);
  await page.screenshot({ path: '/tmp/usage.png', fullPage: true });
  const text = (await page.locator('body').innerText().catch(() => '')).replace(/\n{2,}/g, '\n');
  return { url: page.url(), text: text.slice(0, 3000) };
};
