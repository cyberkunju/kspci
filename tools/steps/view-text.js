'use strict';
module.exports = async (page, args) => {
  await page.goto(`https://ksp.cyberkunju.com/app/#/${args[0] || 'analytics'}`, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(25000);
  await page.screenshot({ path: '/tmp/v.png', fullPage: true });
  const logs = [];
  return {
    text: (await page.locator('body').innerText()).replace(/\n{2,}/g, '\n').slice(0, 1500),
  };
};
