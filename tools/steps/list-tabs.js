'use strict';
/**
 * List the attached browser's tabs, and close leftover report windows.
 *
 * Useful because a step that leaves an `about:blank` print window open blocks the next
 * run: Chrome's print dialog is modal and every evaluate on that page hangs.
 *
 *   node tools/drive.js tools/steps/list-tabs.js [--close-blank]
 */
module.exports = async (page, args) => {
  const closeBlank = args.includes('--close-blank');
  const ctx = page.context();
  const out = [];
  for (const p of ctx.pages()) {
    const url = p.url();
    let title;
    try {
      title = await Promise.race([
        p.title(),
        new Promise((r) => setTimeout(() => r('<not responding>'), 3000))
      ]);
    } catch (e) {
      title = '<error: ' + String(e.message).slice(0, 40) + '>';
    }
    let closed = false;
    if (closeBlank && (url === 'about:blank' || title === '<not responding>')) {
      await p.close({ runBeforeUnload: false }).catch(() => {});
      closed = true;
    }
    out.push({ url: url.slice(0, 90), title, closed });
  }
  return out;
};
