'use strict';

/**
 * KSP Crime AI — CALIBRATED ETAS crime-data generator.
 *
 * This is NOT random noise. Crime is simulated as a self-exciting spatio-temporal
 * point process (Epidemic-Type Aftershock Sequence / Hawkes), the same generative
 * model modern predictive-policing systems detect. It is calibrated to real Karnataka
 * NCRB statistics (state volume ~2L/yr, YoY decline, crime-head mix, district skew),
 * so the data carries genuine, learnable structure:
 *   - near-repeat / retaliation clustering in space-time (what Hawkes forecasts)
 *   - realistic seasonality (festival/summer) + weekly + diurnal cycles
 *   - organized-crime rings with bursty co-offending
 *
 * Outputs:
 *   datastore/seed/*.csv    -> app tables (denormalized, capped to dev limits, recent window)
 *   datastore/train/*.csv   -> FULL event log + weekly feature series for model training/backtest
 *
 * Usage: node datastore/generate.js [--scale 1.0]
 */

const fs = require('fs');
const path = require('path');
const SEED_DIR = path.join(__dirname, 'seed');
const TRAIN_DIR = path.join(__dirname, 'train');
fs.mkdirSync(SEED_DIR, { recursive: true });
fs.mkdirSync(TRAIN_DIR, { recursive: true });

// ---------------- seeded RNG + samplers ----------------
let _s = 20260728 >>> 0;
function rand() { _s = (_s * 1664525 + 1013904223) >>> 0; return _s / 4294967296; }
const pick = (a) => a[Math.floor(rand() * a.length)];
const randint = (a, b) => a + Math.floor(rand() * (b - a + 1));
const chance = (p) => rand() < p;
function gauss(mean = 0, sd = 1) { // Box-Muller
  const u = Math.max(rand(), 1e-9), v = rand();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function poisson(lambda) { // Knuth
  if (lambda <= 0) return 0;
  if (lambda > 30) return Math.max(0, Math.round(gauss(lambda, Math.sqrt(lambda))));
  const L = Math.exp(-lambda); let k = 0, p = 1;
  do { k++; p *= rand(); } while (p > L);
  return k - 1;
}
function weighted(items, weights) {
  const tot = weights.reduce((a, b) => a + b, 0); let r = rand() * tot;
  for (let i = 0; i < items.length; i++) { r -= weights[i]; if (r <= 0) return items[i]; }
  return items[items.length - 1];
}

const SCALE = (() => { const i = process.argv.indexOf('--scale'); return i > -1 ? parseFloat(process.argv[i + 1]) : 1.0; })();

// ---------------- calibration (real Karnataka anchors) ----------------
// District: [name, lat, lng, populationWeight, urbanSpread(deg)]
const DISTRICTS = [
  ['Bengaluru City', 12.9716, 77.5946, 0.265, 0.11],
  ['Bengaluru Rural', 13.2846, 77.6786, 0.045, 0.14],
  ['Mysuru', 12.2958, 76.6394, 0.085, 0.09],
  ['Mangaluru (DK)', 12.9141, 74.856, 0.052, 0.08],
  ['Hubballi-Dharwad', 15.3647, 75.124, 0.06, 0.08],
  ['Belagavi', 15.8497, 74.4977, 0.07, 0.12],
  ['Kalaburagi', 17.3297, 76.8343, 0.06, 0.10],
  ['Ballari', 15.1394, 76.9214, 0.05, 0.10],
  ['Vijayapura', 16.8302, 75.71, 0.04, 0.10],
  ['Shivamogga', 13.9299, 75.5681, 0.042, 0.09],
  ['Tumakuru', 13.3379, 77.101, 0.05, 0.11],
  ['Davanagere', 14.4644, 75.9218, 0.038, 0.08],
  ['Udupi', 13.3409, 74.7421, 0.03, 0.08],
  ['Hassan', 13.0072, 76.0962, 0.04, 0.09],
  ['Raichur', 16.2076, 77.3463, 0.038, 0.09]
];
// Crime heads with NCRB-like share + self-excitation (near-repeat propensity) + gravity mix
// [head, share, branchingRatio(rho), meanDelayDays, spatialSigmaDeg, gravityBias]
const HEADS = [
  ['Property Offences', 0.30, 0.55, 5, 0.010, 'mixed'],
  ['Body Offences', 0.22, 0.42, 9, 0.006, 'heinousish'],
  ['Crime Against Women', 0.14, 0.30, 14, 0.004, 'heinousish'],
  ['Economic Offences', 0.12, 0.35, 20, 0.020, 'economic'],
  ['Public Order', 0.09, 0.60, 3, 0.012, 'nonheinous'],
  ['Cyber Crime', 0.08, 0.25, 12, 0.050, 'economic'],
  ['Narcotics', 0.05, 0.50, 7, 0.008, 'nonheinous']
];
const SUBHEADS = {
  'Property Offences': ['Burglary', 'Theft', 'Robbery', 'Dacoity', 'Motor Vehicle Theft'],
  'Body Offences': ['Murder', 'Attempt to Murder', 'Grievous Hurt', 'Kidnapping'],
  'Crime Against Women': ['Dowry Harassment', 'Assault on Woman', 'Domestic Violence'],
  'Economic Offences': ['Cheating', 'Criminal Breach of Trust', 'Money Laundering', 'Chit Fund Fraud'],
  'Public Order': ['Rioting', 'Unlawful Assembly'],
  'Cyber Crime': ['Online Fraud', 'Identity Theft', 'Ransomware', 'UPI Fraud'],
  'Narcotics': ['Possession NDPS', 'Trafficking NDPS']
};
// Monthly seasonality multiplier (Jan..Dec): festival (Oct-Dec) + summer (Mar-May) peaks
const MONTH_MULT = [0.9, 0.88, 1.05, 1.12, 1.15, 0.98, 0.95, 0.97, 1.08, 1.28, 1.35, 1.2];
const DOW_MULT = [0.95, 0.98, 1.0, 1.02, 1.08, 1.2, 1.12]; // Sun..Sat (weekend higher)
// Time window: 2.5 years ending ~ now
const START = new Date('2024-01-01T00:00:00Z').getTime();
const END = new Date('2026-07-01T00:00:00Z').getTime();
const DAY = 86400000;
const YEARS = (END - START) / (365.25 * DAY);
// Real YoY: 2024 lower than 2023 (~ -7%). Encode mild downward drift across window.
const trendAt = (t) => 1.08 - 0.10 * ((t - START) / (END - START)); // 1.08 -> 0.98

// Target background events (scaled down from ~2L/yr real to a dev-friendly but rich volume).
// Offspring (~branching) multiply this into the final total.
const BG_PER_YEAR = 9000 * SCALE;

module.exports = { rand, pick, gauss, poisson };

// ---------------- names / stations ----------------
const FIRST = ['Ravi', 'Suresh', 'Manjunath', 'Prakash', 'Lakshmi', 'Anitha', 'Kiran', 'Deepak',
  'Shivakumar', 'Nagaraj', 'Bhavana', 'Rekha', 'Imran', 'Fatima', 'Joseph', 'Mary', 'Girish',
  'Vinutha', 'Chetan', 'Pooja', 'Basavaraj', 'Yashwanth', 'Ashwini'];
const LAST = ['Gowda', 'Shetty', 'Rao', 'Reddy', 'Naik', 'Patil', 'Hegde', 'Kumar', 'Murthy',
  'Iyengar', 'Bhat', 'Prasad', 'Kulkarni', 'Desai', 'Nayak'];
const nm = () => pick(FIRST) + ' ' + pick(LAST);
const pad = (n, w) => String(n).padStart(w, '0');
const catCode = { 'FIR': 1, 'UDR': 3, 'PAR': 4, 'Zero FIR': 8 };
const ACTS = { 'Murder': 'IPC 302', 'Attempt to Murder': 'IPC 307', 'Robbery': 'IPC 392',
  'Dacoity': 'IPC 395', 'Theft': 'IPC 379', 'Burglary': 'IPC 457', 'Motor Vehicle Theft': 'IPC 379',
  'Cheating': 'IPC 420', 'Criminal Breach of Trust': 'IPC 406', 'Money Laundering': 'PMLA 3',
  'Chit Fund Fraud': 'IPC 420', 'Online Fraud': 'IT 66D', 'Identity Theft': 'IT 66C',
  'Ransomware': 'IT 66', 'UPI Fraud': 'IT 66D', 'Dowry Harassment': 'IPC 498A',
  'Assault on Woman': 'IPC 354', 'Domestic Violence': 'IPC 498A', 'Rioting': 'IPC 147',
  'Unlawful Assembly': 'IPC 143', 'Possession NDPS': 'NDPS 20', 'Trafficking NDPS': 'NDPS 21',
  'Grievous Hurt': 'IPC 325', 'Kidnapping': 'IPC 363' };
const STATUSES = ['Under Investigation', 'Chargesheet Filed', 'Convicted', 'Acquitted', 'Closed - Undetected', 'Pending Trial'];

const districtStations = {};
DISTRICTS.forEach(([d]) => { districtStations[d] = []; const n = randint(4, 6); for (let i = 0; i < n; i++) districtStations[d].push(`${d} PS-${i + 1}`); });

// ---------------- ETAS simulation ----------------
console.log(`Simulating ETAS crime process (scale=${SCALE})…`);
const dWeights = DISTRICTS.map((d) => d[3]);
const hShares = HEADS.map((h) => h[1]);
const seasonalEnvelope = (t) => {
  const dt = new Date(t);
  return MONTH_MULT[dt.getUTCMonth()] * DOW_MULT[dt.getUTCDay()] * trendAt(t);
};
const MAXENV = 1.35 * 1.2 * 1.08;

let events = [];
let eid = 0;
function spawn(ev) { events.push(ev); }

// Background immigrants per (district, head)
for (let di = 0; di < DISTRICTS.length; di++) {
  const [dname, dlat, dlng, dw, spread] = DISTRICTS[di];
  for (let hi = 0; hi < HEADS.length; hi++) {
    const [head, share] = HEADS[hi];
    const expected = BG_PER_YEAR * YEARS * dw * share;
    const n = poisson(expected);
    for (let k = 0; k < n; k++) {
      // rejection-sample time under seasonal envelope
      let t;
      do { t = START + rand() * (END - START); } while (rand() > seasonalEnvelope(t) / MAXENV);
      spawn({
        id: eid++, t, lat: dlat + gauss(0, spread), lng: dlng + gauss(0, spread * 0.9),
        di, head, hi, gen: 0
      });
    }
  }
}
const bgCount = events.length;

// Offspring cascade (self-excitation / near-repeat). Process queue.
let cursor = 0;
while (cursor < events.length) {
  const p = events[cursor++];
  const [head, share, rho, meanDelay, sig] = HEADS[p.hi];
  const kids = poisson(rho);
  for (let j = 0; j < kids; j++) {
    const dt = -meanDelay * DAY * Math.log(Math.max(rand(), 1e-9)); // Exp(mean=meanDelay days)
    const t = p.t + dt;
    if (t >= END) continue;
    // near-repeat: same head usually; small mutation chance
    const hi = chance(0.85) ? p.hi : Math.floor(rand() * HEADS.length);
    spawn({
      id: eid++, t, lat: p.lat + gauss(0, sig), lng: p.lng + gauss(0, sig),
      di: p.di, head: HEADS[hi][0], hi, gen: p.gen + 1
    });
  }
}
events.sort((a, b) => a.t - b.t);
console.log(`  background=${bgCount}  total(with near-repeat)=${events.length}  offspring=${events.length - bgCount}`);

// ---------------- offenders & organized rings ----------------
const NUM_OFFENDERS = Math.max(300, Math.floor(events.length * 0.05));
const offenders = [];
for (let i = 0; i < NUM_OFFENDERS; i++) offenders.push({ name: nm(), ring: 0, base: 18 + Math.floor(rand() * 40) });
// 8 rings, each a burst-active subset
const NUM_RINGS = 8;
const rings = [];
for (let r = 1; r <= NUM_RINGS; r++) {
  const members = [];
  const size = randint(6, 16);
  for (let m = 0; m < size; m++) { const o = pick(offenders); o.ring = r; members.push(o); }
  // 1-3 active bursts within window
  const bursts = [];
  const nb = randint(1, 3);
  for (let b = 0; b < nb; b++) { const s = START + rand() * (END - START - 60 * DAY); bursts.push([s, s + randint(20, 80) * DAY]); }
  rings.push({ ring: r, members, bursts, district: randint(0, DISTRICTS.length - 1) });
}
const ringActiveAt = (t) => rings.filter((rg) => rg.bursts.some(([a, b]) => t >= a && t <= b));

// ---------------- assemble app tables ----------------
console.log('Assembling case records + network + risk…');
const Cases = [], Accused = [], Victims = [], Complainants = [], Arrests = [], FinancialTxns = [];
let aId = 1, vId = 1, cpId = 1, arrId = 1, txnId = 1;
const serial = {};
const accusedByCase = {};
const offenderStats = {}; // name -> {total, violent, ring}

const occ = ['Farmer', 'Daily Wage', 'Business', 'Student', 'IT Professional', 'Unemployed', 'Govt Employee', 'Driver'];
const rel = ['Hindu', 'Muslim', 'Christian', 'Jain', 'Other'];
const caste = ['General', 'OBC', 'SC', 'ST', 'Not Recorded'];

events.forEach((ev, idx) => {
  const cid = idx + 1;
  const [dname, dlat, dlng] = DISTRICTS[ev.di];
  const head = ev.head;
  const sub = pick(SUBHEADS[head]);
  const dt = new Date(ev.t);
  const year = dt.getUTCFullYear(), month = dt.getUTCMonth() + 1;
  const cat = chance(0.82) ? 'FIR' : pick(['UDR', 'PAR', 'Zero FIR']);
  const station = pick(districtStations[dname]);
  const stationIdx = districtStations[dname].indexOf(station) + 1;
  serial[`${ev.di}-${year}`] = (serial[`${ev.di}-${year}`] || 0) + 1;
  const crimeNo = `${catCode[cat]}${pad(ev.di + 1, 4)}${pad(stationIdx, 4)}${year}${pad(serial[`${ev.di}-${year}`], 5)}`;
  const gravity = ['Murder', 'Rape', 'Dacoity', 'Robbery', 'Kidnapping'].some((k) => sub.includes(k)) ? 'Heinous'
    : (head === 'Economic Offences' || head === 'Cyber Crime') ? 'Economic' : 'Non-Heinous';

  // accused: draw from active ring (organized) or repeat/random offenders
  const nA = head === 'Public Order' ? randint(2, 5) : randint(1, 3);
  const activeRings = ringActiveAt(ev.t).filter((rg) => rg.district === ev.di);
  const useRing = activeRings.length && (head === 'Property Offences' || head === 'Economic Offences' || head === 'Narcotics') && chance(0.6);
  const caseAcc = [];
  for (let a = 0; a < nA; a++) {
    let off;
    if (useRing) off = pick(pick(activeRings).members);
    else off = chance(0.5) ? pick(offenders) : { name: nm(), ring: 0 };
    const aid = aId++;
    Accused.push({ AccusedMasterID: aid, CaseMasterID: cid, CrimeNo: crimeNo, AccusedName: off.name,
      AgeYear: off.base || randint(18, 55), Gender: chance(0.9) ? 'M' : 'F', PersonID: 'A' + (a + 1),
      RingID: off.ring || 0, DistrictName: dname, CrimeSubHead: sub });
    caseAcc.push(off.name);
    const st = offenderStats[off.name] || (offenderStats[off.name] = { total: 0, violent: 0, ring: off.ring || 0 });
    st.total++; if (gravity === 'Heinous') st.violent++; if (off.ring) st.ring = off.ring;
  }
  accusedByCase[cid] = caseAcc;

  const nV = (head === 'Body Offences' || head === 'Crime Against Women') ? randint(1, 2) : randint(0, 1);
  for (let v = 0; v < nV; v++) Victims.push({ VictimMasterID: vId++, CaseMasterID: cid, VictimName: nm(), AgeYear: randint(5, 75), Gender: chance(0.5) ? 'M' : 'F' });

  Complainants.push({ ComplainantID: cpId++, CaseMasterID: cid, ComplainantName: nm(), AgeYear: randint(18, 70),
    Gender: chance(0.6) ? 'M' : 'F', Occupation: pick(occ), Religion: pick(rel), Caste: pick(caste) });

  if (chance(0.6)) {
    Arrests.push({ ArrestID: arrId++, CaseMasterID: cid, AccusedMasterID: 0, AccusedName: pick(caseAcc),
      ArrestType: chance(0.85) ? 'Arrest' : 'Surrender', ArrestDate: dt.toISOString().slice(0, 10),
      DistrictName: dname, IOName: nm() });
  }
  if (head === 'Economic Offences' || head === 'Cyber Crime') {
    const nT = randint(2, 6);
    for (let t = 0; t < nT; t++) FinancialTxns.push({ TxnID: txnId++, AccusedMasterID: 0, AccusedName: pick(caseAcc),
      Counterparty: nm(), Amount: randint(5000, 5000000), TxnDate: dt.toISOString().slice(0, 19).replace('T', ' '),
      AccountRef: 'AC' + randint(10000000, 99999999) });
  }

  Cases.push({
    CaseMasterID: cid, CrimeNo: crimeNo, CaseNo: `${year}${pad(serial[`${ev.di}-${year}`], 5)}`,
    CrimeRegisteredDate: dt.toISOString().slice(0, 10), Year: year, CrimeMonth: month,
    IncidentDate: dt.toISOString().slice(0, 19).replace('T', ' '),
    DistrictName: dname, StationName: station,
    latitude: +ev.lat.toFixed(5), longitude: +ev.lng.toFixed(5),
    CaseCategory: cat, Gravity: gravity, CrimeHead: head, CrimeSubHead: sub,
    CaseStatus: pick(STATUSES), CourtName: `${dname} District & Sessions Court`, OfficerName: nm(),
    ActsSections: ACTS[sub] || 'IPC 34', AccusedCount: nA, VictimCount: nV,
    BriefFacts: `A case of ${sub.toLowerCase()} was registered in ${dname}. Investigation initiated; evidence collected.`,
    _t: ev.t
  });
});

// CoAccusedLinks (co-accused pairs aggregated) + OffenderRisk
const edge = {};
for (const cid of Object.keys(accusedByCase)) {
  const names = [...new Set(accusedByCase[cid])];
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
    const [x, y] = [names[i], names[j]].sort(); const k = x + '||' + y;
    edge[k] = edge[k] || { AccusedA: x, AccusedB: y, SharedCases: 0 };
    edge[k].SharedCases++;
  }
}
const ringByName = {}; offenders.forEach((o) => { if (o.ring) ringByName[o.name] = o.ring; });
const CoAccusedLinks = Object.values(edge).map((e, i) => ({ LinkID: i + 1, AccusedA: e.AccusedA, AccusedB: e.AccusedB,
  SharedCases: e.SharedCases, RingID: ringByName[e.AccusedA] || ringByName[e.AccusedB] || 0 }));
const OffenderRisk = Object.entries(offenderStats).filter(([, s]) => s.total >= 2).map(([name, s], i) => {
  const score = Math.min(100, Math.round(s.total * 7 + s.violent * 12 + (s.ring ? 20 : 0)));
  return { OffenderRiskID: i + 1, AccusedName: name, TotalCases: s.total, ViolentCases: s.violent,
    RingID: s.ring || 0, RiskScore: score, RiskBand: score >= 70 ? 'High' : score >= 40 ? 'Medium' : 'Low',
    Factors: `${s.total} cases; ${s.violent} violent${s.ring ? '; organized-ring member' : ''}` };
}).sort((a, b) => b.RiskScore - a.RiskScore);

module.exports.buildStats = { bgCount, total: events.length };

// ================= OUTPUT =================
// CSV helpers
function toCsv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    if (v === null || v === undefined) v = '';
    v = String(v);
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  const out = [cols.join(',')];
  for (const r of rows) out.push(cols.map((c) => esc(r[c])).join(','));
  return out.join('\n');
}
function writeCsv(dir, name, rows) {
  fs.writeFileSync(path.join(dir, name + '.csv'), toCsv(rows));
  console.log(`  ${path.basename(dir)}/${name}.csv  →  ${rows.length} rows`);
}

// ---- App tables: time-representative downsample (preserves seasonality) ----
const CAP = (() => { const i = process.argv.indexOf('--cap'); return i > -1 ? parseInt(process.argv[i + 1], 10) : 5000; })();
// Cases are already time-ordered ascending. Systematic sampling keeps the full
// span + seasonal shape while staying inside dev Data-Store limits.
let keptCases = Cases;
if (Cases.length > CAP) {
  const k = Math.ceil(Cases.length / CAP);
  keptCases = Cases.filter((_, i) => i % k === 0);
}
const keptIds = new Set(keptCases.map((c) => c.CaseMasterID));
const keptAccNames = new Set();
keptCases.forEach((c) => (accusedByCase[c.CaseMasterID] || []).forEach((n) => keptAccNames.add(n)));

// strip internal _t before writing app CSV
const casesOut = keptCases.map(({ _t, ...rest }) => rest);
const accusedOut = Accused.filter((a) => keptIds.has(a.CaseMasterID));
const victimsOut = Victims.filter((v) => keptIds.has(v.CaseMasterID));
const complainantsOut = Complainants.filter((c) => keptIds.has(c.CaseMasterID));
const arrestsOut = Arrests.filter((a) => keptIds.has(a.CaseMasterID));
// FinancialTxns has no CaseMasterID; keep those tied to kept accused, capped
const finOut = FinancialTxns.filter((f) => keptAccNames.has(f.AccusedName)).slice(0, CAP);
// Graph + risk are standalone aggregates — keep top-N most meaningful
const coOut = CoAccusedLinks.sort((a, b) => b.SharedCases - a.SharedCases).slice(0, CAP);
const riskOut = OffenderRisk.slice(0, CAP);

console.log('\nWriting app tables (datastore/seed):');
writeCsv(SEED_DIR, 'Cases', casesOut);
writeCsv(SEED_DIR, 'Accused', accusedOut);
writeCsv(SEED_DIR, 'Victims', victimsOut);
writeCsv(SEED_DIR, 'Complainants', complainantsOut);
writeCsv(SEED_DIR, 'Arrests', arrestsOut);
writeCsv(SEED_DIR, 'CoAccusedLinks', coOut);
writeCsv(SEED_DIR, 'OffenderRisk', riskOut);
writeCsv(SEED_DIR, 'FinancialTxns', finOut);

// ---- Training data: FULL fidelity (datastore/train) ----
// 1) raw event log (for Hawkes/ETAS fit + point-process backtest)
const eventLog = events.map((e) => ({
  eid: e.id,
  ts: new Date(e.t).toISOString(),
  epoch_days: +((e.t - START) / DAY).toFixed(4),
  district: DISTRICTS[e.di][0],
  district_idx: e.di,
  lat: +e.lat.toFixed(5),
  lng: +e.lng.toFixed(5),
  head: e.head,
  head_idx: e.hi,
  generation: e.gen,
  is_nearrepeat: e.gen > 0 ? 1 : 0
}));

// 2) weekly panel per (district) with per-head counts + calendar features (for GBM + backtest)
const WEEK = 7 * DAY;
const numWeeks = Math.ceil((END - START) / WEEK);
const headKeys = HEADS.map((h) => h[0]);
const shortHead = { 'Property Offences': 'property', 'Body Offences': 'body', 'Crime Against Women': 'women',
  'Economic Offences': 'economic', 'Public Order': 'public', 'Cyber Crime': 'cyber', 'Narcotics': 'narcotics' };
// panel[di][w] = { total, byHead{} }
const panel = {};
for (let di = 0; di < DISTRICTS.length; di++) { panel[di] = []; for (let w = 0; w < numWeeks; w++) panel[di][w] = { total: 0, h: {} }; }
events.forEach((e) => {
  const w = Math.floor((e.t - START) / WEEK);
  if (w < 0 || w >= numWeeks) return;
  const cell = panel[e.di][w];
  cell.total++; cell.h[e.head] = (cell.h[e.head] || 0) + 1;
});
const weekly = [];
for (let di = 0; di < DISTRICTS.length; di++) {
  for (let w = 0; w < numWeeks; w++) {
    const wt = START + w * WEEK;
    const d = new Date(wt);
    const cell = panel[di][w];
    const row = {
      district: DISTRICTS[di][0], district_idx: di, week_idx: w,
      week_start: d.toISOString().slice(0, 10),
      year: d.getUTCFullYear(), month: d.getUTCMonth() + 1,
      week_of_year: Math.ceil((((d - new Date(Date.UTC(d.getUTCFullYear(), 0, 1))) / DAY) + 1) / 7),
      pop_weight: DISTRICTS[di][3],
      total: cell.total
    };
    headKeys.forEach((h) => { row['n_' + shortHead[h]] = cell.h[h] || 0; });
    // lag + rolling features (leak-free: only past)
    const hist = panel[di];
    row.lag1 = w >= 1 ? hist[w - 1].total : 0;
    row.lag2 = w >= 2 ? hist[w - 2].total : 0;
    row.lag4 = w >= 4 ? hist[w - 4].total : 0;
    row.lag52 = w >= 52 ? hist[w - 52].total : 0;
    let r4 = 0, c4 = 0; for (let k = 1; k <= 4 && w - k >= 0; k++) { r4 += hist[w - k].total; c4++; }
    row.roll4_mean = c4 ? +(r4 / c4).toFixed(3) : 0;
    let r12 = 0, c12 = 0; for (let k = 1; k <= 12 && w - k >= 0; k++) { r12 += hist[w - k].total; c12++; }
    row.roll12_mean = c12 ? +(r12 / c12).toFixed(3) : 0;
    weekly.push(row);
  }
}

console.log('\nWriting training data (datastore/train):');
writeCsv(TRAIN_DIR, 'events', eventLog);
writeCsv(TRAIN_DIR, 'weekly_panel', weekly);
// metadata for reproducible training/backtest
fs.writeFileSync(path.join(TRAIN_DIR, 'meta.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  scale: SCALE, seed: 20260728,
  window: { start: new Date(START).toISOString(), end: new Date(END).toISOString(), years: +YEARS.toFixed(3), weeks: numWeeks },
  districts: DISTRICTS.map((d) => ({ name: d[0], lat: d[1], lng: d[2], popWeight: d[3] })),
  heads: HEADS.map((h) => ({ name: h[0], share: h[1], branchingRatio: h[2], meanDelayDays: h[3], spatialSigma: h[4] })),
  monthMult: MONTH_MULT, dowMult: DOW_MULT,
  counts: { events: events.length, background: bgCount, offspring: events.length - bgCount,
    offenders: offenders.length, rings: rings.length, coAccusedEdges: CoAccusedLinks.length, offenderRisk: OffenderRisk.length }
}, null, 2));
console.log('  train/meta.json');

// ================= VERIFICATION STATS =================
console.log('\n──────── CALIBRATION / QUALITY REPORT ────────');
const offFrac = (events.length - bgCount) / events.length;
console.log(`Near-repeat (self-excited) fraction : ${(offFrac * 100).toFixed(1)}%  (real near-repeat share is typically 20-45%)`);

// monthly seasonality (observed)
const perMonth = new Array(12).fill(0);
events.forEach((e) => perMonth[new Date(e.t).getUTCMonth()]++);
const mmax = Math.max(...perMonth);
console.log('\nObserved monthly seasonality (relative):');
const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
perMonth.forEach((c, i) => {
  const bar = '█'.repeat(Math.round((c / mmax) * 30));
  console.log(`  ${M[i]} ${bar} ${c}`);
});

// yearly totals (should show downward drift per NCRB)
const perYear = {};
events.forEach((e) => { const y = new Date(e.t).getUTCFullYear(); perYear[y] = (perYear[y] || 0) + 1; });
console.log('\nYearly totals (NCRB shows YoY decline):');
Object.keys(perYear).sort().forEach((y) => console.log(`  ${y}: ${perYear[y]}`));

// top districts
const perDist = {};
events.forEach((e) => { const d = DISTRICTS[e.di][0]; perDist[d] = (perDist[d] || 0) + 1; });
console.log('\nTop districts by volume:');
Object.entries(perDist).sort((a, b) => b[1] - a[1]).slice(0, 6).forEach(([d, c]) => console.log(`  ${d}: ${c}`));

// crime-head mix vs target
console.log('\nCrime-head mix (observed vs NCRB target):');
const perHead = {};
events.forEach((e) => { perHead[e.head] = (perHead[e.head] || 0) + 1; });
HEADS.forEach(([h, share]) => {
  const obs = ((perHead[h] || 0) / events.length * 100).toFixed(1);
  console.log(`  ${h.padEnd(22)} obs ${obs}%  target ${(share * 100).toFixed(0)}%`);
});

// rings
console.log('\nOrganized rings:');
rings.forEach((rg) => console.log(`  Ring ${rg.ring}: ${rg.members.length} members, ${rg.bursts.length} active burst(s), base ${DISTRICTS[rg.district][0]}`));
console.log(`\nCo-accused graph edges: ${CoAccusedLinks.length}   High-risk offenders: ${OffenderRisk.filter((o) => o.RiskBand === 'High').length}`);
console.log(`\nApp store (seed) cases kept: ${casesOut.length} / ${Cases.length}  (time-representative sample)`);
console.log('──────────────────────────────────────────────');
console.log('DONE. App CSVs → datastore/seed/ ; training data → datastore/train/');
