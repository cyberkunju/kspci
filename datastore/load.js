'use strict';

/**
 * Orchestrates seeding the Data Store via the deployed admin endpoint.
 * The loader parses each CSV LOCALLY and streams row batches to POST /admin/insert,
 * so the function never re-parses large files server-side (scales to any size).
 *
 * Prereq: the 10 tables exist in the Catalyst console (see SCHEMA.md), and the
 * `api` function is deployed with ADMIN_KEY set.
 *
 * Usage:
 *   node datastore/load.js
 *   node datastore/load.js --only Cases,Accused
 */

const fs = require('fs');
const path = require('path');
const { parseCsv } = require('../functions/api/lib/csv');

const BASE = process.env.KSP_API
  || 'https://project-rainfall-60079622152.development.catalystserverless.in/server/api';
const ADMIN_KEY = process.env.ADMIN_KEY || 'ksp-2026-seed-9f3ab7c1d84e';
const BATCH = Number(process.env.BATCH || 200);
const SEED_DIR = path.join(__dirname, 'seed');
const TABLES = ['Cases', 'Accused', 'Victims', 'Complainants', 'Arrests', 'CoAccusedLinks', 'OffenderRisk', 'FinancialTxns'];

const onlyArg = (() => {
  const i = process.argv.indexOf('--only');
  return i > -1 ? process.argv[i + 1].split(',') : null;
})();

async function insert(table, rows) {
  const r = await fetch(`${BASE}/admin/insert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ table, rows })
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
}

(async () => {
  console.log(`Seeding via ${BASE}  (batch=${BATCH})`);
  let tables = TABLES;
  if (onlyArg) tables = tables.filter((t) => onlyArg.includes(t));

  for (const table of tables) {
    const file = path.join(SEED_DIR, table + '.csv');
    if (!fs.existsSync(file)) { console.log(`- ${table}: no CSV, skipping`); continue; }
    const all = parseCsv(fs.readFileSync(file, 'utf8'));
    if (!all.length) { console.log(`- ${table}: 0 rows`); continue; }
    let inserted = 0;
    for (let off = 0; off < all.length; off += BATCH) {
      const res = await insert(table, all.slice(off, off + BATCH));
      inserted += res.inserted;
      process.stdout.write(`\r- ${table}: ${inserted}/${all.length}   `);
    }
    console.log(`\r- ${table}: ${inserted}/${all.length}  done`);
  }
  console.log('\nAll tables seeded.');
})().catch((e) => { console.error('\nLoad failed:', e.message); process.exit(1); });
