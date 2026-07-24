# Predictive Early-Warning Engine — Real-Data Validation

**What this is.** The KSP forecasting engine, validated on **2,493,490 real crime incidents**
from the City of Chicago open-data portal (2014–2023, 275 police beats, 33 crime types) —
because our Karnataka demo data is synthetic and scoring on synthetic data only measures how
well we recover our own simulator. To make accuracy claims that survive scrutiny, we backtest
the identical methodology on real, incident-level, geocoded crime and report against the
baselines police actually use.

All numbers below are **leak-free expanding-window walk-forward** backtests: every feature at
origin *t* uses strictly data before *t*; ensemble weights (non-negative least squares) and
split-conformal prediction intervals are fit on a **separate tuning window**, never the test
period; the gradient-boosted model is retrained periodically on past data only.

## Metrics (why these)
- **MASE** — Mean Absolute Scaled Error = MAE ÷ seasonal-naive MAE. **< 1.0 beats naive.** The
  single most important, scale-free accuracy number.
- **PAI / PEI** — Prediction Accuracy Index (`hit-rate ÷ area-fraction`, >1 beats random) and
  Prediction Efficiency Index (`hit-rate ÷ oracle`), swept across flagged-area budgets. The
  operational metrics from the NIJ Real-Time Crime Forecasting Challenge.
- **90% interval coverage** — does the conformal 90% prediction interval actually contain the
  truth ~90% of the time on held-out data.

## Baselines we hold ourselves against
| Baseline | Meaning |
|---|---|
| seasonal-naive | same period last cycle (MASE denominator, = 1.0) |
| persistence | last period |
| moving average | recent mean |
| **historical-pattern** | long-run mean per place/weekday — *the "patrol where crime usually is" baseline police use* |

## Results

### Grid × day (973 × 700 m cells) — the operational configuration
| Model | MASE ↓ | PAI@1% ↑ | PAI@5% | 90% coverage |
|---|---|---|---|---|
| seasonal-naive | 1.000 | — | — | — |
| historical-pattern (police baseline) | 0.823 | 5.95 | 3.34 | — |
| GBM (HistGradientBoosting) | 0.815 | 6.17 | 3.46 | — |
| NNLS ensemble | 0.819 | 6.17 | 3.46 | 90.9% |
| **Neural ST (GPU: GRU + near-repeat + covariates + cell embeddings)** | **0.811** | **6.24** | **3.49** | **91.1%** |

### Other resolutions
| Config | Best model | MASE | PAI@1% | Coverage |
|---|---|---|---|---|
| Grid × week (2,568 × 400 m) | ensemble | 0.772 | 6.30 | 87.0% |
| Beat × week (275) | GBM | 0.700 | 2.70 | 86.5% |
| Beat × day (275) | GBM | 0.729 | 2.58 | 90.9% |

## Honest findings
1. **We beat naive by 18–30% and the realistic police baseline by 1–3%**, with **calibrated**
   uncertainty (90% intervals cover ~91% at daily resolution). This is a real, defensible edge.
2. **Grid granularity is the operational unlock** — PAI jumps from ~2 (beat) to **6+** (fine grid):
   1% of the city concentrates ~6× its share of crime under our ranking.
3. **Near-repeat spatial features and weather covariates add only marginal gains** at these
   resolutions — we *measured* this rather than assuming it. Reported honestly.
4. **A GPU neural net ties gradient boosting** (0.811 vs 0.815) — it does not transform accuracy.
   Gradient boosting is a brutally strong baseline for this problem. The production champion is a
   **GBM + neural blend at grid-daily with conformal intervals**.
5. Crime is highly persistent and seasonal, so the *irreducible* residual predictability over a
   strong historical baseline is modest. No model predicts individual crimes; we forecast
   **where risk concentrates**, with honest uncertainty — decision support, not enforcement.

## Reproduce
```bash
python ingest_chicago.py --start 2014-01-01 --end 2024-01-01   # 2.49M real incidents
python get_covariates.py                                       # weather + holidays
python eval_harness.py  --unit grid --grid-m 400               # weekly grid backtest
python eval_daily.py    --unit grid --grid-m 700               # daily grid + covariates
python train_neural.py  --unit grid --grid-m 700 --epochs 8    # GPU Tier-3 head-to-head
```

## Transfer to Karnataka
The identical architecture (grid-level spatio-temporal features → GBM/neural ensemble → conformal
intervals → PAI/MASE self-evaluation) is what powers the live KSP demo on the Karnataka Data Store.
The Chicago validation proves the *method*; the live system applies it to KSP data. On real KSP
FIR data the same pipeline would be retrained and re-backtested identically.
