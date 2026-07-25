'use strict';
/**
 * Run a step against the CDP-attached Catalyst console page.
 *
 * The console has no CLI for Data Store schema changes, so the migration goes through the
 * browser. Steps are separate files rather than one long script because a half-applied schema
 * change has to be resumable: each step is idempotent and reports what it found.
 *
 *   node tools/drive.js tools/steps/<name>.js [args...]
 *
 * Each step file exports `async (page, args) => ...`.
 */
const path = require('path');
const { chromium } = require('playwright-core');

(async () => {
  const stepFile = process.argv[2];
  if (!stepFile) throw new Error('usage: drive.js <step.js> [args...]');
  const step = require(path.resolve(stepFile));

  const browser = await chromium.connectOverCDP(process.env.CDP_URL || 'http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const pages = ctx.pages();
  const page = pages[pages.length - 1] || (await ctx.newPage());
  page.setDefaultTimeout(45000);
  try {
    const out = await step(page, process.argv.slice(3));
    if (out !== undefined) console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 1));
  } finally {
    // Detach only. Closing would kill the browser the operator is watching.
    await browser.close();
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
