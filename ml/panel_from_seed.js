'use strict';

/**
 * Builds forecast panels directly from datastore/seed/Cases.csv and runs the in-function
 * engine against them, offline.
 *
 * Why this exists: the engine's only path to data was ~70 sequential ZCQL queries inside
 * a 25-second HTTP request, which is what forced the coarsest possible resolution
 * (district x month) and made every accuracy number hard to check. Reading the seed CSV
 * directly removes that ceiling entirely, so the same code can be evaluated at any
 * resolution and any panel size before anything is deployed.
 *
 * Usage:
 *   node ml/panel_from_seed.js                          # state x month
 *   node ml/panel_from_seed.js --level district         # all 640 districts
 *   node ml/panel_from_seed.js --level district --state Karnataka
 *   node ml/panel_from_seed.js --period week --level district --state Kerala
 *   node ml/panel_from_seed.js --level district --out /tmp/panel.json
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SEED = path.join(__dirname, '..', 'datastore', 'seed', 'Cases.csv');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes('--' + n);

const LEVEL = arg('level', 'state');          // state | district
const PERIOD = arg('period', 'month');        // month | week
const STATE = arg('state', null);
const OUT = arg('out', null);
const HEAD = arg('head', null);               // optional: restrict to one CrimeHead group

function splitCsv(line) {
  const out = [];
  let f = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(f); f = ''; }
    else f += c;
  }
  out.push(f);
  return out;
}

/** ISO week index relative to a fixed Monday epoch, so weeks are contiguous integers. */
const WEEK_EPOCH = Date.UTC(2020, 0, 6); // a Monday
const weekIndexOf = (ms) => Math.floor((ms - WEEK_EPOCH) / (7 * 86400000));

async function build() {
  const counts = new Map();          // unitKey -> Map(periodIndex -> n)
  const unitState = new Map();
  let minP = Infinity, maxP = -Infinity, rows = 0, kept = 0;

  const rl = readline.createInterface({
    input: fs.createReadStream(SEED, { highWaterMark: 1 << 20 }), crlfDelay: Infinity,
  });
  let cols = null, iState, iDist, iY, iM, iDate, iHead;
  for await (const line of rl) {
    if (!cols) {
      cols = splitCsv(line);
      iState = cols.indexOf('StateName'); iDist = cols.indexOf('DistrictName');
      iY = cols.indexOf('Year'); iM = cols.indexOf('CrimeMonth');
      iDate = cols.indexOf('CrimeRegisteredDate'); iHead = cols.indexOf('CrimeHead');
      continue;
    }
    if (!line) continue;
    rows++;
    const v = splitCsv(line);
    if (STATE && v[iState] !== STATE) continue;
    if (HEAD && v[iHead] !== HEAD) continue;
    kept++;
    const key = LEVEL === 'district' ? `${v[iState]}|${v[iDist]}` : v[iState];
    unitState.set(key, v[iState]);
    const p = PERIOD === 'week'
      ? weekIndexOf(Date.parse(v[iDate] + 'T00:00:00Z'))
      : Number(v[iY]) * 12 + (Number(v[iM]) - 1);
    if (p < minP) minP = p;
    if (p > maxP) maxP = p;
    if (!counts.has(key)) counts.set(key, new Map());
    const m = counts.get(key);
    m.set(p, (m.get(p) || 0) + 1);
  }

  const T = maxP - minP + 1;
  const units = [...counts.keys()].sort();
  const series = {};
  for (const u of units) {
    const arr = new Array(T).fill(0);
    for (const [p, n] of counts.get(u)) arr[p - minP] = n;
    series[u] = arr;
  }
  // Timeline entries carry a calendar month so the seasonal models keep working; for a
  // weekly panel the "month" is the seasonal position within the year.
  const timeline = [];
  for (let i = 0; i < T; i++) {
    const p = minP + i;
    if (PERIOD === 'week') {
      const d = new Date(WEEK_EPOCH + p * 7 * 86400000);
      timeline.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, week: p, idx: i, label: d.toISOString().slice(0, 10) });
    } else {
      const y = Math.floor(p / 12), m = (p % 12) + 1;
      timeline.push({ year: y, month: m, idx: i, label: `${y}-${String(m).padStart(2, '0')}` });
    }
  }
  return { rows, kept, units, series, timeline, T, unitState };
}

(async () => {
  const t0 = Date.now();
  const p = await build();
  const vols = p.units.map((u) => p.series[u].reduce((a, b) => a + b, 0)).sort((a, b) => a - b);
  console.log(`panel: level=${LEVEL} period=${PERIOD}${STATE ? ' state=' + STATE : ''}${HEAD ? ' head=' + HEAD : ''}`);
  console.log(`  rows read=${p.rows.toLocaleString('en-IN')} kept=${p.kept.toLocaleString('en-IN')} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  units=${p.units.length}  periods=${p.T}  panel cells=${(p.units.length * p.T).toLocaleString('en-IN')}`);
  console.log(`  volume per unit: min ${vols[0]}  p10 ${vols[Math.floor(vols.length * 0.1)]}  median ${vols[vols.length >> 1]}  max ${vols[vols.length - 1]}`);
  const perPeriod = p.units.length ? vols[vols.length >> 1] / p.T : 0;
  console.log(`  median unit averages ${perPeriod.toFixed(1)} cases per ${PERIOD}`);

  if (OUT) {
    // Centroids and population per unit. The engine uses these for neighbour features and
    // exposure, so a panel exported without them silently loses the spatial signal.
    const ref = require(path.join(__dirname, '..', 'datastore', 'ref', 'india_districts.json'));
    const byDist = new Map(ref.map((d) => [`${d.state}|${d.district}`, d]));
    const stAgg = new Map();
    for (const d of ref) {
      const s = stAgg.get(d.state) || { lat: 0, lng: 0, w: 0, pop: 0 };
      const w = Number(d.population) || 1;
      s.lat += d.lat * w; s.lng += d.lng * w; s.w += w; s.pop += Number(d.population) || 0;
      stAgg.set(d.state, s);
    }
    const popTotal = [...stAgg.values()].reduce((a, s) => a + s.pop, 0) || 1;
    const unitMeta = {};
    for (const u of p.units) {
      if (LEVEL === 'district') {
        const d = byDist.get(u);
        unitMeta[u] = d
          ? { name: d.district, state: d.state, lat: d.lat, lng: d.lng, pop: (Number(d.population) || 0) / popTotal }
          : { name: u.split('|')[1] || u, state: u.split('|')[0], lat: null, lng: null, pop: 0 };
      } else {
        const s = stAgg.get(u);
        unitMeta[u] = s
          ? { name: u, state: u, lat: +(s.lat / s.w).toFixed(5), lng: +(s.lng / s.w).toFixed(5), pop: s.pop / popTotal }
          : { name: u, state: u, lat: null, lng: null, pop: 0 };
      }
    }
    const missing = p.units.filter((u) => unitMeta[u].lat == null).length;
    fs.writeFileSync(OUT, JSON.stringify({
      source: 'ksp-synthetic-all-india', level: LEVEL, period: PERIOD, state: STATE, head: HEAD,
      units: p.units, timeline: p.timeline, series: p.series, unitMeta,
    }));
    console.log(`  wrote ${OUT}  (units without coordinates: ${missing})`);
  }
})();
