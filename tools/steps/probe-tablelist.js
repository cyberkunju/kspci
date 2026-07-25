'use strict';
/** Dump the DOM shape of the table list so the click target can be selected precisely. */
module.exports = async (page) => {
  return page.evaluate(() => {
    const hits = [];
    for (const el of document.querySelectorAll('*')) {
      const t = (el.textContent || '').trim();
      if (t === 'Cases' && el.children.length === 0) {
        const path = [];
        let n = el;
        for (let i = 0; i < 5 && n; i++, n = n.parentElement) {
          path.push(`${n.tagName.toLowerCase()}${n.id ? '#' + n.id : ''}${n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\s+/).slice(0, 3).join('.') : ''}`);
        }
        hits.push(path.join(' < '));
      }
    }
    return { matches: hits.slice(0, 6) };
  });
};
