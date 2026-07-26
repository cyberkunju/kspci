'use strict';
/** Load the live app's Early Warning view and count rendered forecast circles.
 *  Cache is cleared first: a stale bundle or cached API response has repeatedly looked like
 *  "no change" during this work. */
module.exports = async (page) => {
  const ctx = page.context();
  await ctx.clearCookies().catch(() => {});
  await page.goto('https://ksp.cyberkunju.com/app/#/early-warning', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch (_) {} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(22000);
  await page.screenshot({ path: '/tmp/app-ew.png' });
  return page.evaluate(() => ({
    circles: document.querySelectorAll('.leaflet-overlay-pane path').length,
    header: (document.body.innerText.match(/Statewide[^\n]*/) || [''])[0].slice(0, 60),
    alerts: (document.body.innerText.match(/\d+ critical/) || [''])[0],
    sample: (document.body.innerText.match(/predicted [\d.]+ +baseline [\d.]+/) || [''])[0],
  }));
};
