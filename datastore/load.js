'use strict';

/**
 * Orchestrates seeding the Data Store via the deployed admin endpoint.
 *
 * The loader streams each CSV line by line and posts row batches to
 * POST /admin/insert, so the function never re-parses large files server-side and
 * the loader never holds a whole table in memory. This matters: Cases.csv is 852 MB
 * at 1.5M cases, well past the ~512 MB ceiling on a single JavaScript string, so
 * reading a table in one go throws ERR_STRING_TOO_LONG.
 *
 * Progress is checkpointed to datastore/seed/.load-state.json after every batch, so
 * an interrupted run resumes where it stopped instead of duplicating rows. A load at
 * full scale is tens of thousands of requests and will not always finish in one go.
 *
 * Prereq: the tables exist in the Catalyst console (see SCHEMA.md) with the current
 * column set, and the `api` function is deployed with ADMIN_KEY set.
 *
 * Usage:
 *   node datastore/load.js
 *   node datastore/load.js --only Cases,Accused
 *   node datastore/load.js --restart          # ignore the checkpoint and start over
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const BASE = process.env.KSP_API
  || 'https://project-rainfall-60079622152.development.catalystserverless.in/server/api';
const ADMIN_KEY = process.env.ADMIN_KEY || 'ksp-2026-seed-9f3ab7c1d84e';
const BATCH = Number(process.env.BATCH || 200);
// Concurrent in-flight batches. The ceiling is the deployed function's ability to absorb
// parallel inserts, not this machine; 8 was chosen by measurement and backs off on failure via
// insert()'s retry. Raise with CONCURRENCY= if the function scales further.
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY || 8));
const SEED_DIR = path.join(__dirname, 'seed');
const STATE_FILE = path.join(SEED_DIR, '.load-state.json');
const TABLES = ['Cases', 'Accused', 'Victims', 'Complainants', 'Arrests', 'CoAccusedLinks', 'OffenderRisk', 'FinancialTxns'];

const has = (f) => process.argv.includes('--' + f);
const onlyArg = (() => {
  const i = process.argv.indexOf('--only');
  return i > -1 ? process.argv[i + 1].split(',') : null;
})();

/** Split one CSV line, honouring quoted fields containing commas. */
function splitCsvLine(line) {
  const out = [];
  let field = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') { if (line[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(field); field = ''; }
    else field += c;
  }
  out.push(field);
  return out;
}

const loadState = () => {
  if (has('restart') || !fs.existsSync(STATE_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
};
const state = loadState();
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state));

async function insert(table, rows, attempt = 0) {
  try {
    const r = await fetch(`${BASE}/admin/insert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
      body: JSON.stringify({ table, rows }),
    });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 300)}`);
    return r.json();
  } catch (e) {
    // A load of this length will hit transient failures; retry with backoff rather
    // than losing tens of thousands of already-inserted rows.
    if (attempt >= 4) throw e;
    await new Promise((s) => setTimeout(s, 1500 * (attempt + 1) ** 2));
    return insert(table, rows, attempt + 1);
  }
}

async function loadTable(table, total = 0) {
  const file = path.join(SEED_DIR, table + '.csv');
  if (!fs.existsSync(file)) { console.log(`- ${table}: no CSV, skipping`); return; }

  const done = state[table] || 0;   // data rows already inserted
  let cols = null, index = 0, batch = [], inserted = done;
  const started = Date.now();

  const rl = readline.createInterface({
    input: fs.createReadStream(file, { highWaterMark: 1 << 20 }),
    crlfDelay: Infinity,
  });

  // Batches are posted concurrently. The load is tens of thousands of requests whose cost is
  // almost entirely the round trip, so one-at-a-time spends the whole run waiting: 8.2M rows at
  // 200 per call is ~41,000 sequential requests, hours of pure latency.
  //
  // The checkpoint is what makes this safe to parallelise. With requests in flight out of order,
  // the resume point may only advance to the last row index for which *every* earlier batch has
  // landed — otherwise an interruption would skip a gap and lose rows silently. So completed
  // batch offsets are tracked and the checkpoint moves only across a contiguous prefix.
  const inflight = new Map();       // startIndex -> promise
  const completed = new Set();      // startIndex values that have landed
  const sizes = new Map();          // startIndex -> row count
  let nextCheckpoint = done;

  const advance = () => {
    // Walk the contiguous run of finished batches from the current checkpoint.
    while (completed.has(nextCheckpoint)) {
      const n = sizes.get(nextCheckpoint);
      completed.delete(nextCheckpoint);
      sizes.delete(nextCheckpoint);
      nextCheckpoint += n;
    }
    state[table] = nextCheckpoint;
    saveState();
  };

  const post = (rows, startIndex) => {
    sizes.set(startIndex, rows.length);
    const p = insert(table, rows).then((res) => {
      inserted += res.inserted ?? rows.length;
      completed.add(startIndex);
      advance();
      const rate = inserted > done ? (inserted - done) / ((Date.now() - started) / 1000) : 0;
      const pct = total ? ` ${((inserted / total) * 100).toFixed(1)}%` : '';
      process.stdout.write(
        `\r- ${table}: ${inserted.toLocaleString('en-IN')}${pct}  (${rate.toFixed(0)} rows/s)      `);
    }).finally(() => inflight.delete(startIndex));
    inflight.set(startIndex, p);
    return p;
  };

  const drainTo = async (limit) => {
    while (inflight.size >= limit) await Promise.race(inflight.values());
  };

  let batchStart = done;
  for await (const line of rl) {
    if (!cols) { cols = splitCsvLine(line).map((c) => c.trim()); continue; }
    if (!line) continue;
    index++;
    if (index <= done) continue;          // already loaded in an earlier run
    const vals = splitCsvLine(line);
    const row = {};
    for (let i = 0; i < cols.length; i++) row[cols[i]] = vals[i] ?? '';
    batch.push(row);
    if (batch.length >= BATCH) {
      await drainTo(CONCURRENCY);
      post(batch, batchStart);
      batchStart = index;
      batch = [];
    }
  }
  if (batch.length) post(batch, batchStart);
  await Promise.all(inflight.values());
  advance();
  console.log(`\r- ${table}: ${inserted.toLocaleString('en-IN')} rows  done` + ' '.repeat(24));
}

(async () => {
  console.log(`Seeding via ${BASE}  (batch=${BATCH}, concurrency=${CONCURRENCY})`);
  if (Object.keys(state).length) {
    console.log(`Resuming from checkpoint: ${Object.entries(state).map(([t, n]) => `${t}=${n}`).join(', ')}`);
    console.log('Pass --restart to ignore it.');
  }
  const tables = onlyArg ? TABLES.filter((t) => onlyArg.includes(t)) : TABLES;
  for (const table of tables) {
    // Row count for the progress percentage, read from the file's line count minus the header.
    // Cheap enough once per table and the difference between a progress bar and a number that
    // means nothing on a multi-hour run.
    let total = 0;
    const f = path.join(SEED_DIR, table + '.csv');
    if (fs.existsSync(f)) {
      await new Promise((res) => {
        let n = 0;
        fs.createReadStream(f, { highWaterMark: 1 << 22 })
          .on('data', (c) => { for (let i = 0; i < c.length; i++) if (c[i] === 10) n++; })
          .on('end', () => { total = Math.max(0, n - 1); res(); })
          .on('error', () => res());
      });
    }
    await loadTable(table, total);
  }
  console.log('\nAll tables seeded.');
})().catch((e) => {
  console.error('\nLoad failed:', e.message);
  console.error('Progress is checkpointed — rerun the same command to resume.');
  process.exit(1);
});
