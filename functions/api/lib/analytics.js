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
for (const d of DISTRICT_REF) {
  DISTRICT_CENTROIDS.set(d.district, [d.lat, d.lng]);
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

async function overview(app) {
  const one = async (query) => { const r = await q(app, query); return r.length ? countOf(r[0]) : 0; };
  const [cases, accused, heinous, chargesheeted, highRisk, districtRows, stateRows] = await Promise.all([
    one('SELECT COUNT(ROWID) FROM Cases'),
    one('SELECT COUNT(ROWID) FROM Accused'),
    one("SELECT COUNT(ROWID) FROM Cases WHERE Gravity='Heinous'"),
    // Anything past investigation has been chargesheeted at some point.
    one("SELECT COUNT(ROWID) FROM Cases WHERE CaseStatus IN ('Chargesheet Filed','Pending Trial','Convicted','Acquitted')"),
    one("SELECT COUNT(ROWID) FROM OffenderRisk WHERE RiskBand='High'"),
    q(app, 'SELECT DistrictName, COUNT(ROWID) FROM Cases GROUP BY DistrictName LIMIT 300'),
    q(app, 'SELECT StateName, COUNT(ROWID) FROM Cases GROUP BY StateName LIMIT 300'),
  ]);
  return {
    totalCases: cases, totalAccused: accused, heinous,
    heinousPct: cases ? Math.round((heinous / cases) * 100) : 0,
    chargesheeted, chargesheetRate: cases ? Math.round((chargesheeted / cases) * 100) : 0,
    highRiskOffenders: highRisk,
    districts: districtRows.length,
    states: stateRows.filter((r) => r.StateName).length,
  };
}

/**
 * Hotspots at two zoom levels. India has ~400 districts in this dataset, which is
 * far too many to read on one map, so the default view rolls up to state/UT and
 * callers can drill into districts (optionally within one state).
 */
async function hotspots(app, { level = 'state', state, limit = 300 } = {}) {
  const lim = Math.min(Number(limit) || 300, 300); // ZCQL caps LIMIT at 300
  const safeState = state ? String(state).replace(/'/g, "''") : null;

  let districts = [];
  let states = [];
  if (level === 'district' || safeState) {
    const where = safeState ? `WHERE StateName='${safeState}'` : '';
    const rows = await q(app, `SELECT DistrictName, COUNT(ROWID) FROM Cases ${where} GROUP BY DistrictName ORDER BY COUNT(ROWID) DESC LIMIT ${lim}`);
    districts = rows.map((r) => {
      const c = DISTRICT_CENTROIDS.get(r.DistrictName) || [null, null];
      return { name: r.DistrictName, district: r.DistrictName, count: countOf(r), lat: c[0], lng: c[1] };
    }).filter((d) => d.lat != null);
  }
  if (level !== 'district') {
    const rows = await q(app, `SELECT StateName, COUNT(ROWID) FROM Cases GROUP BY StateName ORDER BY COUNT(ROWID) DESC LIMIT ${lim}`);
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
  const [byMonth, byHead, byStatus, byGravity] = await Promise.all([
    q(app, 'SELECT Year, CrimeMonth, COUNT(ROWID) FROM Cases GROUP BY Year, CrimeMonth ORDER BY Year, CrimeMonth LIMIT 60'),
    q(app, 'SELECT CrimeHead, COUNT(ROWID) FROM Cases GROUP BY CrimeHead ORDER BY COUNT(ROWID) DESC LIMIT 20'),
    q(app, 'SELECT CaseStatus, COUNT(ROWID) FROM Cases GROUP BY CaseStatus ORDER BY COUNT(ROWID) DESC LIMIT 20'),
    q(app, 'SELECT Gravity, COUNT(ROWID) FROM Cases GROUP BY Gravity ORDER BY COUNT(ROWID) DESC LIMIT 10')
  ]);
  return {
    byMonth: byMonth.map((r) => ({ year: Number(r.Year), month: Number(r.CrimeMonth), count: countOf(r) })),
    byHead: byHead.map((r) => ({ label: r.CrimeHead, count: countOf(r) })),
    byStatus: byStatus.map((r) => ({ label: r.CaseStatus, count: countOf(r) })),
    byGravity: byGravity.map((r) => ({ label: r.Gravity, count: countOf(r) }))
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

async function offenders(app, { band, limit = 50 } = {}) {
  const lim = Math.min(Number(limit) || 50, 200);
  const where = band ? `WHERE RiskBand='${String(band).replace(/'/g, '')}'` : '';
  const rows = await q(app, `SELECT AccusedName, TotalCases, ViolentCases, RingID, RiskScore, RiskBand, Factors FROM OffenderRisk ${where} ORDER BY RiskScore DESC LIMIT ${lim}`);
  return rows.map((r) => ({
    name: r.AccusedName, totalCases: Number(r.TotalCases), violentCases: Number(r.ViolentCases),
    ring: Number(r.RingID) || 0, riskScore: Number(r.RiskScore), riskBand: r.RiskBand, factors: r.Factors
  }));
}

async function financial(app, { limit = 25 } = {}) {
  const lim = Math.min(Number(limit) || 25, 100);
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
async function moneytrail(app, { limit = 300 } = {}) {
  const lim = Math.min(Number(limit) || 300, 300); // ZCQL LIMIT max is 300
  const rows = await q(app, `SELECT AccusedName, Counterparty, Amount, TxnDate, AccountRef FROM FinancialTxns ORDER BY Amount DESC LIMIT ${lim}`);
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
  })).filter((h) => h.linkedAccused >= 2).sort((a, b) => b.linkedAccused - a.linkedAccused || b.totalAmount - a.totalAmount).slice(0, 15);
  return { nodes: [...nodes.values()], links: edges, hubs, totalFlows: edges.length };
}

// Plain-object centroid lookup keyed by district name, for modules that index it
// directly (forecast/backtest). `KARNATAKA_CENTROIDS` is kept as an alias so those
// call sites keep working now that coverage is all-India, not just Karnataka.
const CENTROIDS = Object.fromEntries([...DISTRICT_CENTROIDS.entries()]);

module.exports = {
  overview, hotspots, trends, network, offenders, financial, sociology, moneytrail,
  DISTRICT_CENTROIDS, STATE_CENTROIDS, CENTROIDS,
  KARNATAKA_CENTROIDS: CENTROIDS,
};
