'use strict';
// Local harness: build a monthly district panel from datastore/train/events.csv
// and exercise the real forecast/backtest engine (no Catalyst needed).
const fs = require('fs');
const path = require('path');
const F = require('../functions/api/lib/forecast');
const BT = require('../functions/api/lib/backtest');

const csv = fs.readFileSync(path.join(__dirname, '..', 'datastore', 'train', 'events.csv'), 'utf8').trim().split('\n');
const header = csv[0].split(',');
const di = header.indexOf('district'), ti = header.indexOf('ts');
const rows = csv.slice(1).map((l) => l.split(','));

// aggregate to district×(year,month)
const agg = {}; // d -> ym -> count
const ymset = new Set();
for (const r of rows) {
  const d = r[di]; const ts = r[ti];
  const dt = new Date(ts); const y = dt.getUTCFullYear(), m = dt.getUTCMonth() + 1;
  const ym = y * 100 + m; ymset.add(ym);
  (agg[d] = agg[d] || {})[ym] = (agg[d][ym] || 0) + 1;
}
const yms = [...ymset].sort((a, b) => a - b);
const timeline = yms.map((ym, idx) => ({ year: Math.floor(ym / 100), month: ym % 100, label: `${Math.floor(ym / 100)}-${String(ym % 100).padStart(2, '0')}`, idx }));
const districts = Object.keys(agg);
const series = {};
for (const d of districts) series[d] = yms.map((ym) => agg[d][ym] || 0);
const panel = { districts, timeline, series };

console.log(`Panel: ${districts.length} districts × ${timeline.length} months (${timeline[0].label}..${timeline[timeline.length - 1].label})`);
const bt = BT.runBacktest(panel);
console.log('\nModel comparison (walk-forward, ' + bt.origins + ' origins):');
for (const k of ['seasonalTrend', 'holt', 'hawkes', 'gbm', 'ensemble']) {
  const m = bt.perModel[k];
  console.log(`  ${k.padEnd(14)} MAE ${String(m.mae).padStart(6)}  RMSE ${String(m.rmse).padStart(6)}  MAPE ${String(m.mape).padStart(5)}%  w=${m.weight}`);
}
console.log('\nSpatial policing metrics:', JSON.stringify(bt.spatial));
console.log('Conformal:', JSON.stringify(bt.conformal), ' gbmHoldoutMAE=', bt.gbmHoldout, ' trainRows=', bt.trainRows);

// Next-month forecast (mimic computeForecast top)
const T = timeline.length;
const gbm = bt.gbm;
const weights = bt.weights;
const MK = ['seasonalTrend', 'holt', 'hawkes', 'gbm'];
const fc = districts.map((d) => {
  const hist = series[d].slice(0, T);
  const nm = BT.nextTimeMonth(timeline).month;
  const pop = F.POP_WEIGHT[d] || 0.04;
  const preds = { seasonalTrend: F.mSeasonalTrend(hist, timeline, nm), holt: F.mHolt(hist), hawkes: F.mHawkes(hist), gbm: gbm.predict(F.featAt(series[d], timeline, T, pop)) };
  const point = MK.reduce((s, k) => s + weights[k] * preds[k], 0);
  return { d, point: Math.round(point * 10) / 10, last: hist[T - 1] };
}).sort((a, b) => b.point - a.point);
console.log('\nNext-month (' + BT.nextTimeMonth(timeline).label + ') top predicted districts:');
fc.slice(0, 6).forEach((f) => console.log(`  ${f.d.padEnd(20)} predicted ${f.point}  (last month ${f.last})`));
