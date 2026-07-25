'use strict';

/**
 * All-India crime-data generator — NCRB-calibrated ETAS/Hawkes simulation.
 *
 * Geography  : 528 real Indian cities (>=1 lakh population) aggregated into ~416
 *              districts across 35 states/UTs, with real coordinates and
 *              population-weighted centroids.  (datastore/ref/india_cities.json)
 * Calibration: NCRB "Crime in India" 2023 per state/UT — crime rate per lakh,
 *              chargesheet rate, conviction rate, violent-crime rate, and
 *              murder/rape/kidnapping/extortion/robbery rates.
 *              (datastore/ref/ncrb_states_2023.json)
 *
 * Why this produces *realistic variance* rather than uniform noise:
 *   - Volume per district = state crime rate x district population (so Kerala and
 *     Delhi are dense, Nagaland and Sikkim are sparse — a ~19x real spread).
 *   - Severity mix per state is driven by that state's real violent/murder/rape
 *     rates, so the heinous share differs genuinely by region.
 *   - Case outcomes (chargesheeted / convicted / acquitted / pending) follow each
 *     state's real chargesheet and conviction rates.
 *   - Crime is generated as a self-exciting spatio-temporal point process, giving
 *     near-repeat clustering, seasonality, weekly cycles and organized-crime rings.
 *
 * Usage:
 *   node datastore/generate-india.js --cases 200000            # target case volume
 *   node datastore/generate-india.js --cases 50000 --years 3
 *
 * Outputs CSVs to datastore/seed/ (app tables) and datastore/train/ (model data).
 */

const fs = require('fs');
const path = require('path');

const REF_DIR = path.join(__dirname, 'ref');
const SEED_DIR = path.join(__dirname, 'seed');
const TRAIN_DIR = path.join(__dirname, 'train');
fs.mkdirSync(SEED_DIR, { recursive: true });
fs.mkdirSync(TRAIN_DIR, { recursive: true });

// ---------------- CLI ----------------
const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const TARGET_CASES = parseInt(arg('cases', '200000'), 10);
const YEARS_SPAN = parseFloat(arg('years', '3'));
const SEED = parseInt(arg('seed', '20260725'), 10);

// ---------------- seeded RNG ----------------
let _s = SEED >>> 0;
function rand() { _s = (_s * 1664525 + 1013904223) >>> 0; return _s / 4294967296; }
const pick = (a) => a[Math.floor(rand() * a.length)];
const randint = (a, b) => a + Math.floor(rand() * (b - a + 1));
const chance = (p) => rand() < p;
function gauss(mean = 0, sd = 1) {
  const u = Math.max(rand(), 1e-9), v = rand();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function poisson(lambda) {
  if (lambda <= 0) return 0;
  if (lambda > 30) return Math.max(0, Math.round(gauss(lambda, Math.sqrt(lambda))));
  const L = Math.exp(-lambda); let k = 0, p = 1;
  do { k++; p *= rand(); } while (p > L);
  return k - 1;
}
function weightedIndex(weights) {
  const tot = weights.reduce((a, b) => a + b, 0);
  let r = rand() * tot;
  for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r <= 0) return i; }
  return weights.length - 1;
}

// ---------------- geography: cities -> districts ----------------
const cities = JSON.parse(fs.readFileSync(path.join(REF_DIR, 'india_cities.json'), 'utf8'));
const ncrb = JSON.parse(fs.readFileSync(path.join(REF_DIR, 'ncrb_states_2023.json'), 'utf8'));
const STATE_CAL = new Map(ncrb.states.map((s) => [s.state, s]));

const distMap = new Map();
for (const c of cities) {
  const state = c.state;
  const district = c.district || c.city;
  const key = state + '||' + district;
  const pop = Number(c.population) || 0;
  const d = distMap.get(key) || { state, district, pop: 0, lat: 0, lng: 0, cities: [] };
  d.pop += pop;
  d.lat += (Number(c.latitude) || 0) * pop;
  d.lng += (Number(c.longitude) || 0) * pop;
  d.cities.push(c.city);
  distMap.set(key, d);
}
const DISTRICTS = [...distMap.values()]
  .filter((d) => d.pop > 0 && STATE_CAL.has(d.state))
  .map((d) => ({
    state: d.state,
    district: d.district,
    pop: d.pop,
    lat: +(d.lat / d.pop).toFixed(5),
    lng: +(d.lng / d.pop).toFixed(5),
    // Urban spread: bigger metros scatter incidents over a wider area.
    spread: +(0.035 + Math.min(0.09, Math.log10(Math.max(d.pop, 1e5)) * 0.012)).toFixed(4),
    cities: d.cities,
  }));

// Expected registered-crime intensity per district (relative), from real state rate.
DISTRICTS.forEach((d) => {
  const cal = STATE_CAL.get(d.state);
  d.rate = cal.crimeRate;
  d.intensity = (d.pop / 1e5) * cal.crimeRate; // cases per year at full real scale
});
const TOTAL_INTENSITY = DISTRICTS.reduce((a, d) => a + d.intensity, 0);

// ---------------- crime taxonomy ----------------
// [head, nationalShare, branchingRatio(self-excitation), meanDelayDays, spatialSigmaDeg]
const HEADS = [
  ['Property Offences', 0.26, 0.55, 5, 0.010],
  ['Body Offences', 0.18, 0.42, 9, 0.006],
  ['Crime Against Women', 0.13, 0.30, 14, 0.004],
  ['Economic Offences', 0.12, 0.35, 20, 0.020],
  ['Public Order', 0.11, 0.60, 3, 0.012],
  ['Traffic & Negligence', 0.08, 0.20, 4, 0.014],
  ['Cyber Crime', 0.07, 0.25, 12, 0.050],
  ['Narcotics', 0.05, 0.50, 7, 0.008],
];
const SUBHEADS = {
  'Property Offences': ['Burglary', 'Theft', 'Robbery', 'Dacoity', 'Motor Vehicle Theft', 'Criminal Trespass'],
  'Body Offences': ['Murder', 'Attempt to Murder', 'Grievous Hurt', 'Kidnapping', 'Culpable Homicide'],
  'Crime Against Women': ['Dowry Harassment', 'Assault on Woman', 'Domestic Violence', 'Rape', 'Stalking'],
  'Economic Offences': ['Cheating', 'Criminal Breach of Trust', 'Money Laundering', 'Chit Fund Fraud', 'Forgery'],
  'Public Order': ['Rioting', 'Unlawful Assembly', 'Public Nuisance', 'Obstruction of Duty'],
  'Traffic & Negligence': ['Rash Driving', 'Hit and Run', 'Death by Negligence'],
  'Cyber Crime': ['Online Fraud', 'Identity Theft', 'Ransomware', 'UPI Fraud', 'Social Media Offence'],
  'Narcotics': ['Possession NDPS', 'Trafficking NDPS', 'Cultivation NDPS'],
};
const HEINOUS_SUBS = new Set(['Murder', 'Attempt to Murder', 'Rape', 'Dacoity', 'Robbery', 'Kidnapping', 'Culpable Homicide']);
const ACTS = {
  Murder: 'BNS 103 / IPC 302', 'Attempt to Murder': 'BNS 109 / IPC 307', Robbery: 'BNS 309 / IPC 392',
  Dacoity: 'BNS 310 / IPC 395', Theft: 'BNS 303 / IPC 379', Burglary: 'BNS 305 / IPC 457',
  'Motor Vehicle Theft': 'BNS 303 / IPC 379', 'Criminal Trespass': 'BNS 329 / IPC 447',
  Cheating: 'BNS 318 / IPC 420', 'Criminal Breach of Trust': 'BNS 316 / IPC 406',
  'Money Laundering': 'PMLA 3', 'Chit Fund Fraud': 'BNS 318 / IPC 420', Forgery: 'BNS 336 / IPC 465',
  'Online Fraud': 'IT Act 66D', 'Identity Theft': 'IT Act 66C', Ransomware: 'IT Act 66',
  'UPI Fraud': 'IT Act 66D', 'Social Media Offence': 'IT Act 67',
  'Dowry Harassment': 'BNS 85 / IPC 498A', 'Assault on Woman': 'BNS 74 / IPC 354',
  'Domestic Violence': 'BNS 85 / IPC 498A', Rape: 'BNS 64 / IPC 376', Stalking: 'BNS 78 / IPC 354D',
  Rioting: 'BNS 191 / IPC 147', 'Unlawful Assembly': 'BNS 189 / IPC 143',
  'Public Nuisance': 'BNS 270 / IPC 268', 'Obstruction of Duty': 'BNS 121 / IPC 332',
  'Rash Driving': 'BNS 281 / IPC 279', 'Hit and Run': 'BNS 106 / IPC 304A',
  'Death by Negligence': 'BNS 106 / IPC 304A',
  'Possession NDPS': 'NDPS 20', 'Trafficking NDPS': 'NDPS 21', 'Cultivation NDPS': 'NDPS 18',
  'Grievous Hurt': 'BNS 117 / IPC 325', Kidnapping: 'BNS 137 / IPC 363',
  'Culpable Homicide': 'BNS 105 / IPC 304',
};

// Seasonality: festival (Oct-Dec) and summer (Mar-May) peaks; weekend elevation.
const MONTH_MULT = [0.90, 0.88, 1.05, 1.12, 1.15, 0.98, 0.95, 0.97, 1.08, 1.28, 1.35, 1.20];
const DOW_MULT = [0.95, 0.98, 1.00, 1.02, 1.08, 1.20, 1.12];

const DAY = 86400000;
const END = Date.UTC(2026, 6, 1);
const START = END - Math.round(YEARS_SPAN * 365.25 * DAY);
const trendAt = (t) => 1.04 - 0.08 * ((t - START) / (END - START));
const envelope = (t) => {
  const d = new Date(t);
  return MONTH_MULT[d.getUTCMonth()] * DOW_MULT[d.getUTCDay()] * trendAt(t);
};
const MAXENV = 1.35 * 1.20 * 1.04;

module.exports = { DISTRICTS, HEADS };

// ---------------- names (regionally varied) ----------------
const FIRST_N = ['Amit', 'Rajesh', 'Sunil', 'Vikram', 'Anil', 'Deepak', 'Rohit', 'Sanjay', 'Pooja', 'Neha', 'Kavita', 'Sunita', 'Priya', 'Aarti'];
const FIRST_S = ['Ravi', 'Suresh', 'Manjunath', 'Prakash', 'Karthik', 'Venkatesh', 'Lakshmi', 'Anitha', 'Divya', 'Meena', 'Shivakumar', 'Nagaraj'];
const FIRST_E = ['Subrata', 'Debasish', 'Tapan', 'Biswajit', 'Ranjan', 'Sourav', 'Mousumi', 'Sikha', 'Rupali', 'Ananya'];
const FIRST_W = ['Nitin', 'Mahesh', 'Pravin', 'Sachin', 'Jignesh', 'Bhavesh', 'Snehal', 'Vaishali', 'Trupti', 'Manisha'];
const LAST_N = ['Sharma', 'Verma', 'Yadav', 'Singh', 'Gupta', 'Mishra', 'Tiwari', 'Chauhan', 'Pandey', 'Rathore'];
const LAST_S = ['Gowda', 'Shetty', 'Rao', 'Reddy', 'Naidu', 'Iyer', 'Nair', 'Menon', 'Murthy', 'Pillai', 'Hegde'];
const LAST_E = ['Das', 'Ghosh', 'Banerjee', 'Chatterjee', 'Mondal', 'Sarkar', 'Bose', 'Mahato'];
const LAST_W = ['Patil', 'Desai', 'Joshi', 'Kulkarni', 'Shah', 'Patel', 'Jadhav', 'More', 'Deshmukh'];
const NAME_ZONES = {
  north: [FIRST_N, LAST_N], south: [FIRST_S, LAST_S], east: [FIRST_E, LAST_E], west: [FIRST_W, LAST_W],
};
const STATE_ZONE = {
  'Kerala': 'south', 'Tamil Nadu': 'south', 'Karnataka': 'south', 'Andhra Pradesh': 'south',
  'Telangana': 'south', 'Puducherry': 'south', 'Lakshadweep': 'south',
  'West Bengal': 'east', 'Odisha': 'east', 'Bihar': 'east', 'Jharkhand': 'east', 'Assam': 'east',
  'Tripura': 'east', 'Meghalaya': 'east', 'Manipur': 'east', 'Mizoram': 'east', 'Nagaland': 'east',
  'Arunachal Pradesh': 'east', 'Sikkim': 'east', 'Andaman and Nicobar Islands': 'east',
  'Maharashtra': 'west', 'Gujarat': 'west', 'Goa': 'west', 'Rajasthan': 'west',
  'Dadra and Nagar Haveli and Daman and Diu': 'west',
};
const nameFor = (state) => {
  const [F, L] = NAME_ZONES[STATE_ZONE[state] || 'north'];
  return pick(F) + ' ' + pick(L);
};

const pad = (n, w) => String(n).padStart(w, '0');
const CAT_CODE = { FIR: 1, UDR: 3, PAR: 4, 'Zero FIR': 8 };

// Police stations per district, scaled by population (metros get more).
DISTRICTS.forEach((d) => {
  const n = Math.max(3, Math.min(14, Math.round(Math.log10(Math.max(d.pop, 1e5)) * 2.2)));
  d.stations = Array.from({ length: n }, (_, i) => `${d.district} PS-${i + 1}`);
});

// ---------------- ETAS simulation ----------------
// Scale real intensity down to the requested target volume. Offspring (near-repeat)
// cascades multiply the background count, so back it out of the background rate.
const AVG_BRANCH = HEADS.reduce((a, h) => a + h[1] * h[2], 0);
const bgTarget = TARGET_CASES / (1 + AVG_BRANCH + AVG_BRANCH * AVG_BRANCH);
const SCALE = bgTarget / (TOTAL_INTENSITY * YEARS_SPAN);

console.log(`All-India ETAS simulation`);
console.log(`  districts=${DISTRICTS.length}  states=${new Set(DISTRICTS.map((d) => d.state)).size}`);
console.log(`  window=${new Date(START).toISOString().slice(0, 10)} .. ${new Date(END).toISOString().slice(0, 10)} (${YEARS_SPAN}y)`);
console.log(`  real all-India intensity=${Math.round(TOTAL_INTENSITY).toLocaleString('en-IN')} cases/yr -> target=${TARGET_CASES.toLocaleString('en-IN')} (scale=${SCALE.toExponential(2)})`);

const headShares = HEADS.map((h) => h[1]);
const events = [];
let eid = 0;

for (let di = 0; di < DISTRICTS.length; di++) {
  const d = DISTRICTS[di];
  const cal = STATE_CAL.get(d.state);
  // State severity tilt: states with high violent rates skew toward body offences.
  const violentTilt = Math.min(2.0, Math.max(0.5, cal.violentRate / ncrb.india.violentRate));
  // Background shares are de-biased by (1 - rho): heads with strong self-excitation
  // multiply themselves through the cascade, so seeding them at their target share
  // would overshoot it. Violent heads are then tilted by the state's real violent
  // rate; normalisation below absorbs the difference across the remaining heads.
  const localShares = headShares.map((s, hi) => {
    const head = HEADS[hi][0];
    const deBiased = s * (1 - HEADS[hi][2]);
    if (head === 'Body Offences' || head === 'Crime Against Women') return deBiased * violentTilt;
    return deBiased;
  });
  const expectedTotal = d.intensity * YEARS_SPAN * SCALE;
  for (let hi = 0; hi < HEADS.length; hi++) {
    const shareSum = localShares.reduce((a, b) => a + b, 0);
    const n = poisson(expectedTotal * (localShares[hi] / shareSum));
    for (let k = 0; k < n; k++) {
      let t;
      do { t = START + rand() * (END - START); } while (rand() > envelope(t) / MAXENV);
      events.push({
        id: eid++, t, di, hi,
        lat: d.lat + gauss(0, d.spread), lng: d.lng + gauss(0, d.spread * 0.9), gen: 0,
      });
    }
  }
}
const bgCount = events.length;

// Self-excitation cascade (near-repeat victimisation / retaliation).
let cursor = 0;
while (cursor < events.length) {
  const p = events[cursor++];
  const [, , rho, meanDelay, sig] = HEADS[p.hi];
  const kids = poisson(rho);
  for (let j = 0; j < kids; j++) {
    const t = p.t - meanDelay * DAY * Math.log(Math.max(rand(), 1e-9));
    if (t >= END) continue;
    const hi = chance(0.85) ? p.hi : Math.floor(rand() * HEADS.length);
    events.push({
      id: eid++, t, di: p.di, hi,
      lat: p.lat + gauss(0, sig), lng: p.lng + gauss(0, sig), gen: p.gen + 1,
    });
  }
}
events.sort((a, b) => a.t - b.t);
console.log(`  background=${bgCount.toLocaleString('en-IN')}  total=${events.length.toLocaleString('en-IN')}  near-repeat=${((1 - bgCount / events.length) * 100).toFixed(1)}%`);

// ---------------- offenders & organized rings ----------------
// Offender pools are per-state so co-offending networks stay geographically coherent.
const statesList = [...new Set(DISTRICTS.map((d) => d.state))];
const offendersByState = {};
const ringsByState = {};
let ringSeq = 0;
for (const st of statesList) {
  const stDistricts = DISTRICTS.filter((d) => d.state === st);
  const stEvents = events.filter((e) => DISTRICTS[e.di].state === st).length;
  const nOff = Math.max(40, Math.round(stEvents * 0.06));
  const pool = Array.from({ length: nOff }, () => ({ name: nameFor(st), ring: 0, age: randint(18, 58) }));
  offendersByState[st] = pool;
  // Rings scale with state volume: bigger states host more organized groups.
  const nRings = Math.max(1, Math.min(12, Math.round(stEvents / 4000)));
  const rings = [];
  for (let r = 0; r < nRings; r++) {
    ringSeq += 1;
    const members = [];
    const size = randint(6, 18);
    for (let m = 0; m < size; m++) { const o = pick(pool); o.ring = ringSeq; members.push(o); }
    const bursts = [];
    for (let b = 0; b < randint(1, 3); b++) {
      const s = START + rand() * (END - START - 60 * DAY);
      bursts.push([s, s + randint(20, 90) * DAY]);
    }
    rings.push({ ring: ringSeq, members, bursts, district: pick(stDistricts).district });
  }
  ringsByState[st] = rings;
}

// ---------------- assemble records ----------------
console.log('Assembling case, person, network and risk records…');
const OCC = ['Farmer', 'Daily Wage', 'Business', 'Student', 'IT Professional', 'Unemployed', 'Govt Employee', 'Driver', 'Shopkeeper', 'Homemaker', 'Factory Worker', 'Teacher'];
const REL = ['Hindu', 'Muslim', 'Christian', 'Sikh', 'Buddhist', 'Jain', 'Other'];
const CASTE = ['General', 'OBC', 'SC', 'ST', 'Not Recorded'];

const Cases = [], Accused = [], Victims = [], Complainants = [], Arrests = [], FinancialTxns = [];
let aId = 1, vId = 1, cpId = 1, arrId = 1, txnId = 1;
const serial = {};
const accusedByCase = new Map();
const offenderStats = new Map();

/** Case status drawn from the state's real chargesheet + conviction rates. */
function statusFor(cal, ageDays) {
  // Young cases are still under investigation; older ones have progressed.
  const matured = Math.min(1, ageDays / 420);
  if (rand() > matured) return 'Under Investigation';
  const cs = cal.chargesheetRate / 100;
  if (rand() > cs) return chance(0.6) ? 'Closed - Undetected' : 'Under Investigation';
  // Chargesheeted -> trial outcomes governed by conviction rate.
  const cv = cal.convictionRate / 100;
  const r = rand();
  if (r < 0.42) return 'Pending Trial';
  return rand() < cv ? 'Convicted' : 'Acquitted';
}

for (let idx = 0; idx < events.length; idx++) {
  const ev = events[idx];
  const d = DISTRICTS[ev.di];
  const cal = STATE_CAL.get(d.state);
  const cid = idx + 1;
  const head = HEADS[ev.hi][0];
  const dt = new Date(ev.t);
  const year = dt.getUTCFullYear(), month = dt.getUTCMonth() + 1;

  // Sub-head choice tilted by the state's real head-specific rates.
  const subs = SUBHEADS[head];
  let sub;
  if (head === 'Body Offences') {
    const w = subs.map((s) => (s === 'Murder' ? cal.murder : s === 'Kidnapping' ? cal.kidnapping : 3));
    sub = subs[weightedIndex(w)];
  } else if (head === 'Crime Against Women') {
    const w = subs.map((s) => (s === 'Rape' ? cal.rape : 4));
    sub = subs[weightedIndex(w)];
  } else if (head === 'Property Offences') {
    const w = subs.map((s) => (s === 'Robbery' || s === 'Dacoity' ? Math.max(0.3, cal.robberyDacoity) : 5));
    sub = subs[weightedIndex(w)];
  } else {
    sub = pick(subs);
  }

  const gravity = HEINOUS_SUBS.has(sub) ? 'Heinous'
    : (head === 'Economic Offences' || head === 'Cyber Crime') ? 'Economic' : 'Non-Heinous';
  const cat = chance(0.84) ? 'FIR' : pick(['UDR', 'PAR', 'Zero FIR']);
  const station = pick(d.stations);
  const stationIdx = d.stations.indexOf(station) + 1;
  const sKey = `${ev.di}-${year}`;
  serial[sKey] = (serial[sKey] || 0) + 1;
  const crimeNo = `${CAT_CODE[cat]}${pad((ev.di % 9999) + 1, 4)}${pad(stationIdx, 4)}${year}${pad(serial[sKey], 5)}`;
  const ageDays = (END - ev.t) / DAY;

  // ---- accused (organized ring during active bursts, else pool/one-off) ----
  const pool = offendersByState[d.state];
  const activeRings = (ringsByState[d.state] || []).filter(
    (rg) => rg.district === d.district && rg.bursts.some(([a, b]) => ev.t >= a && ev.t <= b));
  const organizedHead = head === 'Property Offences' || head === 'Economic Offences' || head === 'Narcotics';
  const useRing = activeRings.length > 0 && organizedHead && chance(0.6);
  const nA = head === 'Public Order' ? randint(2, 6) : head === 'Traffic & Negligence' ? 1 : randint(1, 3);
  const caseAcc = [];
  for (let a = 0; a < nA; a++) {
    const off = useRing ? pick(pick(activeRings).members)
      : chance(0.55) ? pick(pool) : { name: nameFor(d.state), ring: 0, age: randint(18, 58) };
    Accused.push({
      AccusedMasterID: aId++, CaseMasterID: cid, CrimeNo: crimeNo, AccusedName: off.name,
      AgeYear: off.age || randint(18, 58), Gender: chance(0.91) ? 'M' : 'F', PersonID: 'A' + (a + 1),
      RingID: off.ring || 0, DistrictName: d.district, CrimeSubHead: sub,
    });
    caseAcc.push(off.name);
    const st = offenderStats.get(off.name) || { total: 0, violent: 0, ring: 0, state: d.state };
    st.total++; if (gravity === 'Heinous') st.violent++; if (off.ring) st.ring = off.ring;
    offenderStats.set(off.name, st);
  }
  accusedByCase.set(cid, caseAcc);

  const nV = (head === 'Body Offences' || head === 'Crime Against Women') ? randint(1, 2)
    : head === 'Traffic & Negligence' ? randint(1, 3) : randint(0, 1);
  for (let v = 0; v < nV; v++) {
    Victims.push({
      VictimMasterID: vId++, CaseMasterID: cid, VictimName: nameFor(d.state),
      AgeYear: randint(3, 82), Gender: head === 'Crime Against Women' ? 'F' : (chance(0.5) ? 'M' : 'F'),
    });
  }

  Complainants.push({
    ComplainantID: cpId++, CaseMasterID: cid, ComplainantName: nameFor(d.state),
    AgeYear: randint(18, 74), Gender: chance(0.58) ? 'M' : 'F',
    Occupation: pick(OCC), Religion: pick(REL), Caste: pick(CASTE),
  });

  // Arrest likelihood tracks the state's chargesheet rate.
  if (rand() < cal.chargesheetRate / 100 * 0.8) {
    Arrests.push({
      ArrestID: arrId++, CaseMasterID: cid, AccusedMasterID: 0, AccusedName: pick(caseAcc),
      ArrestType: chance(0.85) ? 'Arrest' : 'Surrender',
      ArrestDate: new Date(ev.t + randint(0, 30) * DAY).toISOString().slice(0, 10),
      DistrictName: d.district, IOName: nameFor(d.state),
    });
  }

  if (head === 'Economic Offences' || head === 'Cyber Crime') {
    for (let t = 0, nT = randint(2, 6); t < nT; t++) {
      // Log-uniform amounts: many small frauds, a few very large ones.
      const amount = Math.round(Math.exp(Math.log(3000) + rand() * (Math.log(9e6) - Math.log(3000))));
      FinancialTxns.push({
        TxnID: txnId++, AccusedMasterID: 0, AccusedName: pick(caseAcc),
        Counterparty: nameFor(d.state), Amount: amount,
        TxnDate: new Date(ev.t + randint(0, 20) * DAY).toISOString().slice(0, 19).replace('T', ' '),
        AccountRef: 'AC' + randint(10000000, 99999999),
      });
    }
  }

  Cases.push({
    CaseMasterID: cid, CrimeNo: crimeNo, CaseNo: `${year}${pad(serial[sKey], 5)}`,
    CrimeRegisteredDate: dt.toISOString().slice(0, 10), Year: year, CrimeMonth: month,
    IncidentDate: dt.toISOString().slice(0, 19).replace('T', ' '),
    StateName: d.state, DistrictName: d.district, StationName: station,
    latitude: +ev.lat.toFixed(5), longitude: +ev.lng.toFixed(5),
    CaseCategory: cat, Gravity: gravity, CrimeHead: head, CrimeSubHead: sub,
    CaseStatus: statusFor(cal, ageDays),
    CourtName: `${d.district} District & Sessions Court`, OfficerName: nameFor(d.state),
    ActsSections: ACTS[sub] || 'BNS 3', AccusedCount: nA, VictimCount: nV,
    BriefFacts: `A case of ${sub.toLowerCase()} was registered at ${station}, ${d.district} (${d.state}). `
      + `Investigation initiated under ${ACTS[sub] || 'BNS 3'}; scene examined and evidence collected.`,
    _t: ev.t,
  });
}
console.log(`  cases=${Cases.length.toLocaleString('en-IN')} accused=${Accused.length.toLocaleString('en-IN')} victims=${Victims.length.toLocaleString('en-IN')} txns=${FinancialTxns.length.toLocaleString('en-IN')}`);

// ---------------- co-accused graph + offender risk ----------------
const edges = new Map();
for (const [, names] of accusedByCase) {
  const uniq = [...new Set(names)];
  for (let i = 0; i < uniq.length; i++) {
    for (let j = i + 1; j < uniq.length; j++) {
      const [x, y] = [uniq[i], uniq[j]].sort();
      const k = x + '||' + y;
      const e = edges.get(k) || { AccusedA: x, AccusedB: y, SharedCases: 0 };
      e.SharedCases++;
      edges.set(k, e);
    }
  }
}
const ringByName = new Map();
for (const st of statesList) for (const o of offendersByState[st]) if (o.ring) ringByName.set(o.name, o.ring);

const CoAccusedLinks = [...edges.values()]
  .sort((a, b) => b.SharedCases - a.SharedCases)
  .map((e, i) => ({
    LinkID: i + 1, AccusedA: e.AccusedA, AccusedB: e.AccusedB, SharedCases: e.SharedCases,
    RingID: ringByName.get(e.AccusedA) || ringByName.get(e.AccusedB) || 0,
  }));

const OffenderRisk = [...offenderStats.entries()]
  .filter(([, s]) => s.total >= 2)
  .map(([name, s]) => {
    const score = Math.min(100, Math.round(s.total * 5 + s.violent * 11 + (s.ring ? 18 : 0)));
    return {
      OffenderRiskID: 0, AccusedName: name, TotalCases: s.total, ViolentCases: s.violent,
      RingID: s.ring || 0, RiskScore: score,
      RiskBand: score >= 70 ? 'High' : score >= 40 ? 'Medium' : 'Low',
      Factors: `${s.total} cases; ${s.violent} violent${s.ring ? '; organized-ring member' : ''}; ${s.state}`,
    };
  })
  .sort((a, b) => b.RiskScore - a.RiskScore)
  .map((r, i) => ({ ...r, OffenderRiskID: i + 1 }));

// ---------------- CSV output ----------------
function writeCsv(dir, name, rows) {
  const file = path.join(dir, name + '.csv');
  if (!rows.length) { fs.writeFileSync(file, ''); console.log(`  ${name}.csv  ->  0 rows`); return; }
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    if (v === null || v === undefined) v = '';
    v = String(v);
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  // Stream in chunks so multi-hundred-thousand-row tables never build one huge string.
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, cols.join(',') + '\n');
  const CHUNK = 5000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    let buf = '';
    for (const r of rows.slice(i, i + CHUNK)) buf += cols.map((c) => esc(r[c])).join(',') + '\n';
    fs.writeSync(fd, buf);
  }
  fs.closeSync(fd);
  console.log(`  ${name}.csv  ->  ${rows.length.toLocaleString('en-IN')} rows`);
}

const casesOut = Cases.map(({ _t, ...rest }) => rest);
console.log('\nWriting app tables (datastore/seed):');
writeCsv(SEED_DIR, 'Cases', casesOut);
writeCsv(SEED_DIR, 'Accused', Accused);
writeCsv(SEED_DIR, 'Victims', Victims);
writeCsv(SEED_DIR, 'Complainants', Complainants);
writeCsv(SEED_DIR, 'Arrests', Arrests);
writeCsv(SEED_DIR, 'CoAccusedLinks', CoAccusedLinks);
writeCsv(SEED_DIR, 'OffenderRisk', OffenderRisk);
writeCsv(SEED_DIR, 'FinancialTxns', FinancialTxns);

// District reference for the backend (centroids for the all-India hotspot map).
const districtRef = DISTRICTS.map((d) => ({
  state: d.state, district: d.district, lat: d.lat, lng: d.lng, population: d.pop, stateCrimeRate: d.rate,
}));
fs.writeFileSync(path.join(REF_DIR, 'india_districts.json'), JSON.stringify(districtRef, null, 0));
console.log(`  ref/india_districts.json  ->  ${districtRef.length} districts`);
// The API function needs the same centroids to place districts/states on the map.
const apiRef = path.join(__dirname, '..', 'functions', 'api', 'ref');
fs.mkdirSync(apiRef, { recursive: true });
fs.writeFileSync(path.join(apiRef, 'india_districts.json'), JSON.stringify(districtRef, null, 0));
console.log(`  functions/api/ref/india_districts.json  ->  ${districtRef.length} districts`);

// ---------------- quality report ----------------
const byState = {};
for (const c of casesOut) byState[c.StateName] = (byState[c.StateName] || 0) + 1;
const byHead = {};
for (const c of casesOut) byHead[c.CrimeHead] = (byHead[c.CrimeHead] || 0) + 1;
const byStatus = {};
for (const c of casesOut) byStatus[c.CaseStatus] = (byStatus[c.CaseStatus] || 0) + 1;
const byYear = {};
for (const c of casesOut) byYear[c.Year] = (byYear[c.Year] || 0) + 1;
const heinous = casesOut.filter((c) => c.Gravity === 'Heinous').length;

console.log('\n──────── CALIBRATION / QUALITY REPORT ────────');
console.log(`Total cases       : ${casesOut.length.toLocaleString('en-IN')}`);
console.log(`Near-repeat share : ${((1 - bgCount / events.length) * 100).toFixed(1)}%  (literature: 20-45%)`);
console.log(`Heinous share     : ${(heinous / casesOut.length * 100).toFixed(1)}%`);
console.log(`States/UTs covered: ${Object.keys(byState).length}   Districts: ${new Set(casesOut.map((c) => c.DistrictName)).size}`);

console.log('\nTop 8 states by volume (vs real NCRB 2023 rate/lakh):');
Object.entries(byState).sort((a, b) => b[1] - a[1]).slice(0, 8).forEach(([s, n]) => {
  console.log(`  ${s.padEnd(18)} ${String(n).padStart(7)}  (real rate ${STATE_CAL.get(s).crimeRate}/lakh)`);
});
console.log('\nLowest 5 states by volume:');
Object.entries(byState).sort((a, b) => a[1] - b[1]).slice(0, 5).forEach(([s, n]) => {
  console.log(`  ${s.padEnd(18)} ${String(n).padStart(7)}  (real rate ${STATE_CAL.get(s).crimeRate}/lakh)`);
});

console.log('\nCrime-head mix:');
HEADS.forEach(([h, share]) => {
  const obs = ((byHead[h] || 0) / casesOut.length * 100).toFixed(1);
  console.log(`  ${h.padEnd(22)} obs ${obs}%  target ${(share * 100).toFixed(0)}%`);
});
console.log('\nCase status mix:');
Object.entries(byStatus).sort((a, b) => b[1] - a[1]).forEach(([s, n]) => {
  console.log(`  ${s.padEnd(22)} ${(n / casesOut.length * 100).toFixed(1)}%`);
});
console.log('\nCases per year:');
Object.keys(byYear).sort().forEach((y) => console.log(`  ${y}: ${byYear[y].toLocaleString('en-IN')}`));

// Per-state outcome fidelity check: does generated conviction share track NCRB?
console.log('\nOutcome fidelity (generated vs NCRB conviction rate), sample:');
['Kerala', 'West Bengal', 'Uttar Pradesh', 'Karnataka', 'Delhi'].forEach((s) => {
  const rows = casesOut.filter((c) => c.StateName === s);
  const tried = rows.filter((c) => c.CaseStatus === 'Convicted' || c.CaseStatus === 'Acquitted').length;
  const conv = rows.filter((c) => c.CaseStatus === 'Convicted').length;
  if (!tried) return;
  console.log(`  ${s.padEnd(16)} generated ${(conv / tried * 100).toFixed(0)}%  NCRB ${STATE_CAL.get(s).convictionRate}%`);
});
console.log('──────────────────────────────────────────────');
console.log('DONE.  Load with:  node datastore/load.js');
