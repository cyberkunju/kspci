'use strict';
/**
 * Add columns to a Data Store table. Idempotent — an existing column is reported and skipped.
 *
 *   node tools/drive.js tools/steps/add-column.js Cases StateName:text TalukName:text
 *
 * The console exposes stable data-zcqa hooks (ds_col_name, ds_col_type, ds_col_create), which
 * are what this drives rather than CSS classes that change with a UI release.
 */
const { openTable, columns } = require('./table-columns');

const TYPE_LABEL = {
  text: 'Text', varchar: 'Var Char', date: 'Date', datetime: 'DateTime',
  int: 'Int', double: 'Double', boolean: 'Boolean', bigint: 'BigInt',
};

async function addOne(page, name, type) {
  await page.locator('[data-zcqa="ds_schema_newCol"]').first().click();
  await page.waitForTimeout(1500);

  const input = page.locator('[data-zcqa="ds_col_name"]').first();
  await input.waitFor({ state: 'visible' });
  await input.fill(name);

  // The type control is a styled wrapper over a native select. Setting the select directly and
  // firing change is more reliable than driving the custom dropdown, but it only counts if the
  // wrapper's label actually updates — so that is verified rather than assumed.
  const holder = page.locator('[data-zcqa="ds_col_type"]').first();
  const native = holder.locator('select').first();
  let typeSet = false;
  if (await native.count()) {
    try {
      await native.selectOption(type, { force: true });
      typeSet = true;
    } catch (_) { typeSet = false; }
  }
  if (!typeSet) {
    await holder.click();
    await page.waitForTimeout(800);
    await page.locator('li, .select2-results__option, option')
      .filter({ hasText: new RegExp(`^${TYPE_LABEL[type] || type}$`, 'i') }).first().click();
  }
  await page.waitForTimeout(600);
  const shown = (await holder.innerText().catch(() => '')).trim();

  await page.locator('[data-zcqa="ds_col_create"]').first().click();
  await page.waitForTimeout(4000);
  return shown;
}

module.exports = async (page, args) => {
  const table = args[0];
  const specs = args.slice(1).map((s) => {
    const [n, t = 'text'] = s.split(':');
    return { name: n, type: t };
  });
  if (!table || !specs.length) throw new Error('usage: add-column.js <Table> Name:type [...]');

  await openTable(page, table);
  const before = (await columns(page)).map((c) => c.name);
  const results = [];

  for (const s of specs) {
    if (before.includes(s.name)) {
      results.push({ column: s.name, status: 'already present' });
      continue;
    }
    let shown;
    try {
      shown = await addOne(page, s.name, s.type);
    } catch (e) {
      results.push({ column: s.name, status: 'FAILED', error: e.message.slice(0, 160) });
      // Leave the form closed so the next column starts from a clean state.
      await page.locator('[data-zcqa="ds_col_createCancel"]').first().click().catch(() => {});
      continue;
    }
    // Verify against the rendered schema rather than trusting the click.
    const now = await columns(page);
    const hit = now.find((c) => c.name === s.name);
    results.push({
      column: s.name, wanted: s.type, typeWidgetShowed: shown,
      status: hit ? 'created' : 'NOT VISIBLE after create', actualType: hit && hit.type,
    });
  }

  const after = await columns(page);
  await page.screenshot({ path: `/tmp/cols-${table}.png` });
  return { table, results, columnCount: after.length, columns: after.map((c) => `${c.name}:${c.type}`) };
};
