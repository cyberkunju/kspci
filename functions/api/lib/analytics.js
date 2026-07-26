'use strict';

// Analytics engine — ZCQL aggregations over the Data Store powering the
// visualization dashboards (overview KPIs, hotspots, trends, network, offenders).

// All-India geography: real district centroids (population-weighted) for ~416
// districts across 35 states/UTs, generated alongside the seed data.
// Falls back to an empty set so the API still answers if the file is absent.
let DISTRICT_REF = [];
try {
  DISTRICT_REF = require('../ref/india_districts.json');
} catch (_) { DISTRICT_REF = []; }

const DISTRICT_CENTROIDS = new Map();
const STATE_CENTROIDS = new Map();
// Six district names exist in two states each (Aurangabad, Bilaspur, Hamirpur,
// Pratapgarh, Raigarh, Bijapur), so a name-only key silently collapses two real
// districts onto one point. Keys are 'state|district'; the bare name is kept as a
// fallback only where it is unambiguous.
const ambiguousNames = new Set();
{
  const seen = new Set();
  for (const d of DISTRICT_REF) {
    if (seen.has(d.district)) ambiguousNames.add(d.district);
    seen.add(d.district);
  }
}
for (const d of DISTRICT_REF) {
  DISTRICT_CENTROIDS.set(d.state + '|' + d.district, [d.lat, d.lng]);
  if (!ambiguousNames.has(d.district)) DISTRICT_CENTROIDS.set(d.district, [d.lat, d.lng]);
  const s = STATE_CENTROIDS.get(d.state) || { lat: 0, lng: 0, w: 0 };
  const w = Number(d.population) || 1;
  s.lat += d.lat * w; s.lng += d.lng * w; s.w += w;
  STATE_CENTROIDS.set(d.state, s);
}
for (const [k, v] of STATE_CENTROIDS) {
  STATE_CENTROIDS.set(k, [+(v.lat / v.w).toFixed(5), +(v.lng / v.w).toFixed(5)]);
}

function flatten(row) {
  const out = {};
  for (const k of Object.keys(row)) {
    const v = row[k];
    if (v && typeof v === 'object') Object.assign(out, v);
    else out[k] = v;
  }
  return out;
}
const countOf = (r) => Number(r['COUNT(ROWID)'] ?? r.cnt ?? r.count ?? 0);

async function q(app, query) {
  const res = await app.zcql().executeZCQLQuery(query);
  return (res || []).map(flatten);
}

/**
 * Run a grouped aggregate over Cases one year at a time and merge the results.
 *
 * ZCQL has a processing ceiling that scales with rows scanned times groups produced, and it is
 * reached between half a million and a million rows: measured on this data, `GROUP BY Gravity`
 * (3 groups) succeeds over 1,016,380 rows, `GROUP BY StateName` (36 groups) fails over the same
 * rows, and the identical query restricted to one year (512,054 rows) succeeds. The failure is a
 * 400 reading "Error occurred during query processing" — it names neither the cause nor the
 * query, so at national scale the dashboards simply broke.
 *
 * Partitioning on Year is the natural split: it is already an indexed-cardinality-3 column here,
 * every aggregate below is additive across it, and it keeps each partition well inside the
 * ceiling. Grows to a handful of queries instead of one, which costs a few paise per call.
 *
 * `cols` are the grouping columns, `merge` folds one row into the accumulator keyed by `keyOf`.
 */
async function groupedOverYears(app, { cols, where = '', extra = '', years = null }) {
  const yrs = years || await q(app, 'SELECT Year, COUNT(ROWID) FROM Cases GROUP BY Year LIMIT 300')
    .then((rows) => rows.map((r) => Number(r.Year)).filter(Boolean).sort());
  const clause = (y) => {
    const parts = [`Year=${y}`];
    if (where) parts.push(where.replace(/^\s*WHERE\s+/i, ''));
    return `WHERE ${parts.join(' AND ')}`;
  };
  const out = [];
  for (const y of yrs) {
    const rows = await q(app,
      `SELECT ${cols}, COUNT(ROWID) FROM Cases ${clause(y)} GROUP BY ${cols} ${extra}`.trim());
    out.push(...rows);
  }
  return out;
}

/** Fold year-partitioned rows into one row per group, summing the counts. */
function mergeCounts(rows, keyOf) {
  const acc = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    const cur = acc.get(k);
    if (cur) cur.count += countOf(r);
    else acc.set(k, { row: r, count: countOf(r) });
  }
  return [...acc.values()].sort((a, b) => b.count - a.count);
}

async function overview(app) {
  const one = async (query) => { const r = await q(app, query); return r.length ? countOf(r[0]) : 0; };
  // Sequential, deliberately. Run as five parallel counts these intermittently returned
  // "Error occurred during query processing" at a million rows — each query is fine alone, so the
  // limit is on concurrent query processing. A KPI header that fails one load in three is worse
  // than one that takes four seconds.
  const [cases, accused, heinous, chargesheeted, highRisk, , stateRows] = [
    await one('SELECT COUNT(ROWID) FROM Cases'),
    await one('SELECT COUNT(ROWID) FROM Accused'),
    await one("SELECT COUNT(ROWID) FROM Cases WHERE Gravity='Heinous'"),
    // Anything past investigation has been chargesheeted at some point. Partitioned by year: a
    // four-value IN scan across the whole table is the heaviest query on this page.
    await (async () => {
      const rows = await groupedOverYears(app, {
        cols: 'CaseStatus',
        where: "CaseStatus IN ('Chargesheet Filed','Pending Trial','Convicted','Acquitted')",
      });
      return rows.reduce((s, r) => s + countOf(r), 0);
    })(),
    await one("SELECT COUNT(ROWID) FROM OffenderRisk WHERE RiskBand='High'"),
    // ZCQL caps LIMIT at 300 and the data covers ~640 districts, so counting the rows
    // returned here would report 300 and understate coverage. The district universe is
    // a property of the reference data, not of a paged query.
    Promise.resolve(null),
    // Same reasoning for states, and it also avoids a national GROUP BY that exceeds ZCQL's
    // processing ceiling past ~1M rows.
    null,
  ];
  return {
    totalCases: cases, totalAccused: accused, heinous,
    heinousPct: cases ? Math.round((heinous / cases) * 100) : 0,
    chargesheeted, chargesheetRate: cases ? Math.round((chargesheeted / cases) * 100) : 0,
    highRiskOffenders: highRisk,
    districts: DISTRICT_REF.length,
    states: STATE_CENTROIDS.size,
  };
}

/**
 * Hotspots at two zoom levels. India has ~400 districts in this dataset, which is
 * far too many to read on one map, so the default view rolls up to state/UT and
 * callers can drill into districts (optionally within one state).
 */
async function hotspots(app, { level = 'state', state, limit = 0 } = {}) {
  // The old 300 ceiling existed because ZCQL caps LIMIT at 300 and the roll-up was one query.
  // The aggregates are now partitioned and merged in process, so every district is already in
  // hand and capping the response would hide two thirds of the country for no reason.
  const lim = Math.min(Number(limit) || 700, 700);
  const safeState = state ? String(state).replace(/'/g, "''") : null;

  let districts = [];
  let states = [];
  if (level === 'district' || safeState) {
    const where = safeState ? `WHERE StateName='${safeState}'` : '';
    // Grouping by StateName as well keeps the six duplicated district names apart, and
    // gives the centroid lookup the state it needs to resolve them.
    // Partitioned by state, one query each.
    //
    // Year partitioning is not enough here: ~640 district groups over a single year's ~512,000
    // rows still exceeds ZCQL's ceiling. Per state it is at most 71 groups over a few tens of
    // thousands of rows, which also brings every partition under the 300-row LIMIT cap — so this
    // needs no pagination, and therefore does not depend on OFFSET or ORDER BY, both of which
    // proved unreliable on this store.
    const targets = safeState ? [safeState] : [...STATE_CENTROIDS.keys()];
    // In parallel, in bounded waves: 36 partitions run sequentially at roughly a second each
    // overshoot the function's execution ceiling, and the work is entirely waiting on the store.
    const rows = [];
    // Four at a time. Each partition takes about a second, so 36 sequential queries overshoot the
    // function's execution ceiling — but twelve concurrent ones come back as a ZCQL processing
    // error, which is a concurrency limit rather than the row ceiling (each query succeeds alone).
    const WAVE = 4;
    for (let i = 0; i < targets.length; i += WAVE) {
      const parts = await Promise.all(targets.slice(i, i + WAVE).map((st) => q(app,
        `SELECT StateName, DistrictName, COUNT(ROWID) FROM Cases WHERE StateName='${String(st).replace(/'/g, "''")}' GROUP BY StateName, DistrictName`)));
      for (const p of parts) rows.push(...p);
    }
    rows.sort((a, b) => countOf(b) - countOf(a));
    rows.length = Math.min(rows.length, lim);
    districts = rows.map((r) => {
      const c = DISTRICT_CENTROIDS.get(r.StateName + '|' + r.DistrictName)
        || DISTRICT_CENTROIDS.get(r.DistrictName) || [null, null];
      const ambiguous = ambiguousNames.has(r.DistrictName);
      return {
        name: ambiguous ? `${r.DistrictName} (${r.StateName})` : r.DistrictName,
        district: r.DistrictName, state: r.StateName,
        count: countOf(r), lat: c[0], lng: c[1],
      };
    }).filter((d) => d.lat != null);
  }
  if (level !== 'district') {
    const rows = mergeCounts(await groupedOverYears(app, { cols: 'StateName' }), (r) => r.StateName)
      .slice(0, lim).map((x) => ({ ...x.row, 'COUNT(ROWID)': x.count }));
    states = rows.map((r) => {
      const c = STATE_CENTROIDS.get(r.StateName) || [null, null];
      return { name: r.StateName, state: r.StateName, count: countOf(r), lat: c[0], lng: c[1] };
    }).filter((d) => d.lat != null);
  }

  // Sampled incident points for the scatter layer.
  const ptWhere = safeState ? `WHERE StateName='${safeState}'` : '';
  const pts = await q(app, `SELECT latitude, longitude, CrimeSubHead, DistrictName FROM Cases ${ptWhere} LIMIT 300`);
  const points = pts.map((p) => ({
    lat: Number(p.latitude), lng: Number(p.longitude), sub: p.CrimeSubHead, district: p.DistrictName
  })).filter((p) => p.lat && p.lng);

  return {
    level: level === 'district' || safeState ? 'district' : 'state',
    state: safeState || null,
    // `districts` stays populated for the existing map component contract.
    districts: (level === 'district' || safeState) ? districts : states,
    states, points,
  };
}

async function trends(app) {
  // Every grouping here except Gravity exceeds ZCQL's processing ceiling nationally, so they run
  // per year and are merged. Gravity would survive a single query, but goes through the same path
  // for consistency — one code path is worth more than saving two queries.
  const years = (await q(app, 'SELECT Year, COUNT(ROWID) FROM Cases GROUP BY Year LIMIT 300'))
    .map((r) => Number(r.Year)).filter(Boolean).sort();

  const [byMonthRows, byHeadRows, byStatusRows, byGravityRows] = await Promise.all([
    groupedOverYears(app, { cols: 'Year, CrimeMonth', years }),
    groupedOverYears(app, { cols: 'CrimeHead', years }),
    groupedOverYears(app, { cols: 'CaseStatus', years }),
    groupedOverYears(app, { cols: 'Gravity', years }),
  ]);

  const byMonth = mergeCounts(byMonthRows, (r) => `${r.Year}-${r.CrimeMonth}`)
    .map((x) => ({ year: Number(x.row.Year), month: Number(x.row.CrimeMonth), count: x.count }))
    .sort((a, b) => (a.year - b.year) || (a.month - b.month));
  const label = (rows, field, limit) => mergeCounts(rows, (r) => r[field])
    .slice(0, limit).map((x) => ({ label: x.row[field], count: x.count }));

  return {
    byMonth,
    byHead: label(byHeadRows, 'CrimeHead', 20),
    byStatus: label(byStatusRows, 'CaseStatus', 20),
    byGravity: label(byGravityRows, 'Gravity', 10),
  };
}

async function network(app, { ring, limit = 250 } = {}) {
  const lim = Math.min(Number(limit) || 250, 400);
  const where = ring ? `WHERE RingID='${String(ring).replace(/'/g, '')}'` : '';
  const order = ring ? '' : 'ORDER BY SharedCases DESC';
  const rows = await q(app, `SELECT AccusedA, AccusedB, SharedCases, RingID FROM CoAccusedLinks ${where} ${order} LIMIT ${lim}`);
  const nodeMap = new Map();
  const links = [];
  for (const r of rows) {
    if (!r.AccusedA || !r.AccusedB) continue;
    const rid = Number(r.RingID) || 0;
    for (const n of [r.AccusedA, r.AccusedB]) {
      const cur = nodeMap.get(n) || { id: n, ring: rid, degree: 0 };
      cur.degree += 1; if (rid) cur.ring = rid;
      nodeMap.set(n, cur);
    }
    links.push({ source: r.AccusedA, target: r.AccusedB, weight: Number(r.SharedCases) || 1, ring: rid });
  }
  // Available rings for the filter
  const ringRows = await q(app, 'SELECT RingID, COUNT(ROWID) FROM CoAccusedLinks GROUP BY RingID ORDER BY COUNT(ROWID) DESC LIMIT 20');
  const rings = ringRows.map((r) => ({ ring: Number(r.RingID) || 0, links: countOf(r) })).filter((r) => r.ring > 0);
  return { nodes: [...nodeMap.values()], links, rings };
}

// 200 rather than 50. There are 94,814 scored offenders; the top fifty are all within a point of
// each other, so a short list looked both sparse and flat. 200 spans roughly 100 down to 95, which
// gives the risk-score column visible variation and the table something to scroll.
async function offenders(app, { band, limit = 200 } = {}) {
  const lim = Math.min(Number(limit) || 200, 300);
  const where = band ? `WHERE RiskBand='${String(band).replace(/'/g, '')}'` : '';
  const rows = await q(app, `SELECT AccusedName, TotalCases, ViolentCases, RingID, RiskScore, RiskBand, Factors FROM OffenderRisk ${where} ORDER BY RiskScore DESC LIMIT ${lim}`);
  return rows.map((r) => ({
    name: r.AccusedName, totalCases: Number(r.TotalCases), violentCases: Number(r.ViolentCases),
    ring: Number(r.RingID) || 0, riskScore: Number(r.RiskScore), riskBand: r.RiskBand, factors: r.Factors
  }));
}

async function financial(app, { limit = 100 } = {}) {
  const lim = Math.min(Number(limit) || 100, 300);
  const rows = await q(app, `SELECT AccusedName, Counterparty, Amount, TxnDate, AccountRef FROM FinancialTxns ORDER BY Amount DESC LIMIT ${lim}`);
  return rows.map((r) => ({
    accused: r.AccusedName, counterparty: r.Counterparty, amount: Number(r.Amount),
    date: r.TxnDate, account: r.AccountRef
  }));
}

// ============================ Sociological crime insights (framework #4) ============================
// Demographic + socio-economic structure of crime: age, gender, occupation, community,
// and crime-type × gender cross-tabs. Urban proxy via district. All exposure-normalized
// framing is decision-support only, never used to profile individuals.
const AGE_BANDS = [[0, 17, '<18'], [18, 25, '18-25'], [26, 35, '26-35'], [36, 45, '36-45'], [46, 60, '46-60'], [61, 200, '60+']];
function bandAges(rows, ageKey = 'AgeYear') {
  const b = Object.fromEntries(AGE_BANDS.map((x) => [x[2], 0]));
  for (const r of rows) {
    const a = Number(r[ageKey]); if (!a && a !== 0) continue;
    const band = AGE_BANDS.find((x) => a >= x[0] && a <= x[1]);
    if (band) b[band[2]] += countOf(r);
  }
  return AGE_BANDS.map((x) => ({ label: x[2], count: b[x[2]] }));
}
const asCat = (rows, key) => rows.map((r) => ({ label: r[key] || 'Not Recorded', count: countOf(r) }))
  .filter((x) => x.label).sort((a, b) => b.count - a.count);

async function sociology(app) {
  const [accAge, accGen, vicAge, vicGen, occ, rel, caste, moGen] = await Promise.all([
    q(app, 'SELECT AgeYear, COUNT(ROWID) FROM Accused GROUP BY AgeYear ORDER BY AgeYear LIMIT 120'),
    q(app, 'SELECT Gender, COUNT(ROWID) FROM Accused GROUP BY Gender LIMIT 10'),
    q(app, 'SELECT AgeYear, COUNT(ROWID) FROM Victims GROUP BY AgeYear ORDER BY AgeYear LIMIT 120'),
    q(app, 'SELECT Gender, COUNT(ROWID) FROM Victims GROUP BY Gender LIMIT 10'),
    q(app, 'SELECT Occupation, COUNT(ROWID) FROM Complainants GROUP BY Occupation ORDER BY COUNT(ROWID) DESC LIMIT 30'),
    q(app, 'SELECT Religion, COUNT(ROWID) FROM Complainants GROUP BY Religion ORDER BY COUNT(ROWID) DESC LIMIT 20'),
    q(app, 'SELECT Caste, COUNT(ROWID) FROM Complainants GROUP BY Caste ORDER BY COUNT(ROWID) DESC LIMIT 20'),
    q(app, 'SELECT CrimeSubHead, Gender, COUNT(ROWID) FROM Accused GROUP BY CrimeSubHead, Gender LIMIT 300')
  ]);
  // crime-type × accused-gender cross-tab (top sub-heads by volume)
  const moMap = {};
  for (const r of moGen) {
    const sh = r.CrimeSubHead || 'Other'; const g = (r.Gender || 'U');
    moMap[sh] = moMap[sh] || { sub: sh, M: 0, F: 0, total: 0 };
    if (g === 'F') moMap[sh].F += countOf(r); else moMap[sh].M += countOf(r);
    moMap[sh].total += countOf(r);
  }
  const crimeByGender = Object.values(moMap).sort((a, b) => b.total - a.total).slice(0, 10)
    .map((x) => ({ sub: x.sub, male: x.M, female: x.F, femalePct: x.total ? Math.round((x.F / x.total) * 100) : 0 }));

  return {
    accusedAge: bandAges(accAge), accusedGender: asCat(accGen, 'Gender'),
    victimAge: bandAges(vicAge), victimGender: asCat(vicGen, 'Gender'),
    occupation: asCat(occ, 'Occupation'), religion: asCat(rel, 'Religion'), caste: asCat(caste, 'Caste'),
    crimeByGender,
    note: 'Aggregate socio-demographic distributions for pattern analysis and social-risk-factor identification. Decision-support only; not for individual profiling.'
  };
}

// ============================ Money-trail network (framework #7) ============================
// Builds a financial-flow graph (accused ↔ counterparty) from transactions and flags
// suspicious hubs (counterparties linked to many distinct accused = potential mules/layering).
/**
 * Money trail, built around the counterparties that actually connect people.
 *
 * This used to take the 300 largest transactions and look for shared counterparties in that
 * sample. Layering hubs are not the largest transfers, so the sample was 300 unrelated pairs:
 * the graph rendered as disconnected dots and the "suspicious hubs" table was always empty,
 * even though the data does contain hubs — 9 counterparties link 4 or more distinct accused.
 *
 * So the hubs are found by aggregation first, and only their transactions are fetched. The graph
 * is then connected by construction and the table has something in it.
 */
async function moneytrail(app, { limit = 300 } = {}) {
  const lim = Math.min(Number(limit) || 300, 300); // ZCQL LIMIT max is 300

  // Counterparties ranked by how many transactions they receive. Cheap: one grouped query.
  const ranked = await q(app,
    `SELECT Counterparty, COUNT(ROWID) FROM FinancialTxns GROUP BY Counterparty ORDER BY COUNT(ROWID) DESC LIMIT ${lim}`);
  const hubNames = ranked.map((r) => r.Counterparty).filter(Boolean).slice(0, 70);

  let rows = [];
  if (hubNames.length) {
    const list = hubNames.map((n) => `'${String(n).replace(/'/g, "''")}'`).join(',');
    rows = await q(app,
      `SELECT AccusedName, Counterparty, Amount, TxnDate, AccountRef FROM FinancialTxns WHERE Counterparty IN (${list}) LIMIT ${lim}`);
  }
  // Top transfers by value, for context alongside the hub subgraph. Kept separate so the graph
  // stays connected while the largest flows are still represented.
  const big = await q(app,
    `SELECT AccusedName, Counterparty, Amount, TxnDate, AccountRef FROM FinancialTxns ORDER BY Amount DESC LIMIT 120`);
  const seen = new Set(rows.map((r) => `${r.AccusedName}|${r.Counterparty}|${r.Amount}`));
  for (const r of big) {
    const k = `${r.AccusedName}|${r.Counterparty}|${r.Amount}`;
    if (!seen.has(k)) { rows.push(r); seen.add(k); }
  }
  const nodes = new Map(); const edges = [];
  const cpAccused = {}; // counterparty -> set of accused (mule detection)
  for (const r of rows) {
    const a = r.AccusedName, c = r.Counterparty, amt = Number(r.Amount) || 0;
    if (!a || !c) continue;
    for (const [id, type] of [[a, 'accused'], [c, 'counterparty']]) {
      const n = nodes.get(id) || { id, type, total: 0, degree: 0 };
      n.total += amt; n.degree += 1; nodes.set(id, n);
    }
    edges.push({ source: a, target: c, amount: amt, date: r.TxnDate, account: r.AccountRef });
    (cpAccused[c] = cpAccused[c] || new Set()).add(a);
  }
  const hubs = Object.entries(cpAccused).map(([cp, set]) => ({
    counterparty: cp, linkedAccused: set.size,
    totalAmount: (nodes.get(cp) || {}).total || 0
  })).filter((h) => h.linkedAccused >= 2).sort((a, b) => b.linkedAccused - a.linkedAccused || b.totalAmount - a.totalAmount).slice(0, 20);
  return { nodes: [...nodes.values()], links: edges, hubs, totalFlows: edges.length };
}

// Plain-object centroid lookup keyed by district name, for modules that index it
// directly (forecast/backtest). `KARNATAKA_CENTROIDS` is kept as an alias so those
// call sites keep working now that coverage is all-India, not just Karnataka.
const CENTROIDS = Object.fromEntries([...DISTRICT_CENTROIDS.entries()]);

/**
 * Nearest district to a coordinate, by great-circle distance to the district
 * centroid. Used when a field officer shares their WhatsApp location: it turns a
 * lat/lng into the district name the rest of the system speaks in.
 *
 * ponytail: centroid distance, not a point-in-polygon test, so near a district
 * boundary it can name the neighbour. Callers must present the result as
 * "nearest district", which is honest and sufficient for choosing an area to
 * query. Swap in the Census boundaries used by datastore/build-geo.js if exact
 * containment ever matters.
 */
function nearestDistrict(lat, lng) {
  const la = Number(lat), ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln) || !DISTRICT_REF.length) return null;
  const rad = Math.PI / 180;
  let best = null, bestKm = Infinity;
  for (const d of DISTRICT_REF) {
    const dLat = (d.lat - la) * rad;
    const dLng = (d.lng - ln) * rad * Math.cos((la + d.lat) / 2 * rad);
    const km = Math.sqrt(dLat * dLat + dLng * dLng) * 6371;
    if (km < bestKm) { bestKm = km; best = d; }
  }
  return best ? { district: best.district, state: best.state, km: Math.round(bestKm) } : null;
}

module.exports = {
  overview, hotspots, trends, network, offenders, financial, sociology, moneytrail,
  DISTRICT_CENTROIDS, STATE_CENTROIDS, CENTROIDS, nearestDistrict,
  KARNATAKA_CENTROIDS: CENTROIDS,
};
