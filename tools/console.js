'use strict';
/**
 * Catalyst console driver.
 *
 * The console has no CLI for Data Store schema changes, and neither browser MCP works here: the
 * Playwright server runs an unauthenticated profile, and the Chrome DevTools server needs an X
 * server this machine lacks. So: a headless Chrome started with --remote-debugging-port, the
 * real session cookies injected (they are session-scoped, so a fresh profile never loads them —
 * see tools/chrome-cookies.py), and Playwright attached over CDP.
 *
 *   google-chrome --headless=new --remote-debugging-port=9222 \
 *       --user-data-dir=/tmp/cprof --password-store=basic --no-first-run &
 *   python3 tools/chrome-cookies.py zoho /tmp/ck.db > /tmp/cookies.json
 *   node tools/console.js <url>
 */
const fs = require('fs');
const { chromium } = require('playwright-core');

const CDP = process.env.CDP_URL || 'http://127.0.0.1:9222';
const COOKIES = process.env.COOKIES_JSON || '/tmp/cookies.json';

async function open(url) {
  const browser = await chromium.connectOverCDP(CDP);
  const ctx = browser.contexts()[0] || (await browser.newContext());
  if (fs.existsSync(COOKIES)) {
    const raw = JSON.parse(fs.readFileSync(COOKIES, 'utf8'));
    // Domains are stored with a leading dot for host-wildcard cookies; Playwright wants either
    // a url or a domain, and passing the stored form through unchanged is what keeps
    // host-only cookies host-only.
    await ctx.addCookies(raw.map((c) => ({
      name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
      expires: c.expires && c.expires > 0 ? c.expires : -1,
      httpOnly: !!c.httpOnly, secure: !!c.secure, sameSite: c.sameSite || 'Lax',
    })));
  }
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);
  if (url) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  return { browser, ctx, page };
}

module.exports = { open };

if (require.main === module) {
  (async () => {
    const url = process.argv[2] || 'https://console.catalyst.zoho.in/';
    const { browser, page } = await open(url);
    await page.waitForTimeout(7000);
    console.log('url  :', page.url());
    console.log('title:', await page.title());
    console.log('signedIn:', !/accounts\.zoho\.in\/signin/.test(page.url()));
    await page.screenshot({ path: '/tmp/console.png' });
    console.log('shot : /tmp/console.png');
    await browser.close();
  })().catch((e) => { console.error('ERR', e.message); process.exit(1); });
}
