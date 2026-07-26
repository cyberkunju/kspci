'use strict';
/** Open a column's options menu and list what it offers. */
const { openTable } = require('./table-columns');

module.exports = async (page, args) => {
  const [table, column] = [args[0] || 'Cases', args[1] || 'StateName'];
  await openTable(page, table);
  await page.locator(`[data-zcqa="colOptions_${column}"]`).first().click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: '/tmp/colopts.png' });
  return page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    // Whatever the options button opened: collect small clickable items that appeared, since the
    // menu markup is not labelled with data-zcqa hooks.
    const items = Array.from(document.querySelectorAll('li,a,button,span,div'))
      .filter(vis)
      .filter((el) => el.children.length === 0)
      .map((el) => (el.innerText || '').trim())
      .filter((t) => t && t.length < 40);
    return [...new Set(items)].slice(-40);
  });
};
