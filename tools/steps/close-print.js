'use strict';
/**
 * Close any print-preview tab left behind by a PDF export.
 *
 * Chrome's print preview is modal from the page's point of view, so one left open makes
 * every later CDP step time out on an unrelated page. Run this between UI checks.
 *
 *   node tools/drive.js tools/steps/close-print.js
 */
module.exports = async (page) => {
  const closed = [];
  for (const p of page.context().pages()) {
    const url = p.url();
    if (url.startsWith('chrome://print') || url === 'about:blank') {
      closed.push(url);
      await p.close({ runBeforeUnload: false }).catch(() => {});
    }
  }
  return { closed };
};
