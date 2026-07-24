# 08 · Predictive Early‑Warning Engine

The most rigorously engineered part of the platform. It is a genuine forecasting stack that
**proves** its accuracy with walk‑forward backtests and standard policing metrics, and whose method
is validated on **2.49M real incidents**.

Files: `functions/api/lib/forecast.js` (models + data access), `lib/backtest.js` (evaluation +
orchestration + AppSail integration), `ml/service/app.py` (AppSail Python champion), `ml/*.py`
(research/validation), `ml/RESULTS.md` (report). UI: `client/src/components/EarlyWarning.jsx`.

## Two forecasting engines (with graceful fallback)

1. **Production champion — Catalyst AppSail Python service** (`ml/service/app.py`):
   scikit‑learn `HistGradientBoostingRegressor` + `seasonal_naive` + moving‑average, blended by a
   **scipy NNLS** (non‑negative least squares) stacked ensemble, with **split‑conformal** prediction
   intervals. This is the exact validated champion.
2. **In‑function JS engine** (`lib/forecast.js`): a self‑contained 4‑model ensemble that runs inside
   the Catalyst Function with no external ML dependency — used as **fallback** when the AppSail
   service is cold/unavailable, so forecasts never fail.

`backtest.computeForecast()` tries the service first (`FORECAST_SERVICE_URL`, 25s timeout); on any
error it falls through to the JS engine. The response's `servedBy` field indicates which produced it.

## The JS ensemble models (`lib/forecast.js`)

| Model | Method |
|---|---|
| **M1 Seasonal‑Trend** | Robust recent linear trend (`linreg`) projected one step, × a multiplicative 12‑month seasonal index (festival/summer cycle). |
| **M2 Holt** | Double‑exponential smoothing (level + trend), α/β grid‑tuned on the series tail. |
| **M3 Hawkes self‑excitation** | ETAS momentum: base rate + decaying excitation from recent surges — the near‑repeat core that PredPol‑style systems detect. |
| **M4 Gradient‑Boosted Trees** | A **hand‑written CART + gradient boosting** regressor (60 rounds, depth 3, lr 0.08) trained on lagged/seasonal/rolling features pooled across districts. |

**Features** (`featAt`): lag‑1/2/3/12, rolling‑3/6 means, sin/cos of month, district population weight.
**Ensemble**: inverse‑MAE weights learned by walk‑forward. **Intervals**: split‑conformal residual
quantiles (distribution‑free coverage).

## Data access — dense panel (`fetchPanel`)

Reads `SELECT DistrictName, Year, CrimeMonth, COUNT(ROWID) FROM Cases GROUP BY ...` (plus a crime‑head
split), **paged** via `LIMIT offset,count` (ZCQL caps LIMIT at 300), and assembles a contiguous
`district × month` matrix `{ districts, timeline, series }`.

## Walk‑forward backtest (`runBacktest`) — the honesty engine

For every historical origin *t* it forecasts month *t* using **only** data before *t*:

- **Leak‑free GBM** trained strictly on rows before the backtest window.
- **Honest split**: ensemble weights + conformal quantile are fit on the **first 60%** of origins;
  every reported metric is measured on the **held‑out** remaining origins (removes in‑sample optimism).
- **Point accuracy** per model: MAE, RMSE, MAPE, and **MASE** (÷ seasonal‑naive MAE; <1 beats naive).
- **Spatial policing metrics** (rank districts by predicted volume, flag top‑k = 25% area budget):
  - **Hit‑Rate** — share of next‑month crime captured inside flagged districts.
  - **PAI** (Prediction Accuracy Index) = Hit‑Rate ÷ area‑fraction (>1 beats random).
  - **PEI** (Prediction Efficiency Index) = Hit‑Rate ÷ oracle (best achievable at that budget).
  - **Recapture** — persistence of flagged hotspots origin→origin.
- **90% conformal coverage** measured on held‑out data.
- Also returns the **statewide predicted‑vs‑actual** series for the backtest chart.

## Early warning (`computeEarlyWarning`)

Expectation‑based control‑chart flags on top of the forecast:
- `critical` if z ≥ 1.5 or trend ≥ +50%; `elevated` if z ≥ 0.8 or trend ≥ +25%; else `watch`.
- Only surfaces districts with z ≥ 0.3 or trend ≥ +8%, sorted by z. Framed as **exposure‑normalized
  decision‑support, not automated enforcement**.

## Reoffending watchlist (`computeWatchlist`)

`OffenderRisk` ranked by `RiskScore`, plus a logistic reoffend probability
`σ(−2.2 + 0.28·TotalCases + 0.45·ViolentCases + 0.8·[in ring])`, clamped to [0.15, 0.97].

## AppSail Python service (`ml/service/app.py`)

FastAPI app. `POST /forecast` accepts `{ series, period, horizonLabel, budgets }` and returns
per‑unit `{ predicted, low, high, baseline, trendPct }`, ensemble `weights`, `accuracy` (MASE per
model + naiveMae), `coverage90`, `spatial` (PAI/PEI per budget), and `conformalQ90`. Internals:
`HistGradientBoostingRegressor(max_depth=4, lr=0.08, max_iter=300, l2=1.0, min_samples_leaf=20)`;
NNLS stacking; same honest 60/40 fit/eval split and conformal quantile as the JS engine.
`GET /health` reports the engine + validation summary. Port from `X_ZOHO_CATALYST_LISTEN_PORT`.

## Real‑data validation (`ml/RESULTS.md`)

Because the Karnataka demo data is synthetic (scoring on it mostly measures recovery of our own
simulator — MASE ≈ 1.05 at district×month), the **accuracy proof is on real data**: the identical
methodology backtested on **2,493,490 real Chicago incidents (2014–2023, 275 beats, 33 crime types)**,
leak‑free expanding‑window walk‑forward.

**Champion results (grid × day, 700 m cells):**

| Model | MASE ↓ | PAI@1% ↑ | PAI@5% | 90% coverage |
|---|---|---|---|---|
| seasonal‑naive | 1.000 | — | — | — |
| historical‑pattern (police baseline) | 0.823 | 5.95 | 3.34 | — |
| GBM (HistGradientBoosting) | 0.815 | 6.17 | 3.46 | — |
| NNLS ensemble | 0.819 | 6.17 | 3.46 | 90.9% |
| **Neural ST (GPU GRU + near‑repeat + covariates)** | **0.811** | **6.24** | **3.49** | **91.1%** |

**Other resolutions:** Grid×week (400 m) ensemble MASE 0.772, PAI@1% 6.30; Beat×week GBM MASE 0.700;
Beat×day GBM MASE 0.729.

**Honest findings (verbatim spirit of the report):**
1. Beats seasonal‑naive by **18–30%** and the realistic **police historical‑pattern baseline by 1–3%**,
   with calibrated 90% intervals (~91% coverage at daily resolution) — a real, defensible edge.
2. **Grid granularity is the operational unlock** — PAI jumps from ~2 (beat) to **6+** (fine grid).
3. Near‑repeat spatial features and weather covariates add only marginal gains at these resolutions —
   *measured, not assumed.*
4. A **GPU neural net ties gradient boosting** (0.811 vs 0.815) — GBM is a brutally strong baseline;
   the production champion is a GBM + neural blend at grid‑daily with conformal intervals.
5. No model predicts individual crimes; we forecast **where risk concentrates**, with honest
   uncertainty — decision support, not enforcement.

## ML research scripts (`ml/`)

| Script | Purpose |
|---|---|
| `ingest_chicago.py` | Pull 2.49M real Chicago incidents via Socrata API → parquet. |
| `get_covariates.py` | Weather + holiday covariates. |
| `eval_harness.py` | Weekly walk‑forward backtest (grid/beat), MASE/PAI/PEI/coverage, baselines. |
| `eval_daily.py` | Daily grid + covariates backtest. |
| `train_neural.py` | GPU GRU (RTX 4060) head‑to‑head vs GBM. |
| `RESULTS.md` | The validation report (above). |

Reproduce:
```bash
python ingest_chicago.py --start 2014-01-01 --end 2024-01-01
python get_covariates.py
python eval_harness.py --unit grid --grid-m 400
python eval_daily.py   --unit grid --grid-m 700
python train_neural.py --unit grid --grid-m 700 --epochs 8
```

## Why GBM over neural in production

The GPU neural net (GRU + near‑repeat + covariates + cell embeddings) **tied** GBM (0.811 vs 0.815).
Given equivalent accuracy, the simpler, cheaper, dependency‑light **HistGBM + NNLS + conformal** stack
was chosen as the production champion (served on AppSail), with the neural result documented as a
head‑to‑head. This is the "prove, don't assert; choose the simplest thing that wins" principle.

Continue to [09-frontend.md](./09-frontend.md).
