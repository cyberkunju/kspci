'use strict';
/** Open the New Column dialog and list its data-zcqa hooks (stable console test attributes). */
const { openTable } = require('./table-columns');

module.exports = async (page, args) => {
  await openTable(page, args[0] || 'Cases');
  await page.locator('text=New Column').first().click();
  await page.waitForTimeout(3000);
  await page.screenshot({ path: '/tmp/newcol.png' });
  return page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    return Array.from(document.querySelectorAll('[data-zcqa]')).filter(vis).map((el) => ({
      zcqa: el.getAttribute('data-zcqa'),
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.value || '').trim().slice(0, 30) || null,
      options: el.tagName === 'SELECT' ? Array.from(el.options).map((o) => o.value) : undefined,
    }));
  });
};
