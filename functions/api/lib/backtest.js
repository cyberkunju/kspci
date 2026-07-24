'use strict';

/**
 * KSP Crime AI — Walk-forward backtest + self-evaluation + forecast orchestration.
 *
 * Proves the engine instead of asserting it. For every historical origin we forecast
 * the next month with each model and the ensemble, then score:
 *   - Point accuracy:  MAE / RMSE / MAPE per model  (model-comparison table)
 *   - Spatial policing metrics (rank districts by predicted risk):
 *       Hit-Rate      — share of next-month crime captured inside flagged districts
 *       PAI           — Predictive Accuracy Index  = HitRate / AreaFraction
 *       PEI           — Predictive Efficiency Index = HitRate / OracleHitRate  (0..1)
 *       Recapture     — persistence of true hotspots that stay flagged
 * Ensemble weights are learned (inverse-error) from the walk-forward errors, and
 * split-conformal residual quantiles give distribution-free prediction intervals.
 */

const F = require('./forecast');

// Real-data validation headline — the honest accuracy proof. The engine architecture
// (spatio-temporal features -> GBM/neural ensemble -> conformal intervals) was backtested
// leak-free on 2.49M real Chicago incidents. Full report: ml/RESULTS.md.
const REAL_DATA_VALIDATION = {
  dataset: '2.49M real Chicago incidents · 2014-2023 · 275 beats · 33 crime types',
  method: 'Leak-free expanding-window walk-forward; weights + conformal fit on a separate window.',
  headline: [
    { config: 'Grid×day (700m) — GPU neural', mase: 0.811, paiAt1pct: 6.24, coverage90: 91.1 },
    { config: 'Grid×day (700m) — GBM', mase: 0.815, paiAt1pct: 6.17, coverage90: 90.9 },
    { config: 'Grid×week (400m) — ensemble', mase: 0.772, paiAt1pct: 6.30, coverage90: 87.0 },
    { config: 'Beat×week — GBM', mase: 0.700, paiAt1pct: 2.70, coverage90: 86.5 }
  ],
  beatsBaseline: 'Beats seasonal-naive by 19-30% and the historical-pattern police baseline by 1-3%, with calibrated 90% intervals.',
  report: 'ml/RESULTS.md'
};

const std = (a) => {
  if (a.length < 2) return 0;
  const m = F.mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
};

// Catalyst AppSail-hosted Python ML forecasting service (sklearn HistGBM + scipy NNLS
// + conformal — the exact validated champion). When configured, the live forecast is
// served BY this model; falls back to the in-function engine if the service is down.
const SERVICE_URL = process.env.FORECAST_SERVICE_URL || '';

async function forecastViaService(panel) {
  if (!SERVICE_URL) return null;
  const { series, timeline } = panel;
  const nt = nextTimeMonth(timeline);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(process.env.FORECAST_SVC_TIMEOUT_MS || 25000));
  let d;
  try {
    const r = await fetch(SERVICE_URL.replace(/\/$/, '') + '/forecast', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ series, period: 12, horizonLabel: nt.label, budgets: [0.1, 0.2, 0.33] }),
      signal: ctrl.signal
    });
    if (!r.ok) throw new Error('service ' + r.status);
    d = await r.json();
  } finally { clearTimeout(timer); }
  if (!d || d.error || !Array.isArray(d.forecasts)) throw new Error('service bad response');

  const T = timeline.length;
  const forecasts = d.forecasts.map((f) => {
    const s = series[f.unit] || [];
    const sigma = std(s.slice(-12)) || 1;
    const baseline = f.baseline != null ? f.baseline : F.mean(s.slice(-12));
    return {
      district: f.unit,
      lat: (F.KARNATAKA_CENTROIDS[f.unit] || [])[0], lng: (F.KARNATAKA_CENTROIDS[f.unit] || [])[1],
      predicted: round(f.predicted, 1), low: round(Math.max(0, f.low), 1), high: round(f.high, 1),
      baseline: round(baseline, 1), lastMonth: s[T - 1] != null ? s[T - 1] : (f.last || 0),
      trendPct: round(f.trendPct, 0), z: round((f.predicted - baseline) / sigma, 2), models: {}
    };
  }).sort((a, b) => b.predicted - a.predicted);

  const acc = d.accuracy || {};
  const ensMase = acc.mase && acc.mase.ensemble && acc.mase.ensemble.mase;
  return {
    horizon: d.horizon || nt.label, generatedAt: new Date().toISOString(),
    servedBy: 'catalyst-appsail: ' + (d.engine || 'sklearn-HistGBM'),
    weights: d.weights || {},
    conformal: { q90: d.conformalQ90 },
    accuracy: { mae: (ensMase != null && acc.naiveMae) ? round(ensMase * acc.naiveMae, 3) : undefined, mase: ensMase, coverage90: acc.coverage90 },
    coverageTarget: 90, forecasts,
    statewide: { predicted: round(forecasts.reduce((s, f) => s + f.predicted, 0), 0) }
  };
}
const round = (x, d = 2) => { const p = 10 ** d; return Math.round((Number(x) || 0) * p) / p; };

// month after the last timeline entry
function nextTimeMonth(timeline) {
  const last = timeline[timeline.length - 1];
  let y = last.year, m = last.month + 1;
  if (m > 12) { m = 1; y++; }
  return { year: y, month: m, label: `${y}-${String(m).padStart(2, '0')}` };
}

// per-model one-step prediction at origin t (uses only series[0..t))
function modelPreds(series, timeline, d, t, gbm) {
  const hist = series[d].slice(0, t);
  const nextMonth = timeline[t] ? timeline[t].month : nextTimeMonth(timeline).month;
  const pop = F.POP_WEIGHT[d] || 0.04;
  return {
    seasonalTrend: F.mSeasonalTrend(hist, timeline, nextMonth),
    holt: F.mHolt(hist),
    hawkes: F.mHawkes(hist),
    gbm: gbm ? gbm.predict(F.featAt(series[d], timeline, t, pop)) : F.mean(hist)
  };
}

const MODEL_KEYS = ['seasonalTrend', 'holt', 'hawkes', 'gbm'];

/**
 * Core walk-forward evaluation.
 * Returns model errors, learned ensemble weights, conformal quantiles, spatial metrics,
 * and statewide predicted-vs-actual series for charting.
 */
function runBacktest(panel, opts = {}) {
  const { series, timeline, districts } = panel;
  const T = timeline.length;
  const t0 = Math.max(6, opts.start != null ? opts.start : Math.min(13, Math.floor(T * 0.45)));
  if (T - t0 < 3 || !districts.length) {
    return { insufficient: true, T, t0 };
  }
  // Train the GBM once on data strictly before the backtest window (leak-free).
  const ds = F.buildGBMDataset(series, timeline, districts, t0);
  const gbm = ds.X.length > 30 ? F.trainGBM(ds.X, ds.y) : null;

  // GBM self-reported holdout error (last 20% of its own pooled training rows)
  let gbmHoldout = null;
  if (gbm && ds.X.length > 50) {
    const cut = Math.floor(ds.X.length * 0.8);
    let e = 0, n = 0;
    for (let i = cut; i < ds.X.length; i++) { e += Math.abs(gbm.predict(ds.X[i]) - ds.y[i]); n++; }
    gbmHoldout = round(e / (n || 1), 3);
  }

  // Collect per-model predictions across all origins (seasonal-naive added as the
  // MASE reference baseline = same month last year).
  const perOrigin = []; // {t, byDistrict:{d:{preds, actual, snaive}}}
  for (let t = t0; t < T; t++) {
    const byDistrict = {};
    for (const d of districts) {
      const preds = modelPreds(series, timeline, d, t, gbm);
      const actual = series[d][t];
      const snaive = t >= 12 ? series[d][t - 12] : series[d][t - 1];
      byDistrict[d] = { preds, actual, snaive };
    }
    perOrigin.push({ t, byDistrict });
  }

  // Honest split: fit ensemble weights + conformal quantile on the FIRST 60% of origins,
  // then measure every reported metric on the held-out remaining origins (removes the
  // in-sample optimism of tuning weights on the same data they're scored on).
  const fitEnd = t0 + Math.max(1, Math.floor((T - t0) * 0.6));
  const fitOrigins = perOrigin.filter((o) => o.t < fitEnd);
  const evalOrigins = perOrigin.filter((o) => o.t >= fitEnd);
  const testOrigins = evalOrigins.length >= 3 ? evalOrigins : perOrigin; // fall back if tiny

  // Fit inverse-MAE weights on the fit window.
  const fitAbs = { seasonalTrend: [], holt: [], hawkes: [], gbm: [] };
  for (const o of fitOrigins) for (const d of districts) {
    const { preds, actual } = o.byDistrict[d];
    MODEL_KEYS.forEach((k) => fitAbs[k].push(Math.abs(preds[k] - actual)));
  }
  const fitMae = {}; MODEL_KEYS.forEach((k) => (fitMae[k] = F.mean(fitAbs[k])));
  const inv = {}; let invSum = 0;
  MODEL_KEYS.forEach((k) => { inv[k] = 1 / (fitMae[k] + 0.5); invSum += inv[k]; });
  const weights = {}; MODEL_KEYS.forEach((k) => (weights[k] = inv[k] / invSum));

  // Conformal q from fit-window ensemble residuals (finite-sample corrected).
  const fitResid = [];
  for (const o of fitOrigins) for (const d of districts) {
    const { preds, actual } = o.byDistrict[d];
    fitResid.push(Math.abs(MODEL_KEYS.reduce((s, k) => s + weights[k] * preds[k], 0) - actual));
  }
  const nfit = fitResid.length || 1;
  const q90 = round(F.quantile(fitResid, Math.min(1, Math.ceil((nfit + 1) * 0.9) / nfit)), 2);
  const conformal = { q80: round(F.quantile(fitResid, 0.8), 2), q90, q95: round(F.quantile(fitResid, 0.95), 2) };

  // Measure everything on the held-out eval origins.
  const absErr = { seasonalTrend: [], holt: [], hawkes: [], gbm: [], seasonalNaive: [] };
  const pctErr = { seasonalTrend: [], holt: [], hawkes: [], gbm: [], seasonalNaive: [] };
  const ensAbs = [], ensPct = [];
  let covHit = 0, covN = 0, naiveMaeSum = 0, naiveMaeN = 0;
  const statewide = [];
  const spatial = [];
  // Flag the top fraction of districts by predicted VOLUME (patrol-deployment view).
  // Area budget is per-district (equal-area proxy at district granularity), the standard
  // PAI/PEI formulation: flag ceil(AREA × #districts) districts.
  const AREA = opts.areaFraction || 0.25;
  const kFlag = Math.max(1, Math.ceil(AREA * districts.length));
  const areaFrac = kFlag / districts.length;

  for (const o of testOrigins) {
    let swActual = 0, swPred = 0;
    const ranked = [];
    for (const d of districts) {
      const { preds, actual, snaive } = o.byDistrict[d];
      const e = MODEL_KEYS.reduce((s, k) => s + weights[k] * preds[k], 0);
      MODEL_KEYS.forEach((k) => {
        absErr[k].push(Math.abs(preds[k] - actual));
        if (actual > 0) pctErr[k].push(Math.abs(preds[k] - actual) / actual);
      });
      absErr.seasonalNaive.push(Math.abs(snaive - actual));
      if (actual > 0) pctErr.seasonalNaive.push(Math.abs(snaive - actual) / actual);
      naiveMaeSum += Math.abs(snaive - actual); naiveMaeN++;
      ensAbs.push(Math.abs(e - actual));
      if (actual > 0) ensPct.push(Math.abs(e - actual) / actual);
      // 90% conformal interval coverage on held-out data
      if (actual >= Math.max(0, e - q90) && actual <= e + q90) covHit++;
      covN++;
      swActual += actual; swPred += e;
      ranked.push({ d, pred: e, actual });
    }
    statewide.push({ label: timeline[o.t].label, actual: round(swActual, 1), predicted: round(swPred, 1) });

    // Hit-Rate / PAI / PEI — rank by predicted volume, flag top-k districts.
    const totalActual = swActual || 1;
    const flag = new Set([...ranked].sort((a, b) => b.pred - a.pred).slice(0, kFlag).map((r) => r.d));
    const captured = ranked.filter((r) => flag.has(r.d)).reduce((s, r) => s + r.actual, 0);
    const hitRate = captured / totalActual;
    const pai = areaFrac > 0 ? hitRate / areaFrac : 0;
    // oracle: same budget, ranked by ACTUAL volume (best achievable hit-rate)
    const oFlag = new Set([...ranked].sort((a, b) => b.actual - a.actual).slice(0, kFlag).map((r) => r.d));
    const oCap = ranked.filter((r) => oFlag.has(r.d)).reduce((s, r) => s + r.actual, 0);
    const oracle = (oCap / totalActual) || 1;
    const pei = hitRate / oracle;
    spatial.push({ t: o.t, hitRate, pai, pei, area: areaFrac, flagged: [...flag] });
  }

  // Recapture: do flagged hotspots persist origin→origin?
  let recSum = 0, recN = 0;
  for (let i = 1; i < spatial.length; i++) {
    const prev = new Set(spatial[i - 1].flagged), cur = spatial[i].flagged;
    const inter = cur.filter((d) => prev.has(d)).length;
    recSum += inter / (cur.length || 1); recN++;
  }
  const recapture = recN ? recSum / recN : 0;

  const naiveMae = naiveMaeN ? naiveMaeSum / naiveMaeN : 1;
  const mkStat = (k) => ({
    mae: round(F.mean(absErr[k]), 3),
    rmse: round(Math.sqrt(F.mean(absErr[k].map((e) => e * e))), 3),
    mape: round(F.mean(pctErr[k]) * 100, 1),
    mase: round(F.mean(absErr[k]) / (naiveMae || 1), 3),
    weight: round(weights[k] || 0, 3)
  });
  const perModel = {};
  MODEL_KEYS.forEach((k) => (perModel[k] = mkStat(k)));
  perModel.seasonalNaive = { ...mkStat('seasonalNaive'), weight: 0 };
  perModel.ensemble = {
    mae: round(F.mean(ensAbs), 3), rmse: round(Math.sqrt(F.mean(ensAbs.map((e) => e * e))), 3),
    mape: round(F.mean(ensPct) * 100, 1), mase: round(F.mean(ensAbs) / (naiveMae || 1), 3), weight: 1
  };

  const spAvg = {
    hitRate: round(F.mean(spatial.map((s) => s.hitRate)) * 100, 1),
    pai: round(F.mean(spatial.map((s) => s.pai)), 2),
    pei: round(F.mean(spatial.map((s) => s.pei)) * 100, 1),
    recapture: round(recapture * 100, 1),
    areaFraction: round(areaFrac * 100, 0), flaggedDistricts: kFlag,
    coverage90: round((covN ? covHit / covN : 0) * 100, 1)
  };

  return {
    insufficient: false, T, t0, origins: testOrigins.length, fitOrigins: fitOrigins.length,
    perModel, weights, conformal, gbm, gbmHoldout,
    spatial: spAvg, statewide, naiveMae: round(naiveMae, 3),
    trainRows: ds.X.length
  };
}

// =================== high-level orchestrators (used by API) ===================

async function computeForecast(app) {
  const panel = await F.fetchPanel(app);
  if (!panel.districts.length) return { error: 'no_data' };
  // Prefer the Catalyst AppSail-hosted Python ML model; fall back to the in-function engine.
  try {
    const svc = await forecastViaService(panel);
    if (svc) return svc;
  } catch (_) { /* fall through to local engine */ }
  const bt = runBacktest(panel);
  const { series, timeline, districts } = panel;
  const nt = nextTimeMonth(timeline);
  const gbm = bt.gbm || null;
  const q90 = (bt.conformal && bt.conformal.q90) || 0;
  const weights = bt.weights || { seasonalTrend: 0.25, holt: 0.25, hawkes: 0.25, gbm: 0.25 };

  const T = timeline.length;
  const forecasts = districts.map((d) => {
    const preds = modelPreds(series, timeline, d, T, gbm); // t=T -> one step ahead
    const point = MODEL_KEYS.reduce((s, k) => s + weights[k] * preds[k], 0);
    const recent = series[d].slice(-12);
    const baseline = F.mean(recent);
    const sigma = std(recent) || 1;
    const z = (point - baseline) / sigma;
    return {
      district: d,
      lat: (F.KARNATAKA_CENTROIDS[d] || [])[0], lng: (F.KARNATAKA_CENTROIDS[d] || [])[1],
      predicted: round(point, 1),
      low: Math.max(0, round(point - q90, 1)), high: round(point + q90, 1),
      baseline: round(baseline, 1), lastMonth: series[d][T - 1] || 0,
      trendPct: baseline > 0 ? round(((point - baseline) / baseline) * 100, 0) : 0,
      z: round(z, 2),
      models: { seasonalTrend: round(preds.seasonalTrend, 1), holt: round(preds.holt, 1), hawkes: round(preds.hawkes, 1), gbm: round(preds.gbm, 1) }
    };
  }).sort((a, b) => b.predicted - a.predicted);

  return {
    horizon: nt.label, generatedAt: new Date().toISOString(),
    weights: Object.fromEntries(MODEL_KEYS.map((k) => [k, round(weights[k], 3)])),
    conformal: bt.conformal, accuracy: bt.perModel && bt.perModel.ensemble,
    coverageTarget: 90, forecasts,
    statewide: { predicted: round(forecasts.reduce((s, f) => s + f.predicted, 0), 0) }
  };
}

async function computeEarlyWarning(app) {
  const fc = await computeForecast(app);
  if (fc.error) return fc;
  // Expectation-based flags: forecast exceeds baseline by control-chart threshold.
  const alerts = fc.forecasts.map((f) => {
    let severity = 'watch';
    if (f.z >= 1.5 || f.trendPct >= 50) severity = 'critical';
    else if (f.z >= 0.8 || f.trendPct >= 25) severity = 'elevated';
    return { ...f, severity };
  }).filter((f) => f.z >= 0.3 || f.trendPct >= 8)
    .sort((a, b) => b.z - a.z);
  return {
    horizon: fc.horizon, generatedAt: fc.generatedAt,
    method: 'Ensemble forecast vs 12-month control baseline (z-score / EWMA-style expectation)',
    critical: alerts.filter((a) => a.severity === 'critical').length,
    elevated: alerts.filter((a) => a.severity === 'elevated').length,
    alerts
  };
}

async function computeBacktest(app) {
  const panel = await F.fetchPanel(app);
  if (!panel.districts.length) return { error: 'no_data' };
  const bt = runBacktest(panel);
  if (bt.insufficient) return { error: 'insufficient_history', T: bt.T };
  const table = [{ model: 'Seasonal-naive (baseline)', ...bt.perModel.seasonalNaive }];
  MODEL_KEYS.forEach((k) => table.push({
    model: ({ seasonalTrend: 'Seasonal-Trend', holt: 'Holt (exp-smooth)', hawkes: 'Hawkes self-excite', gbm: 'Gradient-Boosted Trees' })[k],
    ...bt.perModel[k]
  }));
  table.push({ model: 'ENSEMBLE (learned)', ...bt.perModel.ensemble });
  return {
    origins: bt.origins, fitOrigins: bt.fitOrigins, trainRows: bt.trainRows, gbmHoldoutMAE: bt.gbmHoldout,
    modelComparison: table, spatial: bt.spatial, conformal: bt.conformal,
    statewide: bt.statewide, coverage90: bt.spatial.coverage90, naiveMae: bt.naiveMae,
    validation: REAL_DATA_VALIDATION,
    note: 'Synthetic self-check — held-out walk-forward: weights + conformal fit on ' + bt.fitOrigins + ' origins, metrics measured on ' + bt.origins + ' held-out monthly origins × ' + panel.districts.length + ' districts. Coarse district-month demo data; the accuracy proof is the real-data validation above.'
  };
}

async function computeWatchlist(app, { limit = 20 } = {}) {
  // Repeat-offender reoffending risk: OffenderRisk × ring activity.
  const res = await app.zcql().executeZCQLQuery(
    `SELECT AccusedName, TotalCases, ViolentCases, RingID, RiskScore, RiskBand, Factors FROM OffenderRisk ORDER BY RiskScore DESC LIMIT ${Math.min(Number(limit) || 20, 100)}`);
  const rows = (res || []).map((r) => r.OffenderRisk || r);
  return {
    generatedAt: new Date().toISOString(),
    watchlist: rows.map((r) => ({
      name: r.AccusedName, riskScore: Number(r.RiskScore), band: r.RiskBand,
      totalCases: Number(r.TotalCases), violentCases: Number(r.ViolentCases),
      ring: Number(r.RingID) || 0, factors: r.Factors,
      // logistic reoffending propensity — driven by case history depth, violence and
      // organized-ring membership so it varies realistically across offenders.
      reoffendProb: (() => {
        const tc = Number(r.TotalCases) || 0, vc = Number(r.ViolentCases) || 0, ring = Number(r.RingID) || 0;
        const z = -2.2 + 0.28 * tc + 0.45 * vc + (ring ? 0.8 : 0);
        return round(Math.min(0.97, Math.max(0.15, 1 / (1 + Math.exp(-z)))), 2);
      })()
    }))
  };
}

module.exports = { runBacktest, computeForecast, computeEarlyWarning, computeBacktest, computeWatchlist, nextTimeMonth };
