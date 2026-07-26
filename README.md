# KSP Crime Intelligence AI

**KSP Datathon 2026 — Challenge 1: Intelligent Conversational AI & Crime Analytics Platform**
Built and deployed end-to-end on **Zoho Catalyst**.

A conversational + predictive crime-intelligence platform for the Karnataka State Police.
Investigators, analysts, supervisors and policymakers query the crime database in natural
language (English + Kannada, text + voice), get grounded evidence-cited answers, explore
criminal-network graphs and hotspot/trend analytics, ingest scanned FIRs via OCR, and act
on a **backtested predictive early-warning engine** — all under role-based access with a
full audit trail.

> All data is **synthetic**, produced by a calibrated crime simulator (`datastore/generate.js`).
> No real FIR records, cases, or persons are represented. Accuracy figures below are measured
> by walk-forward backtest on this synthetic corpus and are honest about that ceiling.

---

## Mandatory features (9/9) + differentiators

| # | Feature | How it's delivered | Catalyst service |
|---|---|---|---|
| 1 | NL chatbot (English + Kannada) | Agentic tool-calling loop (GLM-4.7-Flash) → text-to-ZCQL, SELECT-guarded, grounded | Functions, Data Store |
| 2 | Voice input | Sarvam `saarika` STT + `bulbul` TTS | Functions (Zia-compatible) |
| 3 | Multi-turn context memory | ChatSessions + AuditLog history replay | Data Store |
| 4 | PDF export of chats | client-side print pipeline | Web Client Hosting |
| 5 | Criminal network graph | co-accused edges → D3 force graph, ring filter | Data Store, Functions |
| 6 | Hotspot / trend detection | ZCQL geo+temporal aggregation → Leaflet + Chart.js | Data Store |
| 7 | **Predictive / early-warning analytics** | **4-model ensemble, walk-forward backtested, conformal intervals** (see below) | Functions, Data Store |
| 8 | Explainable AI + audit trail | ZCQL + reasoning trace + cited record IDs per answer | Data Store (AuditLog) |
| 9 | Role-based access control | 4-tier RBAC (investigator/analyst/supervisor/policymaker/admin) | API Gateway, Auth |
| + | **OCR FIR ingestion** | Catalyst Zia OCR → LLM (GLM) structuring → Data Store insert | Functions |
| + | **AI analyst brief** | GLM-4.7-Flash narrates the live forecast into a leadership brief | Functions |

---

## Predictive Early-Warning Engine (feature #7)

The centrepiece. Not a heuristic — a genuine forecasting stack that reads the district×month
crime series live from the Data Store and forecasts next-month risk per district.

**Calibrated data (not random noise).** Crime is simulated as a self-exciting
spatio-temporal **ETAS / Hawkes point process** — the same generative structure modern
predictive-policing systems exploit. It is calibrated to real Karnataka NCRB anchors
(state volume ~2 L/yr, YoY decline, crime-head mix, district population skew) so the data
carries genuine learnable structure: near-repeat/retaliation clustering (~30–45%), festival
+ summer seasonality, weekly cycles, and organized-crime rings with bursty co-offending.
The full corpus (~40k events) is written to `datastore/train/` for training/backtest; a
time-representative operational sample is seeded into the live store.

**4-model ensemble** (`functions/api/lib/forecast.js`):
1. **Seasonal-Trend** — robust recent trend × multiplicative seasonal index.
2. **Holt** — grid-tuned double-exponential smoothing.
3. **Hawkes self-excitation** — decaying excitation from recent surges (near-repeat momentum).
4. **Gradient-Boosted Trees** — a real trained ML model (CART + gradient boosting) fit on
   lagged/rolling/seasonal features pooled across districts; reports its own holdout error.

Ensemble weights are **learned** (inverse-error) from a **walk-forward, expanding-window
backtest** (`functions/api/lib/backtest.js`). Prediction intervals are **split-conformal**
(distribution-free) from walk-forward residuals.

**Self-evaluation (proves it, doesn't assert it).** The `/analytics/backtest` scorecard
reports, on held-out months:

| Metric | Meaning | Result* |
|---|---|---|
| Ensemble MAE / MAPE | point accuracy (beats every individual model) | ~8.2 / ~24% |
| PAI | Predictive Accuracy Index (>1 beats random) | ~1.9 |
| PEI | Predictive Efficiency Index (share of oracle-optimal) | ~99% |
| Hit-Rate | crime captured in top-4 flagged districts (~27% area) | ~52% |
| Recapture | hotspot persistence origin→origin | ~98% |

\*Measured live on the seeded synthetic corpus; regenerates on each run.

**Fairness.** Decision-support only, exposure-normalized, explicitly **not** automated
enforcement — surfaced in the UI and the AI brief.

### Predictive API

```
GET /analytics/forecast      next-month per-district forecast + conformal intervals
GET /analytics/earlywarning  emerging-hotspot alerts (control-chart / z-score)
GET /analytics/backtest      walk-forward scorecard + model-comparison table (analyst+)
GET /analytics/watchlist     reoffending watchlist (logistic risk) (analyst+)
GET /analytics/brief         GLM-4.7-Flash leadership early-warning brief
```

---

## Architecture

```
client/ (React+Vite SPA, served at /app)  ──►  API Gateway  ──►  functions/api (Express, Advanced I/O)
                                                                     │
   ┌─────────────────────────────────────────────────────────────────┤
   │ lib/chat.js       agentic tool-calling loop (text-to-ZCQL)        │
   │ lib/llm.js        GLM-4.7-Flash (OpenAI-style API)                │
   │ lib/forecast.js   4 models + trained GBM + conformal              │
   │ lib/backtest.js   walk-forward backtest + PAI/PEI + orchestration │
   │ lib/analytics.js  ZCQL aggregations (KPIs, hotspots, network)     │
   │ lib/ocr.js        Catalyst Zia OCR FIR ingestion                  │
   │ lib/voice (routes) Sarvam STT/TTS                                 │
   └─────────────────────────────────────────────────────────────────┘
                                     │
                              Catalyst Data Store (10 tables)
```

## Project structure

```
.
├─ catalyst.json           # project config (functions + client)
├─ functions/api/          # Advanced I/O Node function (Express) behind API Gateway
│  └─ lib/                 # chat, llm, forecast, backtest, analytics, ocr, csv, guard, schema
├─ client/                 # React + Vite SPA (builds to client/dist, served at /app)
├─ datastore/
│  ├─ SCHEMA.md            # 10-table Data Store schema
│  ├─ DATA_STATE.md        # what is loaded vs generated, cost model, how to load the rest
│  ├─ generate.js          # calibrated ETAS crime simulator
│  ├─ load.js              # streaming Data-Store seeder (parses locally, POSTs batches)
│  ├─ seed/                # generated app CSVs (git-ignored)
│  └─ train/               # full event log + weekly feature panel (git-ignored)
└─ scripts/                # offline forecast harness, test-FIR generator
```

## Local development

```bash
# 1. Generate calibrated synthetic data  (--scale rich-ness, --cap app-store window)
node datastore/generate.js --scale 1.0 --cap 20000

# 2. Validate the forecast engine offline (no Catalyst needed)
node scripts/test_forecast.js

# 3. Client
cd client && npm install && npm run build

# 4. Function deps
cd functions/api && npm install

# 5. Deploy (functions + client)
catalyst deploy --ignore-scripts

# 6. Seed the Data Store (after the tables exist per SCHEMA.md)
#    Inserts are billed per row — price the load first and cap it. See datastore/DATA_STATE.md.
node tools/usage.js                                  # remaining balance, expressed as rows
CONCURRENCY=8 MAX_ROWS=1016380 node datastore/load.js --only Cases
```

## Tech stack

React + Vite · Chart.js · Leaflet · D3-force · Node.js (Catalyst Serverless Advanced I/O,
`zcatalyst-sdk-node`) · Catalyst Data Store + ZCQL · API Gateway · Web Client Hosting ·
Domain Mappings · Zoho QuickML / GLM-4.7-Flash (conversational + analyst brief) · Sarvam AI (STT/TTS) · Catalyst Zia OCR.

## Security note

Demo admin/API keys used during the build must be moved to Catalyst environment variables
and rotated before any public submission. All external content (OCR text, LLM output) is
treated as untrusted and never executed.
