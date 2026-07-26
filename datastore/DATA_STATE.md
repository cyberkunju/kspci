# Data State — what is loaded, what is not, and how to finish it

**As of 26 July 2026.** Environment: Project-Rainfall (`51589000000013024`), Development
(`60079622152`), India DC. Live app: https://ksp.cyberkunju.com/app

This document exists so the loading decisions are reproducible and reversible by someone who was
not there. It covers what is in the Data Store, what is deliberately missing, exactly why, what it
would cost to complete, and the commands to do it.

---

## 1. Summary

The generator produces a **full-scale national corpus of 8,241,503 rows** across 8 tables. The
Data Store holds **1,546,194 of them (18.8%)**.

That is not an accident or an unfinished job — it is a **cost ceiling**. Catalyst bills Data Store
inserts **per row**, at ₹0.006. Loading the whole corpus costs about **₹49,400**. Loading it was
attempted, exhausted the plan mid-way, and took the entire environment offline (see §6).

The shortfall does not affect the forecasting engine or its published accuracy. It affects only
the person-level views (criminal network, money trail, victim demographics), which cover the
earliest cases rather than all of them.

---

## 2. Exactly what is loaded

| Table | Loaded | Full corpus | % | Not loaded | Cost to finish |
|---|---:|---:|---:|---:|---:|
| `Cases` | 1,016,380 | 1,505,504 | 67.5% | 489,124 | ₹2,935 |
| `Accused` | 160,000 | 2,234,499 | 7.2% | 2,074,499 | ₹12,447 |
| `Victims` | 90,000 | 1,286,967 | 7.0% | 1,196,967 | ₹7,182 |
| `Complainants` | 50,000 | 1,505,504 | 3.3% | 1,455,504 | ₹8,733 |
| `Arrests` | 50,000 | 1,062,738 | 4.7% | 1,012,738 | ₹6,076 |
| `CoAccusedLinks` | 60,000 | 155,026 | 38.7% | 95,026 | ₹570 |
| `OffenderRisk` | 94,814 | 94,814 | **100%** | 0 | ₹0 |
| `FinancialTxns` | 25,000 | 396,451 | 6.3% | 371,451 | ₹2,229 |
| **Total** | **1,546,194** | **8,241,503** | **18.8%** | **6,695,309** | **₹40,172** |

Verify at any time:

```bash
curl -s "https://ksp.cyberkunju.com/server/api/admin/status" -H "x-admin-key: $ADMIN_KEY"
```

### Time coverage

`Cases` is loaded as a **contiguous time prefix**, because the generator writes incidents sorted
by date:

| | |
|---|---|
| Loaded | **2023-07-01 → 2025-06-30** — 24 complete months |
| Full corpus | 2023-07-01 → 2026-06-30 — 36 months |
| Coverage | **all 36 states/UTs, all 640 districts** |

24 months was chosen deliberately, not arbitrarily. Monthly forecasting needs a full seasonal
cycle (12) plus enough beyond it to fit, calibrate and score. `engine/serve.py` requires
`season + 6 = 18` months minimum; 24 leaves five held-out origins for conformal calibration. 18
months would have saved ₹1,400 and left three.

### The important caveat: person-level data is front-loaded, not spread

The child tables are also loaded as prefixes, and because the CSVs are ordered by case, a prefix
means **the earliest cases**, not a sample across the window:

| Table | Highest `CaseMasterID` referenced | Which is roughly |
|---|---:|---|
| `Accused` | 107,948 | up to 2023-09-25 |
| `Victims` | 104,432 | up to 2023-09-25 |
| `Arrests` | 64,737 | up to ~2023-08-25 |
| `Complainants` | 50,000 | up to 2023-08-13 |

`Cases` spans IDs 1 → 1,016,380. So **a case picked at random almost certainly has no accused,
victim or complainant rows** — only the first ~7% do. Practically:

- Referential integrity is intact. Every `CaseMasterID` referenced by a child row exists in
  `Cases`; there are **no orphans**.
- The network, money-trail and demographic views work, but they describe July–September 2023.
- Case Support / drill-down on a recent case will show the case with no persons attached.

If even coverage matters more than depth, load a **strided sample** of the child tables instead of
a prefix — see §5.4.

### Two tables are not case-keyed

`OffenderRisk` (100% loaded) and `CoAccusedLinks` are keyed on **offender name**, not
`CaseMasterID`. They are globally coherent regardless of how much of `Cases` is loaded, which is
why the offender and ring views look complete while the per-case views do not.

---

## 3. Why it is not complete: the cost model

**Catalyst bills Data Store writes per row, not per API call.** This is the single most important
fact for anyone loading data here.

| Operation | Price | Source |
|---|---|---|
| Datastore **Insert** | **₹0.006 per row** | console billing breakdown |
| Datastore **Delete** | ₹0.0048 per row | ” |
| Datastore Fetch | ₹0.0036 per request | ” |
| Storage | ₹0.0432 per GB-day | ” |

Consequences that are easy to get wrong:

- The **API call budget is the wrong meter.** 8.24M rows at 200 rows per call is ~41,200 calls out
  of a 200,000 budget — which looks free. The same load is **₹49,400**.
- **Deleting is nearly as expensive as inserting.** Clearing the 1,016,380 loaded `Cases` rows
  would cost about **₹4,900**. Do not reload from scratch casually; prefer extending.
- **Reads are cheap.** Ordinary app usage costs fractions of a rupee. Re-running the forecast
  rewrites ~640 rows, about ₹4.
- **Storage is negligible** — the whole dataset is under a GB, a few paise a day.

Monitor spend at any time (needs the CDP browser from `DEVELOPMENT.md` §10):

```bash
node tools/usage.js      # plan, used, remaining, and remaining expressed as rows
```

> The billing console updates **every 30 minutes**. That is reporting lag only — nothing recurs.
> Right after a load the dashboard understates usage; wait for it to catch up before judging.

---

## 4. What the shortfall does and does not affect

### Not affected: the forecast engine or any accuracy claim

`ml/RESULTS.md` is measured **offline** and costs nothing:

- 27,424,968 synthetic incidents over 5 years at 100% of real national volume, 56 configurations
- 6,366,610 **real** incidents from five US city open-data portals, 28 panels

The live forecast is scored by `ml/score_live.py` from `datastore/seed/Cases.csv` — the same rows
that were loaded — so the model sees the full loaded panel regardless of the child tables. Live:
640 districts, MASE 0.855 against the police historical-pattern baseline's 0.939, 90.2% interval
coverage, PAI@1% 7.90 at PEI 0.993.

### Affected: person-level views

| View | State | Why |
|---|---|---|
| Early Warning (map, alerts, backtest) | complete | reads `Cases` + snapshot |
| Analytics → Overview / Trends / Hotspots | complete | reads `Cases` |
| Analytics → Offenders & Finance | complete | `OffenderRisk` 100% loaded |
| Analytics → Criminal Networks | partial | `CoAccusedLinks` 38.7% |
| Analytics → Money Trail | partial | `FinancialTxns` 6.3% |
| Analytics → Sociological Insights | partial | `Victims`/`Complainants` ≈ first 7% of cases |
| Case Support drill-down | partial | a recent case has no persons attached |

Sociology is the most visibly thin: it aggregates victim and complainant demography, and it is
reading roughly six weeks of cases.

---

## 5. How to load the rest

### 5.1 Before anything: price it

```bash
node tools/usage.js       # prints "rows affordable at Rs 0.006/row"
```

Rows to load × ₹0.006 must fit inside that. **Never start a load without doing this** — the
failure mode is not a slow load, it is the whole environment going offline (§6).

### 5.2 The loader

```bash
export KSP_API="https://ksp.cyberkunju.com/server/api"
export ADMIN_KEY=...                       # not stored in the repo; see CREDITS.md appendix
CONCURRENCY=8 MAX_ROWS=1505504 node datastore/load.js --only Cases
```

- `MAX_ROWS` is a **hard ceiling on the row index per table**. This is how spend is bounded — by
  an explicit stop, not by watching a dashboard.
- `CONCURRENCY=8` gives ~5,700 rows/s against ~200 rows/s sequential. The cost is round-trip
  latency, not work.
- Progress is checkpointed to `datastore/seed/.load-state.json` after every batch. **Rerunning the
  same command resumes**; it does not duplicate. The checkpoint only advances across a contiguous
  prefix of completed batches, so an interrupted parallel load cannot leave a gap.
- `--restart` ignores the checkpoint. `--only A,B` limits tables.

Current checkpoint:

```json
{"Cases":1016380,"Accused":160000,"Victims":90000,"Complainants":50000,
 "Arrests":50000,"CoAccusedLinks":60000,"OffenderRisk":94814,"FinancialTxns":25000}
```

### 5.3 Load everything (₹40,172, ~6.7M rows)

```bash
# ~20 minutes of wall clock at CONCURRENCY=8; resumable if interrupted
KSP_API="https://ksp.cyberkunju.com/server/api" CONCURRENCY=8 node datastore/load.js
```

With no `MAX_ROWS` the loader runs each table to the end of its CSV, resuming from the checkpoint.
Then re-score the forecast so it uses the full 36 months:

```bash
ADMIN_KEY=... ml/.venv/bin/python ml/score_live.py --max-rows 0   # 0 = whole file
```

`--max-rows` must **mirror what the Data Store holds**, or the forecast describes data the app does
not have.

### 5.4 Cheaper: even coverage instead of depth

If the goal is that *any* case has persons attached, a strided sample beats a prefix. The loader
takes a prefix, so build the sample first:

The loader always reads `datastore/seed/<Table>.csv`, so the sample has to replace that file.
**Back up the original first** — regenerating it means re-running the generator, and the
checkpoint would no longer line up:

```bash
cd datastore/seed
cp Accused.csv Accused.full.csv                       # keep the original

# every 20th row, header preserved -> ~112k rows spread across the whole case range, ~Rs 670
head -1 Accused.full.csv                        >  Accused.csv
awk 'NR>1 && (NR-1)%20==0' Accused.full.csv     >> Accused.csv
wc -l Accused.csv                                     # sanity-check before spending

cd ../.. && CONCURRENCY=8 node datastore/load.js --only Accused --restart
```

`--restart` is required: the checkpoint counts rows in the *old* file, and row *N* now means a
different record. It does **not** clear the table, so run `/admin/reset` with
`{"tables":["Accused"]}` first if you want to replace rather than add to the 160,000 already
there — remembering that deletes cost ₹0.0048 per row.

Caveat worth understanding: a strided sample gives most cases *one* accused instead of a few cases
having *all* of theirs. For a network graph that is worse (edges need co-offenders on the same
case); for "does this case have any person data" it is better. Prefixes are the right choice for
`CoAccusedLinks` and `FinancialTxns`, which need density to show structure.

### 5.5 Order of value for money

If budget is limited, this is the ranking I would use:

1. **`Cases` to 36 months** — 489,124 rows, ₹2,935. Extends the forecast history by a year and
   improves every aggregate view. Best value by a wide margin.
2. **`CoAccusedLinks` to 100%** — 95,026 rows, ₹570. Cheapest meaningful win; makes the ring
   graph substantially denser.
3. **`FinancialTxns` to 100%** — 371,451 rows, ₹2,229. Makes money-trail hubs genuinely
   interesting rather than just present.
4. **`Victims` + `Complainants`** — ₹15,915 together. Only worth it if the demographic view
   matters for the demo.
5. **`Accused` to 100%** — ₹12,447. The largest single line item, lowest marginal benefit, since
   `OffenderRisk` already gives complete offender coverage.

### 5.6 Regenerating the corpus

The CSVs in `datastore/seed/` (1.4 GB) are generated, not authored:

```bash
node datastore/generate-india.js --cases 1500000 --years 3      # the current corpus
node datastore/generate-india.js --cases 150000  --years 3      # ~800k rows, Rs 4,800
node datastore/generate-india.js --events-only --cases 27281585 --years 5   # ML corpus only
```

**Coverage of all 36 states and 640 districts is preserved at any `--cases` value** — only the
volume per district shrinks. `--seed` changes the realisation; the intensity field is deterministic
(real NCRB state totals split by census population and urban share), which is what made the
measured noise floor in `ml/RESULTS.md` possible.

Regenerating **invalidates the checkpoint**: row *N* of the new file is a different record. If you
regenerate, either `--restart` into a cleared table or accept a mixed dataset.

---

## 6. What went wrong, so it is not repeated

### The plan was exhausted mid-load

A full-scale load was started after checking the **API call budget** (41,200 of 200,000 — looked
free) rather than the row price. At ~608,000 rows the plan amount was exhausted and Catalyst
returned `SUBSCRIPTION_USAGE_LIMIT_REACHED` for **every resource in the environment** — the API
function and the AppSail service included. The app went down, not just the load.

Lesson: **price the load, cap it with `MAX_ROWS`, and check `tools/usage.js` first.** Adding
concurrency made it hit the wall faster.

### The destructive reset

Before loading, all eight tables were cleared via `POST /admin/reset` (19,792 Karnataka cases and
~151k related rows). That data was synthetic and regenerable, so nothing irreplaceable was lost,
but there is now **no Karnataka-only demo dataset to fall back to**.

### ZCQL limits found at scale

At ~1M rows several dashboards began failing with a bare
`400 ZCQL QUERY ERROR: Error occurred during query processing`, which names neither the query nor
the cause. Two independent ceilings, neither about indexing — full measurements and the fixes are
in `DEVELOPMENT.md` §11. In short:

- One ceiling scales with **rows scanned × groups produced**. `GROUP BY Gravity` (3 groups)
  succeeds over 1,016,380 rows; `GROUP BY StateName` (36 groups) fails on the same rows and
  succeeds restricted to one year; 640 district groups fail even per year and succeed per state.
- The other limits **concurrent query processing**: a query that takes 1.1s alone fails when 12
  run at once.

National aggregates are therefore partitioned and merged in process, four partitions at a time.
**If you load more rows, watch for these returning** — the partitioning is sized for the current
volume, and a 36-month `Cases` table is 50% more rows per partition.

### Do not trust `OFFSET` or `ORDER BY` for pagination

Reading 640 stored forecast rows back was harder than writing them. `LIMIT offset, n` returned
**overlapping pages** — a read produced one district twice and silently dropped another. Keyset
paging on `ROWID` then skipped rows, because Catalyst `ROWID`s are **not monotonic across insert
batches**. Both lost data without erroring.

The working pattern is a sequence column assigned at write time (`Forecasts.Seq`) read back in
explicit half-open ranges. Where a partition fits under the 300-row `LIMIT` cap, prefer no
pagination at all.

Inserts are also **not exactly-once**: a request can fail at the client after succeeding at the
server, and the retry writes a duplicate. `POST /admin/forecast/dedupe` repairs that.

---

## 7. Schema changes applied

Applied through the console over CDP (the CLI cannot change Data Store schema — see
`DEVELOPMENT.md` §10 for the browser automation):

- `Cases` **+** `StateName`, `TalukName`, `LocalityName` — the all-India geography
- `Victims` **+** `Caste`, `Religion`
- `Forecasts` — new, 22 columns, holds the batch-scored snapshot
- `ForecastMetrics` — new, 10 columns, one row of scalar context per scope

Column definitions are in `SCHEMA.md`. The tables are additive: with them absent the forecast
routes fall back to live computation.

`functions/api/lib/forecast.js` also tolerates a `Cases` table **without** `StateName`, because a
schema migration and a code deploy cannot be made atomic.

---

## 8. Operational commands

```bash
# row counts
curl -s "$KSP_API/admin/status" -H "x-admin-key: $ADMIN_KEY"

# spend, and remaining balance expressed as rows
node tools/usage.js

# read-only ZCQL, for diagnosing what the store actually answers
curl -s -X POST "$KSP_API/admin/zcql" -H "Content-Type: application/json" \
  -H "x-admin-key: $ADMIN_KEY" -d '{"query":"SELECT COUNT(ROWID) FROM Cases"}'

# re-score the live forecast from the loaded rows (Rs ~4)
ADMIN_KEY=... ml/.venv/bin/python ml/score_live.py --max-rows 1016380

# rebuild the forecast scope from empty, then repair any duplicate units
curl -s -X POST "$KSP_API/admin/forecast/purge"  -H "x-admin-key: $ADMIN_KEY" -d '{"level":"district"}'
curl -s -X POST "$KSP_API/admin/forecast/dedupe" -H "x-admin-key: $ADMIN_KEY" -d '{"level":"district"}'

# in-Catalyst fallback scoring, one state per request (weaker: per-state MASE 0.95 vs pooled 0.855)
ADMIN_KEY=... node datastore/refresh-forecast.js --purge --concurrency 1
```

`/admin/reset` clears the seed tables and is **irreversible**. It does not touch `Forecasts`.

---

## 9. If you load everything, do this afterwards

1. `ml/.venv/bin/python ml/score_live.py --max-rows 0` — re-score on 36 months, then confirm
   `/analytics/forecast` reports 640 districts and `cached: true`.
2. Re-check `/analytics/overview`, `/trends`, `/hotspots?level=district`. If any returns
   `Error occurred during query processing`, the partitioning in `analytics.js` needs a finer
   split — partition by `Year, CrimeMonth` or by state (§6).
3. Re-check the money trail and network views; with full `FinancialTxns` the hub thresholds in
   `analytics.js` may want raising from 4 linked accused, since real hubs will be denser.
4. `node tools/usage.js` — confirm what it cost and what is left.
