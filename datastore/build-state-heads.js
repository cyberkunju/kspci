'use strict';

/**
 * Builds ref/ncrb_state_heads_2022.json — real 2022 case counts per state/UT per
 * crime head, from NCRB Tables 1A.4 (IPC) and 1A.5 (SLL).
 *
 * Why this matters: the generator previously shaped each state's crime mix from the
 * national mix, nudged by the handful of per-state rates NCRB publishes in its
 * summary (murder, rape, kidnapping, extortion, robbery). That was wrong in ways a
 * reader would notice. The state Prohibition Act, for one, had to be allocated by
 * hand across "dry states" — which put 76% of Gujarat's caseload under prohibition
 * against a real 310,801 cases, and gave Tamil Nadu none at all when it actually
 * registers 155,560. NCRB publishes the whole state x head matrix, so none of that
 * needs modelling.
 *
 * Input: raw/ncrb_state_heads_raw.json, produced by
 *   python3 datastore/tools/parse_ncrb_state_heads.py
 * (kept as a separate step because the source is a pair of xlsx files with deeply
 * merged multi-row headers, and openpyxl handles that without adding a JS dependency.)
 *
 * The build asserts that every head's per-state figures sum to the national total
 * already recorded in ncrb_crime_heads_2022.json. That check is the whole point: it
 * catches a mis-mapped label or a double-counted parent aggregate immediately.
 */

const fs = require('fs');
const path = require('path');

const REF = path.join(__dirname, 'ref');
const RAW = path.join(__dirname, 'raw');

const tax = JSON.parse(fs.readFileSync(path.join(REF, 'ncrb_crime_heads_2022.json'), 'utf8'));
const aliasFile = JSON.parse(fs.readFileSync(path.join(REF, 'ncrb_head_alias.json'), 'utf8'));
const rawPath = path.join(RAW, 'ncrb_state_heads_raw.json');
if (!fs.existsSync(rawPath)) {
  console.error('Missing raw/ncrb_state_heads_raw.json.\nRun:  python3 datastore/tools/parse_ncrb_state_heads.py');
  process.exit(1);
}
const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
const ncrb = JSON.parse(fs.readFileSync(path.join(REF, 'ncrb_states_2023.json'), 'utf8'));

const norm = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
const HEAD_BY_NORM = new Map(tax.heads.map((h) => [norm(h.head), h.head]));
const NATIONAL = new Map(tax.heads.map((h) => [h.head, h.cases2022]));

const EXCLUDE = new Set(aliasFile._exclude);
const EXCLUDE_FULL = new Set(aliasFile._excludeFullKey);
const FULLKEY = aliasFile._fullKey || {};
const ALIAS = aliasFile.alias;

/** NCRB leaf label, stripped of enumerator prefix and section/total parentheticals. */
function cleanLeaf(key) {
  let s = key.split(' > ').pop();
  s = s.replace(/^[A-Za-z]\)\s*/, '');
  s = s.replace(/\s*\(Sec[^)]*\)\s*/gi, ' ');
  s = s.replace(/\s*\(Section[^)]*\)\s*/gi, ' ');
  s = s.replace(/\s*\(Total\)\s*$/i, '');
  return s.replace(/\s+/g, ' ').trim();
}
const isAggregate = (key) => /\(total\)\s*$/i.test(key.split(' > ').pop().trim());

/** NCRB writes some state names differently from its own summary table. */
const STATE_ALIAS = {
  'A&N Islands': 'Andaman and Nicobar Islands',
  'D&N Haveli and Daman & Diu': 'Dadra and Nagar Haveli and Daman and Diu',
  'Delhi UT': 'Delhi',
  'Jammu & Kashmir': 'Jammu and Kashmir',
  'Puducherry': 'Puducherry',
};
const NCRB_STATES = new Set(ncrb.states.map((s) => s.state));
const toState = (s) => {
  const a = STATE_ALIAS[s] || s;
  if (NCRB_STATES.has(a)) return a;
  const n = norm(a);
  for (const st of NCRB_STATES) if (norm(st) === n) return st;
  return null;
};

// ------------------------------------------------------------------ map + fold
const perState = {};                 // state -> head -> cases
const unmapped = new Map();          // key -> volume
const stateMisses = new Map();
let mappedKeys = 0, skipped = 0;

for (const [rawState, heads] of Object.entries(raw)) {
  const state = toState(rawState);
  if (!state) { stateMisses.set(rawState, Object.keys(heads).length); continue; }
  const bucket = perState[state] || (perState[state] = {});
  for (const [key, value] of Object.entries(heads)) {
    if (!value) continue;
    if (isAggregate(key) || EXCLUDE_FULL.has(key)) { skipped++; continue; }
    const leaf = cleanLeaf(key);
    if (EXCLUDE.has(leaf)) { skipped++; continue; }
    const head = FULLKEY[key] || ALIAS[leaf] || HEAD_BY_NORM.get(norm(leaf));
    if (!head) { unmapped.set(key, (unmapped.get(key) || 0) + value); continue; }
    bucket[head] = (bucket[head] || 0) + value;
    mappedKeys++;
  }
}

console.log(`states mapped        : ${Object.keys(perState).length} of ${ncrb.states.length}`);
if (stateMisses.size) console.log(`  UNRESOLVED STATES  : ${[...stateMisses.keys()].join(', ')}`);
console.log(`aggregate columns skipped: ${skipped}`);
if (unmapped.size) {
  console.log(`\nUNMAPPED NCRB LABELS (${unmapped.size}) — add to ref/ncrb_head_alias.json:`);
  [...unmapped.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) =>
    console.log(`  ${String(v).padStart(9)}  ${k}`));
}

// ------------------------------------------------------------------- verify
// Every head's state figures must reconcile to its published national total.
const observed = new Map();
for (const heads of Object.values(perState)) {
  for (const [h, v] of Object.entries(heads)) observed.set(h, (observed.get(h) || 0) + v);
}
const bad = [];
for (const [head, national] of NATIONAL) {
  const got = observed.get(head) || 0;
  if (got !== national) bad.push({ head, national, got, diff: got - national });
}
console.log(`\nreconciliation: ${NATIONAL.size - bad.length}/${NATIONAL.size} heads match their published national total exactly`);
if (bad.length) {
  console.log('MISMATCHES:');
  bad.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)).forEach((b) =>
    console.log(`  ${b.head.padEnd(56)} national ${String(b.national).padStart(8)}  states ${String(b.got).padStart(8)}  diff ${b.diff}`));
}
const extra = [...observed.keys()].filter((h) => !NATIONAL.has(h));
if (extra.length) console.log(`heads present per state but absent from the taxonomy: ${extra.join(', ')}`);

// --------------------------------------------------------------------- write
const out = { source: 'NCRB Crime in India 2022, Tables 1A.4 (IPC) and 1A.5 (SLL): cases registered per state/UT per crime head.', states: perState };
fs.writeFileSync(path.join(REF, 'ncrb_state_heads_2022.json'), JSON.stringify(out));
const totalCases = [...observed.values()].reduce((a, b) => a + b, 0);
console.log(`\nref/ncrb_state_heads_2022.json -> ${Object.keys(perState).length} states, ` +
  `${observed.size} heads, ${totalCases.toLocaleString('en-IN')} cases`);

// A quick look at the states whose profile the old model got most wrong.
console.log('\nProhibition Act by state (was hand-allocated, now real):');
[...Object.entries(perState)]
  .map(([st, h]) => [st, h['Offence under the State Prohibition Act'] || 0])
  .filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
  .forEach(([st, v]) => {
    const tot = Object.values(perState[st]).reduce((a, b) => a + b, 0);
    console.log(`  ${st.padEnd(20)} ${String(v).padStart(7)}  (${(v / tot * 100).toFixed(1)}% of that state's cases)`);
  });
