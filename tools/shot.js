'use strict';
/** Screenshot + visible text of the CDP-attached page. Diagnostics for the console driver. */
const { chromium } = require('playwright-core');

(async () => {
  const b = await chromium.connectOverCDP(process.env.CDP_URL || 'http://127.0.0.1:9222');
  const ctx = b.contexts()[0];
  const pages = ctx.pages();
  const p = pages[pages.length - 1];
  console.log('pages:', pages.length);
  console.log('url  :', p.url());
  console.log('title:', await p.title());
  await p.screenshot({ path: process.argv[2] || '/tmp/shot.png' });
  const txt = await p.locator('body').innerText().catch(() => '');
  console.log('--- text ---\n' + txt.replace(/\n{2,}/g, '\n').slice(0, 1200));
  await b.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
