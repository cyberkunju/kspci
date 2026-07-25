'use strict';
/** Open the New Table dialog and dump its visible form controls. */
const { openTable } = require('./table-columns');

module.exports = async (page) => {
  await openTable(page, 'Cases');
  await page.locator('[data-zcqa="ds_create_newTable"]').first().click();
  await page.waitForTimeout(3500);
  await page.screenshot({ path: '/tmp/newtable.png' });
  return page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    return {
      inputs: Array.from(document.querySelectorAll('input,select,textarea')).filter(vis).map((el) => ({
        tag: el.tagName.toLowerCase(), id: el.id || null, zcqa: el.getAttribute('data-zcqa'),
        type: el.type, placeholder: el.placeholder || null,
        dataKey: el.getAttribute('data-key'),
      })),
      buttons: Array.from(document.querySelectorAll('button,a.btn')).filter(vis)
        .map((b) => `${b.id || ''}|${b.getAttribute('data-zcqa') || ''}|${(b.innerText || '').trim().slice(0, 22)}`),
      headings: Array.from(document.querySelectorAll('h1,h2,h3,h4,.popupHeader,.modal-title'))
        .filter(vis).map((h) => h.innerText.trim().slice(0, 50)),
    };
  });
};
