# Predictive Early-Warning Engine — Measured Results

**What this document is.** Every number here comes from a leak-free walk-forward backtest run
by the same code (`ml/engine/`) against every dataset. Two corpora are reported, always
separately:

| Corpus | What it is | What it can prove |
|---|---|---|
| **Real open data** — 6.37M incidents, 5 US cities, 28 panels | Chicago, New York, Los Angeles, San Francisco, Seattle open-data portals, 2018–2023, incident-level and geocoded | that the method and its conclusions hold on real recording practice |
| **Synthetic all-India** — 27.4M incidents, 640 districts, 56 panels | NCRB-calibrated ETAS simulation, 2021–2026 | resolution and decomposition experiments at Indian scale, and a **measured** noise floor, which real data cannot give |

The synthetic corpus cannot validate accuracy — scoring on it partly measures how well the
engine recovers our own simulator. It is used for the things real data cannot do: sweeping 55
spatial/temporal configurations, and generating independent realisations of the *same*
intensity field to measure the irreducible error directly.

## Window discipline

```
|<--- train --->|<-- stack -->|<-- calib -->|<------ test ------>|
```

Features at origin *t* use strictly data before *t*. NNLS ensemble weights are fitted on the
stack window; conformal quantiles on the calibration window; every reported metric on the test
window and nowhere else. Models are refitted every 8 origins on past data only, so the numbers
reflect a periodically retrained system rather than one fitted with hindsight.

## Baselines

| Baseline | Meaning |
|---|---|
| seasonal-naive | same period last cycle — the MASE denominator, = 1.000 |
| persistence / moving-average / Holt | standard weak baselines |
| **historical-pattern** | long-run mean per place and period — **the "patrol where crime usually is" baseline police actually use**. This is the one that matters. |

---

## The central finding: the Poisson floor is the wrong yardstick

A forecaster that knew the true intensity exactly still could not predict the realised count,
because arrivals are random. De Moivre's identity gives that floor in closed form for a Poisson
process, and dividing it by the achieved error gives an *efficiency*: at 1.0 no model can do
better. That reframing is what turns "we beat the police baseline by 1.8%" from a
disappointing result into "we are within 2% of the best any model could do".

**But crime is not Poisson.** Near-repeat victimisation means events arrive in bursts, so counts
are over-dispersed, and the Poisson floor is only a *lower bound* on irreducible error. Used
uncorrected, it overstates how much headroom is left.

This was measured rather than assumed. The generator's intensity field is deterministic — a
district's expected volume is real NCRB state totals split by census population and urban share,
with no seeded district effect — so changing the seed redraws the *realisation* of the same
process. Six independent realisations of 27.4M incidents each (`modal run ml/modal_app.py::floor`)
give a model-free oracle: for each realisation, predict it from the mean of the other five.

| Quantity | district × week |
|---|---|
| mean count per cell | 163.6 |
| variance per cell | 279.0 |
| **dispersion index (variance / mean)** | **1.705** |
| leave-one-out oracle MAE | 12.56 |
| **measured irreducible floor MAE** | **11.46** |
| closed-form Poisson floor MAE | 8.86 |
| **Poisson bound understates the floor by** | **1.293×** |

√1.705 = 1.306 against a measured 1.293, so the floor scales with the standard deviation as
theory says. Dispersion rises with volume (1.63 in the smallest band, 1.78 in the largest).

**Consequence.** At district × week the engine achieves MAE 13.07. Against the Poisson floor that
is efficiency 0.677 and 32% headroom. Against the *measured* floor it is **efficiency 0.877 and
about 12% headroom**. Two-thirds of the apparent opportunity was an artefact of the Poisson
assumption.

The engine now reports both. Because real data arrives as a single realisation and can never be
replicated, `Panel.dispersion_bracket()` returns a **range** rather than a point estimate:
successive differencing over-estimates dispersion (1.99) and removing the cross-sectional common
factor under-estimates it (1.29). The bracket contains the measured 1.705; neither endpoint is
close enough to report alone. A point estimate would be false precision that silently rewrites
every headroom figure.

---

## Real open data — five cities, 6.37M incidents, 28 panels

Identical engine, identical metrics. `ml/ingest_cities.py` writes the same column schema as the
Indian corpus specifically so `build_panels.py` and the engine run unchanged; a city-specific
path would mean the validation numbers came out of different code than the numbers they validate.

`taluk` is each portal's finer unit: Chicago beats, New York precincts, Los Angeles reporting
districts, San Francisco analysis neighbourhoods, Seattle beats.

| panel | units | MASE | police | edge% | eff | real headroom | PAI@1% | police PAI | cov90 |
|---|---|---|---|---|---|---|---|---|---|
| chicago district×week | 24 | 0.530 | 0.865 | 38.7 | 0.639 | 3–20% | 1.51 | 1.34 | 86.0% |
| chicago taluk×week | 275 | 0.702 | 0.792 | 11.4 | 0.813 | 4–7% | 2.62 | 2.59 | 85.7% |
| chicago taluk×day | 275 | 0.749 | 0.759 | 1.2 | 0.903 | 0–1% | 2.75 | 2.56 | 86.0% |
| chicago grid 700 m×week | 1155 | 0.739 | 0.781 | 5.3 | 0.863 | 2–4% | **6.30** | 6.13 | 86.8% |
| newyork district×week | 6 | 0.468 | 1.852 | 74.8 | 0.466 | 0–39% | 1.67 | 1.67 | 95.1% |
| newyork taluk×week | 94 | 0.617 | 1.110 | 44.4 | 0.741 | 7–13% | 2.91 | 2.92 | 91.4% |
| newyork taluk×day | 94 | 0.717 | 0.817 | 12.3 | 0.826 | 0–4% | 2.92 | 2.92 | 89.2% |
| newyork grid 700 m×week | 1511 | 0.706 | 0.794 | 11.1 | 0.846 | 5% | **7.72** | 7.52 | 88.9% |
| losangeles district×week | 21 | 0.640 | 0.836 | 23.4 | 0.674 | 2–12% | 1.54 | 1.51 | 96.5% |
| losangeles taluk×week | 1109 | 0.709 | 0.750 | 5.5 | 0.869 | 3% | 5.10 | 4.74 | 90.6% |
| losangeles grid 1 km×week | 1151 | 0.722 | 0.765 | 5.7 | 0.863 | 1–2% | **9.56** | 9.40 | 90.7% |
| losangeles grid 1 km×day | 878 | 0.815 | 0.817 | 0.3 | 0.932 | 0% | 8.25 | 8.20 | 90.2% |
| sanfrancisco district×week | 11 | 0.654 | 0.834 | 21.6 | 0.536 | 16–24% | 1.61 | 1.60 | 90.1% |
| sanfrancisco taluk×week | 132 | 0.703 | 0.800 | 12.2 | 0.661 | 5–7% | 11.93 | 11.89 | 89.5% |
| sanfrancisco grid 500 m×week | 447 | 0.722 | 0.776 | 7.0 | 0.726 | 0% | **13.60** | 12.93 | 90.0% |
| sanfrancisco grid 500 m×day | 419 | 0.813 | 0.823 | 1.3 | 0.828 | 0% | **12.59** | 12.13 | 89.8% |
| seattle taluk×week | 53 | 0.650 | 0.750 | 13.3 | 0.734 | 0–6% | 1.76 | 1.56 | 92.5% |
| seattle grid 800 m×week | 378 | 0.712 | 0.768 | 7.3 | 0.799 | 0% | **10.47** | 10.39 | 91.1% |
| seattle grid 800 m×day | 336 | 0.822 | 0.835 | 1.6 | 0.900 | 0% | 9.95 | 9.84 | 90.3% |

Full 28-panel table: `ml/.venv/bin/python ml/report_table.py ml/out/reports --real`

### What the real data says

1. **The engine beats seasonal-naive on all 28 real panels** (MASE 0.47–0.83) and beats the
   police historical-pattern baseline on 27 of 28. The one exception is Los Angeles
   taluk × day, where it ties.
2. **Grid resolution is the operational unlock, and this replicates in every city.** PAI@1%
   goes from 1.5–2.3 at district level to **6.3–13.6** on a fine grid: 1% of the city, ranked
   by the model, contains six to fourteen times its share of crime.
3. **At grid resolution the model adds almost nothing *spatially* over the police baseline.**
   Its PAI is within a few per cent of the historical-pattern baseline's own PAI in all five
   cities. The grid is what produces the concentration; the model is not. Reporting PAI without
   the baseline's PAI beside it would misattribute that gain, which is why the table carries
   both columns.
4. **Where the model does earn its keep is the aggregate series** — district × week edges of
   21–75%, because the long-run-mean baseline cannot track trend or level shifts while the
   model can. New York is the extreme case: the police baseline scores MASE 1.852, i.e. far
   worse than simply repeating last year.
5. **Intervals are calibrated**: Mondrian conformal 90% coverage lands at 85.7–96.5% across 28
   panels with no per-panel tuning.
6. **Corrected headroom at fine resolution is 0–7%.** The engine is close to the achievable
   floor wherever the panel is fine-grained. The larger corrected ranges (New York district,
   San Francisco district) are on panels with 6–11 units, where the bracket is wide because
   there is little cross-section to estimate dispersion from — and on three panels
   (New York district × day, Seattle district × day and × week, all 6–7 units) the bracket
   is too wide to conclude anything at all and is reported as `n/a` rather than dressed up
   as a range.

---

## Synthetic all-India — 55 configurations, 27.4M incidents

Used for the resolution sweep, not for accuracy claims.

| panel | units | MASE | police | edge% | eff (Poisson) | real headroom | PAI@1% |
|---|---|---|---|---|---|---|---|
| district × month | 640 | 0.787 | 1.226 | 35.8 | 0.544 | n/a | 8.10 |
| **district × week** | 640 | 0.742 | 0.814 | 8.9 | 0.677 | 10–23% | 8.11 |
| district × day | 628 | 0.712 | 0.735 | 3.2 | 0.929 | 0% | 7.95 |
| taluk × week | 6782 | 0.714 | 0.755 | 5.5 | 0.769 | 9–13% | 19.12 |
| district × week, property offences | 620 | 0.707 | 0.758 | 6.9 | 0.729 | 7–17% | 25.53 |
| district × week, public order | 535 | 0.698 | 0.745 | 6.3 | 0.680 | 11–12% | 11.94 |
| district × week, cyber crime | 172 | 0.739 | 0.755 | 2.1 | 0.937 | 6% | 11.21 |
| grid 1 km × week, Mumbai Suburban | 414 | 0.752 | 0.766 | 1.8 | 0.959 | 3% | 8.43 |
| grid 1 km × week, Bangalore | 856 | 0.828 | 0.840 | 1.3 | 0.986 | 0% | 8.58 |
| grid 1 km × day, Mumbai Suburban | 289 | 0.855 | 0.857 | 0.3 | 1.000 | 0% | 6.80 |

Full table: `ml/.venv/bin/python ml/report_table.py ml/out/reports --synthetic`

### Findings

1. **`state × month` fails** — MASE 1.083, worse than seasonal-naive. 36 units × 36 periods is
   not enough signal. This corrected an earlier recommendation of mine: **district × week is the
   right default for the live service, not state**.
2. **A national 1 km grid is not viable** — 464,859 cells with a median of one event each,
   because India is roughly 5,000× the area of Chicago. Grid panels have to be
   per-metropolitan-district, which is how they are built.
3. **Grid panels are already at the floor** (efficiency 0.95–1.01, corrected headroom 0–3%).
   Efficiency slightly above 1.0 means the forecast is closer to the realised counts than the
   Poisson floor implies; it should be read as "at the floor", not as beating it.
4. **Finer time resolution closes the gap that finer space does not.** District × day reaches
   efficiency 0.929 and 0% corrected headroom against district × week's 0.677 and 10–23%. The
   unclaimed signal at district × week is largely within-week timing that a weekly panel
   cannot represent, which is a more useful answer than "train a bigger model".
5. **Mondrian (stratified) conformal is necessary, not decorative.** Global split-conformal
   coverage by volume band was 99.8 / 94.8 / 76.9 / **47.8**% against a nominal 90. Stratifying
   by band gives 88.2 / 87.7 / 86.6 / 85.1%. A single interval width cannot describe a
   metropolitan district and a Himalayan one at once, and the aggregate coverage number stays
   near target while being wrong for nearly every individual unit.

---

## Hypotheses tested and rejected

Reported because a negative result that cost a few container-hours is worth more than an
untested assumption.

**Hierarchical decomposition does not help.** The aggregate district × week series mixes offence
types with genuinely different dynamics — the generator gives Liquor & Excise a branching ratio
of 0.58 over a four-day delay, Crime Against Women 0.28 over fifteen days — so summing them
first should average those signatures away. It does not matter:

| approach | MASE | MAE |
|---|---|---|
| top-down (forecast the aggregate) | 0.741 | 13.07 |
| bottom-up (forecast 14 groups, sum) | 0.737 | 12.98 |
| bottom-up, GBM only | 0.736 | 12.97 |
| blend, weight chosen on the test window (a ceiling, not a result) | 0.735 | 12.96 |
| police baseline | 0.814 | 14.34 |

A 0.5% gain for 14× the models and 14× the operational surface. Per-group efficiencies (0.68–0.94)
looked like they exceeded the aggregate's 0.677, which was the reason to try — but that gap was
the Poisson artefact, not real signal. `ml/hierarchical.py`.

**A national fine grid is not the answer either** — see finding 2 above. The two obvious ways to
claim the district × week headroom, decomposing by offence and refining space, both fail; refining
*time* works.

**Near-repeat spatial features and weather covariates add only marginal gains** at these
resolutions. Measured, not assumed.

**A GPU neural net ties gradient boosting** — 0.811 vs 0.815 MASE on Chicago grid × day. Gradient
boosting is a brutally strong baseline for this problem, and the neural model does not transform
accuracy. `ml/train_neural.py`.

---

## What this means operationally

The engine forecasts **where risk concentrates, with honest uncertainty**. It is decision
support, not enforcement, and three properties matter more than the headline MASE:

- **Calibrated intervals per volume band**, so a district commander gets an interval that is
  right for their district rather than right on average.
- **Enforcement-led offences are forecast separately and never drive deployment alone.**
  Recorded volume for liquor, narcotics, arms and regulatory offences is largely a record of
  where officers went. Forecasting it and deploying against the forecast closes a feedback loop:
  the model sends patrols where patrols already were, and the resulting records confirm the
  model. `build_panels.py --split-head` keeps them apart.
- **Recapture rate is reported** — the share of flagged units that stay flagged between
  consecutive origins. High persistence is expected because crime is sticky, but it is also the
  warning sign for exactly that feedback loop.

---

## Reproduce

```bash
# real open data: five city portals, in parallel
ml/.venv/bin/python ml/ingest_cities.py --all --start 2018-01-01 --end 2024-01-01
ml/.venv/bin/modal run ml/modal_app.py::cities        # build + evaluate, fanned out

# synthetic corpus at full national volume
node datastore/generate-india.js --events-only --cases 27281585 --years 5
ml/.venv/bin/modal run ml/modal_app.py::push_events
ml/.venv/bin/modal run ml/modal_app.py::full          # 55 panels, all in parallel

# the measured noise floor: six independent realisations of one intensity field
ml/.venv/bin/modal run ml/modal_app.py::floor --k 6

# hypothesis test: does per-offence decomposition beat the aggregate
ml/.venv/bin/modal run ml/modal_app.py::hierarchical

# collate
ml/.venv/bin/modal run ml/modal_app.py::fetch_reports
ml/.venv/bin/python ml/report_table.py ml/out/reports --real
```

Local single-panel runs (`ml/run_engine.py`) produce identical numbers; Modal only changes how
many run at once. An accuracy claim that depends on where the code ran is not an accuracy claim.

## Transfer to Karnataka

The live KSP service applies the identical pipeline — spatio-temporal features → Poisson GBM and
quantile GBM → NNLS ensemble → stratified conformal intervals → PAI/MASE self-evaluation — to the
Catalyst Data Store. The five-city validation proves the method on real recording practice; the
synthetic corpus sizes the configuration for Indian geography. On real KSP FIR data the same
pipeline is retrained and re-backtested unchanged.
