'use strict';
/** Open the project's Data Store table list and report the tables it contains. */
const PROJECT = process.env.CATALYST_PROJECT_ID || '51589000000013024';
const ENV = process.env.CATALYST_ENV_ID || '60079622152';
const BASE = `https://console.catalyst.zoho.in/baas/${ENV}/project/${PROJECT}/Development`;

module.exports = async (page) => {
  await page.goto(`${BASE}#/cloudscale/datastore/tables`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(10000);
  await page.screenshot({ path: '/tmp/ds.png' });
  const text = (await page.locator('body').innerText().catch(() => '')).replace(/\n{2,}/g, '\n');
  return { url: page.url(), text: text.slice(0, 2000) };
};
