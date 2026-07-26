'use strict';
/**
 * Create a Data Store table. Idempotent — an existing table is reported and skipped.
 *
 *   node tools/drive.js tools/steps/create-table.js Forecasts
 */
const { openTable, BASE } = require('./table-columns');

async function tableNames(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('#ds_table_lst span.dt_tablename'))
    .map((s) => s.textContent.trim()));
}

module.exports = async (page, args) => {
  const names = args.filter(Boolean);
  if (!names.length) throw new Error('usage: create-table.js <Name> [...]');

  // openTable also resets the route, which is what guarantees a clean dialog state.
  await openTable(page, 'Cases');
  const existing = await tableNames(page);
  const out = [];

  for (const name of names) {
    if (existing.includes(name)) {
      out.push({ table: name, status: 'already present' });
      continue;
    }
    await page.locator('[data-zcqa="ds_create_newTable"]').first().click();
    await page.waitForTimeout(2000);
    const input = page.locator('[data-zcqa="common_inp_Table Name"]').first();
    await input.waitFor({ state: 'visible' });
    await input.fill(name);
    await page.locator('[data-zcqa="common_create_save"]').first().click();
    await page.waitForTimeout(6000);

    // Verify from the refreshed list rather than trusting the click.
    await page.goto(`${BASE}#/cloudscale/datastore/tables`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(8000);
    const now = await tableNames(page);
    out.push({ table: name, status: now.includes(name) ? 'created' : 'NOT VISIBLE after create' });
  }

  return { results: out, tables: await tableNames(page) };
};
