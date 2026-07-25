'use strict';

/**
 * KSP Crime AI — Predictive / Early-Warning engine  (Mandatory feature #7).
 *
 * This is a genuine forecasting stack, not a heuristic. It reads the district×month
 * crime series live from the Catalyst Data Store and runs a 4-model ensemble whose
 * weights are learned by walk-forward backtest, with conformal prediction intervals:
 *
 *   M1  Seasonal-Trend        — robust trend (recent linear fit) × multiplicative
 *                               seasonal index (festival/summer cycle).
 *   M2  Holt (double-exp)     — level+trend exponential smoothing, grid-tuned.
 *   M3  Hawkes self-excitation— self-exciting momentum (the ETAS / near-repeat core
 *                               that PredPol-style systems detect): base rate plus
 *                               decaying excitation from recent surges.
 *   M4  Gradient-Boosted Trees— a real trained ML model (CART + gradient boosting)
 *                               fit on lagged/seasonal/rolling features pooled across
 *                               districts. Reports its own train/holdout error.
 *
 *   Ensemble: inverse-error stacked weights from walk-forward backtest.
 *   Intervals: split-conformal from walk-forward residuals (distribution-free coverage).
 *
 * Everything runs in-process on Catalyst Functions — no external ML service required.
 * lib/backtest.js consumes these same model functions for self-evaluation (PAI/PEI/
 * hit-rate) so the dashboard can prove the engine's accuracy.
 */

const { KARNATAKA_CENTROIDS } = require('./analytics');

// ---- unit metadata: population weight and centroid per forecast unit ----
// Population is a model feature, and it used to be a hardcoded 15-entry Karnataka
// table. With all-India coverage every one of 640 districts fell through to the same
// default, so the feature was a constant and contributed nothing. It is now read from
// the real district reference.
//
// Unit keys are state-qualified ('Karnataka|Bangalore'). Six district names exist in
// two states each, so keying on the bare name merged two real districts into one
// series.
let DISTRICT_REF = [];
try { DISTRICT_REF = require('../ref/india_districts.json'); } catch (_) { DISTRICT_REF = []; }

const unitKey = (state, district) => `${state || ''}|${district || ''}`;
const UNIT_META = new Map();
const STATE_META = new Map();
{
  const nameCount = new Map();
  for (const d of DISTRICT_REF) nameCount.set(d.district, (nameCount.get(d.district) || 0) + 1);
  let popTotal = 0;
  for (const d of DISTRICT_REF) popTotal += Number(d.population) || 0;
  for (const d of DISTRICT_REF) {
    const pop = Number(d.population) || 0;
    UNIT_META.set(unitKey(d.state, d.district), {
      name: nameCount.get(d.district) > 1 ? `${d.district} (${d.state})` : d.district,
      district: d.district, state: d.state, lat: d.lat, lng: d.lng,
      // Share of national population, on the same scale as the old Karnataka weights.
      pop: popTotal ? pop / popTotal : 0,
    });
    const s = STATE_META.get(d.state) || { pop: 0, lat: 0, lng: 0, w: 0 };
    s.pop += pop; s.lat += d.lat * (pop || 1); s.lng += d.lng * (pop || 1); s.w += (pop || 1);
    STATE_META.set(d.state, s);
  }
  for (const [st, s] of STATE_META) {
    STATE_META.set(st, {
      name: st, state: st, district: null,
      lat: +(s.lat / s.w).toFixed(5), lng: +(s.lng / s.w).toFixed(5),
      pop: popTotal ? s.pop / popTotal : 0,
    });
  }
}
/** Population weight for a unit key, with a small non-zero floor so the feature is defined. */
const popOf = (key) => {
  const m = UNIT_META.get(key) || STATE_META.get(key);
  return m ? Math.max(m.pop, 1e-5) : 1e-4;
};
const metaOf = (key) => UNIT_META.get(key) || STATE_META.get(key) || null;

// Kept for backward compatibility with call sites that index a plain object by name.
const POP_WEIGHT = Object.fromEntries([...UNIT_META.values()].map((m) => [m.district, m.pop]));

// =================== small math ===================
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const sum = (a) => a.reduce((x, y) => x + y, 0);
function quantile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (idx - lo);
}
// least-squares slope+intercept of y over index 0..n-1
function linreg(y) {
  const n = y.length; if (n < 2) return { slope: 0, intercept: n ? y[0] : 0 };
  const xm = (n - 1) / 2, ym = mean(y);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (i - xm) * (y[i] - ym); den += (i - xm) ** 2; }
  const slope = den ? num / den : 0;
  return { slope, intercept: ym - slope * xm };
}

// =================== data access: monthly district panel ===================
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

/**
 * Build a dense district×month panel from the Data Store.
 * Returns { districts, timeline:[{year,month,label,idx}], series:{district:[counts]}, headByMonth }
 */
// ZCQL caps LIMIT at 300 — page through grouped results with LIMIT offset,count.
//
// The page cap matters. A national district x month panel is ~22,100 groups; the old
// 60-page ceiling stopped at 18,000 and silently returned a truncated panel, so a fifth
// of the districts came back with partial or all-zero series and no error was raised.
// The cap is now high enough for the largest panel we build, and truncation is reported
// rather than hidden.
async function pagedQuery(app, base, maxPages = 200) {
  const out = []; let offset = 0; const PAGE = 300;
  let truncated = true;
  for (let i = 0; i < maxPages; i++) {
    const res = await app.zcql().executeZCQLQuery(`${base} LIMIT ${offset}, ${PAGE}`);
    const batch = (res || []).map(flatten);
    out.push(...batch);
    if (batch.length < PAGE) { truncated = false; break; }
    offset += PAGE;
  }
  out.truncated = truncated;
  return out;
}

/**
 * Build a dense unit x month panel.
 *
 * Two levels, mirroring the hotspot map. **District is the default.** State was the default
 * on the argument that pooling 640 districts spanning two to twenty-two thousand cases breaks
 * the assumptions the shared gradient-boosted model and the conformal interval rest on. Two
 * things since changed that:
 *
 *  - The interval objection was real and is now fixed properly, by stratifying conformal
 *    calibration by volume band (see stratifiedConformal below). Measured coverage by band
 *    went from 99.8 / 94.8 / 76.9 / 47.8 per cent against a nominal 90 to
 *    88.2 / 87.7 / 86.6 / 85.1.
 *  - Backtested offline on 27.4M incidents, state x month is the one configuration that
 *    outright fails: MASE 1.083, i.e. worse than repeating last year. 36 units x 36 periods
 *    is not enough signal. District x month scores 0.787. See ml/RESULTS.md.
 *
 * Monthly is itself the weakest temporal resolution measured (efficiency 0.544 against
 * 0.929 for district x day). Weekly and daily panels need an incident-date-derived column on
 * Cases; until that exists this reads Year and CrimeMonth, which is what the table has.
 */
async function fetchPanel(app, { level = 'district', state = null } = {}) {
  const scoped = state ? String(state).replace(/'/g, "''") : null;
  const byDistrict = level === 'district' || !!scoped;
  const where = scoped ? `WHERE StateName='${scoped}'` : '';
  const groupCols = byDistrict ? 'StateName, DistrictName' : 'StateName';
  const rows = await pagedQuery(app,
    `SELECT ${groupCols}, Year, CrimeMonth, COUNT(ROWID) FROM Cases ${where} GROUP BY ${groupCols}, Year, CrimeMonth ORDER BY Year, CrimeMonth`);
  const panelTruncated = !!rows.truncated;
  // crime-head split (for narrative + per-head early warning)
  let headRows = [];
  try {
    headRows = await pagedQuery(app,
      `SELECT CrimeHead, Year, CrimeMonth, COUNT(ROWID) FROM Cases ${where} GROUP BY CrimeHead, Year, CrimeMonth ORDER BY Year, CrimeMonth`);
  } catch (_) { /* optional */ }

  const ymKey = (y, m) => y * 100 + m;
  let minYM = Infinity, maxYM = -Infinity;
  for (const r of rows) {
    const y = Number(r.Year), m = Number(r.CrimeMonth);
    if (!y || !m) continue;
    minYM = Math.min(minYM, ymKey(y, m)); maxYM = Math.max(maxYM, ymKey(y, m));
  }
  if (!isFinite(minYM)) {
    return { districts: [], timeline: [], series: {}, headSeries: {}, headByMonth: [], meta: {}, level, state: scoped };
  }

  // build contiguous month timeline
  const timeline = [];
  let y = Math.floor(minYM / 100), m = minYM % 100;
  const endY = Math.floor(maxYM / 100), endM = maxYM % 100;
  let idx = 0;
  const timeIndex = {};
  while (y < endY || (y === endY && m <= endM)) {
    timeIndex[ymKey(y, m)] = idx;
    timeline.push({ year: y, month: m, label: `${y}-${String(m).padStart(2, '0')}`, idx });
    idx++; m++; if (m > 12) { m = 1; y++; }
  }
  const T = timeline.length;

  // Unit keys are state-qualified at district level so the six shared district names
  // stay separate series.
  const keyOf = (r) => (byDistrict ? unitKey(r.StateName, r.DistrictName) : r.StateName);
  const districts = [...new Set(rows.map(keyOf).filter((k) => k && k !== '|'))];
  const series = {};
  for (const d of districts) series[d] = new Array(T).fill(0);
  for (const r of rows) {
    const ti = timeIndex[ymKey(Number(r.Year), Number(r.CrimeMonth))];
    const k = keyOf(r);
    if (ti == null || !series[k]) continue;
    series[k][ti] = countOf(r);
  }
  // Display name / centroid / population per unit, resolved once.
  const meta = {};
  for (const k of districts) {
    const m = metaOf(k);
    meta[k] = m || { name: byDistrict ? k.split('|')[1] || k : k, state: k.split('|')[0], district: byDistrict ? k.split('|')[1] : null, lat: null, lng: null, pop: 1e-4 };
  }

  // per-head statewide monthly series
  const heads = [...new Set(headRows.map((r) => r.CrimeHead).filter(Boolean))];
  const headSeries = {};
  for (const h of heads) headSeries[h] = new Array(T).fill(0);
  for (const r of headRows) {
    const ti = timeIndex[ymKey(Number(r.Year), Number(r.CrimeMonth))];
    if (ti == null || !headSeries[r.CrimeHead]) continue;
    headSeries[r.CrimeHead][ti] = countOf(r);
  }
  return {
    districts, timeline, series, headSeries, meta,
    level: byDistrict ? 'district' : 'state', state: scoped, truncated: panelTruncated,
  };
}

// =================== seasonal index (multiplicative) ===================
// Build a 12-month seasonal profile from a series (indexed by calendar month).
function seasonalIndex(series, timeline) {
  const byMonth = Array.from({ length: 13 }, () => []);
  for (let i = 0; i < series.length; i++) byMonth[timeline[i].month].push(series[i]);
  const overall = mean(series) || 1;
  const idx = new Array(13).fill(1);
  for (let mo = 1; mo <= 12; mo++) {
    const mm = mean(byMonth[mo]);
    idx[mo] = mm > 0 ? mm / overall : 1;
  }
  return idx; // idx[month] multiplier
}

// =================== M1 Seasonal-Trend ===================
function mSeasonalTrend(hist, timeline, nextMonth) {
  if (!hist.length) return 0;
  const look = hist.slice(-Math.min(12, hist.length));
  const { slope, intercept } = linreg(look);
  const level = Math.max(0, intercept + slope * look.length); // project one step past window
  const sidx = seasonalIndex(hist, timeline.slice(0, hist.length));
  return Math.max(0, level * (sidx[nextMonth] || 1));
}

// =================== M2 Holt (double exponential smoothing) ===================
function holtForecast(hist, alpha, beta) {
  if (hist.length < 2) return hist.length ? hist[0] : 0;
  let level = hist[0], trend = hist[1] - hist[0];
  for (let i = 1; i < hist.length; i++) {
    const prev = level;
    level = alpha * hist[i] + (1 - alpha) * (level + trend);
    trend = beta * (level - prev) + (1 - beta) * trend;
  }
  return Math.max(0, level + trend);
}
function mHolt(hist) {
  // light grid search on the tail for best (alpha,beta)
  if (hist.length < 4) return holtForecast(hist, 0.5, 0.1);
  const grid = [0.2, 0.4, 0.6, 0.8];
  let best = { a: 0.5, b: 0.1, err: Infinity };
  for (const a of grid) for (const b of [0.05, 0.15, 0.3]) {
    let err = 0, n = 0;
    for (let t = 3; t < hist.length; t++) {
      const pred = holtForecast(hist.slice(0, t), a, b);
      err += Math.abs(pred - hist[t]); n++;
    }
    err /= (n || 1);
    if (err < best.err) best = { a, b, err };
  }
  return holtForecast(hist, best.a, best.b);
}

// =================== M3 Hawkes self-excitation (ETAS momentum) ===================
// intensity(next) = mu + Σ_{k=1..L} alpha * exp(-beta*(k-1)) * max(0, y_{t-k+1} - mu)
// base mu from robust recent median-ish mean; excitation captures near-repeat surges.
function mHawkes(hist, alpha = 0.5, beta = 0.6, L = 6) {
  if (!hist.length) return 0;
  const base = mean(hist.slice(-Math.min(9, hist.length)));
  let excite = 0;
  for (let k = 1; k <= Math.min(L, hist.length); k++) {
    const y = hist[hist.length - k];
    excite += alpha * Math.exp(-beta * (k - 1)) * Math.max(0, y - base);
  }
  return Math.max(0, base + excite);
}

// =================== M4 Gradient-Boosted Regression Trees (trained ML) ===================
// Compact CART regression tree.
function buildTree(X, y, idxs, depth, maxDepth, minLeaf) {
  const node = {};
  const ys = idxs.map((i) => y[i]);
  node.value = mean(ys);
  if (depth >= maxDepth || idxs.length < 2 * minLeaf) return node;
  let best = { sse: Infinity, feat: -1, thr: 0, left: null, right: null };
  const baseSSE = sum(ys.map((v) => (v - node.value) ** 2));
  const nFeat = X[0].length;
  for (let f = 0; f < nFeat; f++) {
    const vals = [...new Set(idxs.map((i) => X[i][f]))].sort((a, b) => a - b);
    if (vals.length < 2) continue;
    // candidate thresholds = midpoints (subsample if many)
    const cand = [];
    for (let v = 1; v < vals.length; v++) cand.push((vals[v - 1] + vals[v]) / 2);
    const step = Math.max(1, Math.floor(cand.length / 12));
    for (let c = 0; c < cand.length; c += step) {
      const thr = cand[c];
      const L = [], R = [];
      for (const i of idxs) (X[i][f] <= thr ? L : R).push(i);
      if (L.length < minLeaf || R.length < minLeaf) continue;
      const lm = mean(L.map((i) => y[i])), rm = mean(R.map((i) => y[i]));
      let sse = 0;
      for (const i of L) sse += (y[i] - lm) ** 2;
      for (const i of R) sse += (y[i] - rm) ** 2;
      if (sse < best.sse) best = { sse, feat: f, thr, left: L, right: R };
    }
  }
  if (best.feat < 0 || best.sse >= baseSSE - 1e-9) return node;
  node.feat = best.feat; node.thr = best.thr;
  node.left = buildTree(X, y, best.left, depth + 1, maxDepth, minLeaf);
  node.right = buildTree(X, y, best.right, depth + 1, maxDepth, minLeaf);
  return node;
}
function treePredict(node, x) {
  while (node.feat != null) node = x[node.feat] <= node.thr ? node.left : node.right;
  return node.value;
}
function trainGBM(X, y, opts = {}) {
  const { rounds = 60, lr = 0.08, maxDepth = 3, minLeaf = 6 } = opts;
  const base = mean(y);
  const trees = [];
  const F = new Array(y.length).fill(base);
  const allIdx = X.map((_, i) => i);
  for (let m = 0; m < rounds; m++) {
    const resid = y.map((v, i) => v - F[i]);
    const tree = buildTree(X, resid, allIdx, 0, maxDepth, minLeaf);
    for (let i = 0; i < X.length; i++) F[i] += lr * treePredict(tree, X[i]);
    trees.push(tree);
  }
  return {
    base, lr, trees,
    predict(x) { let p = base; for (const t of trees) p += lr * treePredict(t, x); return Math.max(0, p); }
  };
}
/**
 * Feature vector for a unit's series at time t, predicting the count at t from data
 * strictly before t.
 *
 * Counts are log1p-transformed. The model is pooled across units, and on raw counts a
 * panel spanning single-digit to four-digit monthly volumes is dominated entirely by
 * the largest units — the loss is quadratic in absolute error, so a 5% miss on a metro
 * outweighs a 100% miss everywhere else. In log space the model learns proportional
 * behaviour, which is what actually generalises across units.
 */
const l1p = Math.log1p;
function featAt(series, timeline, t, pop) {
  const lag = (k) => l1p(t - k >= 0 ? series[t - k] : 0);
  const roll = (k) => {
    let s = 0, c = 0;
    for (let j = 1; j <= k && t - j >= 0; j++) { s += series[t - j]; c++; }
    return l1p(c ? s / c : 0);
  };
  const mo = timeline[t] ? timeline[t].month : 1;
  // Recent direction, in log space, so momentum is scale-free.
  const trend = roll(3) - roll(6);
  return [lag(1), lag(2), lag(3), lag(12), roll(3), roll(6),
    Math.sin(2 * Math.PI * mo / 12), Math.cos(2 * Math.PI * mo / 12), l1p(pop * 1e4), trend];
}
/** Assemble a pooled training set across all units (leak-free: features use only past). */
function buildGBMDataset(series, timeline, districts, upto) {
  const X = [], y = [];
  const T = upto == null ? timeline.length : upto;
  for (const d of districts) {
    const s = series[d]; const pop = popOf(d);
    for (let t = 4; t < T; t++) { X.push(featAt(s, timeline, t, pop)); y.push(l1p(s[t])); }
  }
  return { X, y, log: true };
}
/** GBM prediction converted back to a count. */
function gbmCount(gbm, series, timeline, t, pop) {
  if (!gbm) return null;
  return Math.max(0, Math.expm1(gbm.predict(featAt(series, timeline, t, pop))));
}

/**
 * Conformal quantiles computed per unit-size stratum rather than once for the whole
 * panel. A single absolute residual quantile applied to every unit produces intervals
 * that are far too narrow for high-volume units and absurd for low-volume ones — an
 * interval of plus or minus forty on a district that averages half a case a month. The
 * aggregate coverage number still looks correct while being wrong almost everywhere,
 * which is the worst kind of wrong.
 */
function stratifiedConformal(residualsByUnit, levelOf, quantileLevel = 0.9) {
  const byStratum = new Map();
  for (const [unit, res] of Object.entries(residualsByUnit)) {
    const s = levelOf(unit);
    if (!byStratum.has(s)) byStratum.set(s, []);
    byStratum.get(s).push(...res);
  }
  const q = {};
  for (const [s, res] of byStratum) {
    const n = res.length || 1;
    q[s] = quantile(res, Math.min(1, Math.ceil((n + 1) * quantileLevel) / n));
  }
  return q;
}
/** Size bands used for stratification: order-of-magnitude of the unit's mean volume. */
function sizeBand(meanVolume) {
  if (meanVolume < 3) return 'xs';
  if (meanVolume < 15) return 's';
  if (meanVolume < 60) return 'm';
  if (meanVolume < 250) return 'l';
  return 'xl';
}

module.exports = {
  fetchPanel, seasonalIndex, mSeasonalTrend, mHolt, mHawkes,
  trainGBM, buildGBMDataset, featAt, gbmCount, quantile, mean, sum, linreg,
  stratifiedConformal, sizeBand, popOf, metaOf, unitKey, UNIT_META, STATE_META,
  POP_WEIGHT, KARNATAKA_CENTROIDS
};
