'use strict';
/** Report the columns of a table. Usage: drive.js tools/steps/table-columns.js Cases */
const PROJECT = process.env.CATALYST_PROJECT_ID || '51589000000013024';
const ENV = process.env.CATALYST_ENV_ID || '60079622152';
const BASE = `https://console.catalyst.zoho.in/baas/${ENV}/project/${PROJECT}/Development`;

async function openTable(page, name) {
  // Always reload the tables route. A previous step may have left an inline editor open, and
  // that overlay silently blocks clicks on the table list — which surfaces as a click timeout
  // on an element the log says it resolved, not as anything that points at the real cause.
  await page.goto(`${BASE}#/cloudscale/datastore/tables`, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(9000);
  // The list renders each table as span.dt_tablename inside #ds_table_lst. Matching exact text
  // matters: 'Accused' is a substring of 'CoAccusedLinks', so a loose match opens the wrong
  // table and every subsequent step would edit the wrong schema.
  const item = page.locator('#ds_table_lst span.dt_tablename', { hasText: new RegExp(`^${name}$`) }).first();
  await item.waitFor({ state: 'visible' });
  await item.click();
  await page.waitForTimeout(6000);
}

async function columns(page) {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('tr'));
    return rows.map((r) => Array.from(r.querySelectorAll('td')).map((c) => c.innerText.trim()))
      .filter((c) => c.length >= 3 && /^\d+$/.test(c[0]))
      .map((c) => ({ id: c[0], name: c[1], type: c[2] }));
  });
}

module.exports = async (page, args) => {
  const name = args[0] || 'Cases';
  await openTable(page, name);
  const cols = await columns(page);
  await page.screenshot({ path: `/tmp/table-${name}.png` });
  return { table: name, url: page.url(), count: cols.length, columns: cols.map((c) => `${c.name}:${c.type}`) };
};

module.exports.openTable = openTable;
module.exports.columns = columns;
module.exports.BASE = BASE;
