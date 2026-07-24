# 02 · System Architecture

## High‑level topology

```
                          ┌──────────────────────────────────────────────┐
                          │            Browser (React 19 SPA)             │
                          │  Astryx UI · Chart.js · Leaflet · D3-force    │
                          │  Voice capture (MediaRecorder) · PDF export   │
                          └───────────────┬──────────────────────────────┘
                                          │  HTTPS  /app  and  /server/api
                                          ▼
                    ┌───────────────────────────────────────────┐
                    │      Zoho Catalyst  (India DC, .in)         │
                    │  Custom domain: ksp.cyberkunju.com (SSL)    │
                    ├───────────────────────────────────────────┤
   Client hosting → │  /app        → client/dist (static SPA)     │
                    │                                             │
   API Gateway    → │  /server/api → Advanced I/O Function "api"  │
                    │                (Node 18 · Express)          │
                    │                                             │
                    │   ┌─────────────────────────────────────┐  │
                    │   │  Data Store (10 tables, ZCQL)         │  │
                    │   │  Cases, Accused, Victims, ...         │  │
                    │   │  ChatSessions, AuditLog               │  │
                    │   └─────────────────────────────────────┘  │
                    │                                             │
   AppSail        → │  Python ML service (FastAPI + sklearn)     │
                    │  /forecast  · scale-to-zero                 │
                    └───────────────┬─────────────┬──────────────┘
                                    │             │
                       ┌────────────▼───┐   ┌─────▼──────────────┐
                       │  Zoho QuickML  │   │  Sarvam AI          │
                       │  GLM-4.7-Flash │   │  STT · TTS          │
                       └────────────────┘   └────────────────────┘
```

Everything the platform *serves* runs on Catalyst. The conversational LLM is **Zoho QuickML
(GLM‑4.7‑Flash)** — native to Catalyst; FIR OCR is **Catalyst Zia OCR** — also native; the only
third‑party calls are to **Sarvam AI** (Indian‑language speech, STT/TTS). All are reached
server‑side from the function so keys never touch the browser.

## The four Catalyst components

1. **Client Hosting** (`/app`) — serves the built React SPA from `client/dist`. Configured in
   `catalyst.json` (`client.source = client/dist`).
2. **Advanced I/O Function** (`/server/api`) — the `api` Express app in `functions/api`. All business
   logic: chat, analytics, forecasting orchestration, OCR, admin seeding. Stack `node18`, 1 GB memory.
3. **Data Store** — 10 tables (see [04-data-model.md](./04-data-model.md)), queried with ZCQL through
   the SDK. Chat sessions and the audit log are also tables.
4. **AppSail** — a serverless Python FastAPI service hosting the *validated champion* forecasting
   model. Scale‑to‑zero: only billed when serving. The function calls it via `FORECAST_SERVICE_URL`;
   if it's cold/unavailable, the function's own JS engine produces the forecast (graceful fallback).

## Request flow — a conversational query

```
User types "top 5 districts by cases"
      │
      ▼
POST /server/api/chat            (headers: x-user-role, x-user-id)
      │  Express route (index.js) → requireRole() guard
      ▼
handleChat()  (lib/chat.js)
      │  1. Build system prompt (role, language, DB schema) — lib/schema.js
      │  2. Call GLM-4.7-Flash with the query_crime_db tool — lib/llm.js
      │  3. Model emits a ZCQL SELECT → validate (isSafeSelect) → enforce LIMIT
      │  4. Execute ZCQL on Data Store → rows
      │  5. Feed rows back to the model; loop up to 5 steps
      │  6. Model writes the grounded natural-language answer
      ▼
Persist to AuditLog (query, ZCQL, cited IDs, reasoning, answer)
      ▼
Respond: { answer, zcql, rationale, citations, rows, sessionId }
      ▼
UI renders the answer bubble + Evidence panel (ZCQL, reasoning, cited records, result table)
```

## Request flow — a forecast

```
GET /server/api/analytics/forecast
      │  forecastRoute('computeForecast') → lib/backtest.js
      ▼
F.fetchPanel()  builds a dense district×month series from the Data Store (paged ZCQL)
      │
      ├─ If FORECAST_SERVICE_URL set → POST series to AppSail /forecast
      │     (sklearn HistGBM + NNLS ensemble + conformal)  ── preferred
      │
      └─ else / on failure → in-function JS engine (Seasonal-Trend, Holt, Hawkes, GBM)
                              runBacktest() learns ensemble weights + conformal q90
      ▼
Respond: per-district predicted / low / high / baseline / trend / z-score, horizon, weights
      ▼
UI: Leaflet predicted-hotspot map + KPI scorecard + backtest chart + alerts
```

## Directory structure

```
kph/
├── catalyst.json                 # Catalyst deploy config (functions + client)
├── .catalystrc                   # Project/env binding (Project-Rainfall, India DC)
├── client/                       # React 19 SPA (Vite)
│   ├── src/
│   │   ├── App.jsx               # App shell (AppShell/SideNav/TopNav) + chat view
│   │   ├── api.js                # Fetch client for /server/api
│   │   ├── ui.jsx                # Central Astryx component + icon exports
│   │   ├── index.css             # Layout glue + responsive scaling
│   │   ├── components/           # Analytics, EarlyWarning, CaseSupport, Sociology,
│   │   │                         #   MoneyTrail, Ingest, Composer, EvidencePanel,
│   │   │                         #   NetworkGraph, HotspotMap, TrendCharts, Cards
│   │   └── lib/                  # voice.js, pdf.js, chartTheme.js
│   └── dist/                     # Build output (served by Catalyst)
├── functions/api/                # Advanced I/O Function
│   ├── index.js                  # Express routes + RBAC + admin seeder
│   ├── lib/                      # chat, llm, schema, guard, csv, analytics,
│   │                             #   backtest, forecast, investigator, ocr, oauth
│   └── seed/*.csv                # Seed data bundled with the function
├── datastore/                    # Data model + generation + loading
│   ├── SCHEMA.md                 # Console table creation spec
│   ├── generate.js               # Calibrated ETAS synthetic generator
│   ├── load.js                   # Bulk seed loader (streams to /admin/insert)
│   └── seed/, train/             # Generated CSVs
├── ml/                           # Predictive engine research + validation + serving
│   ├── ingest_chicago.py         # Pull 2.49M real Chicago incidents
│   ├── get_covariates.py         # Weather + holiday covariates
│   ├── eval_harness.py           # Weekly walk-forward backtest
│   ├── eval_daily.py             # Daily grid + covariates backtest
│   ├── train_neural.py           # GPU GRU head-to-head
│   ├── RESULTS.md                # Real-data validation report
│   └── service/                  # AppSail Python service (app.py, Dockerfile, reqs)
└── documentation/                # ← you are here
```

## Design principles

- **Grounding over generation** — the LLM never answers factual questions from memory; it must query.
- **Prove, don't assert** — the forecasting engine self‑evaluates with walk‑forward backtests and
  standard policing metrics, and the method is validated on real data.
- **Governance first** — every answer is logged; safety is a deterministic pre‑check, not left to the model.
- **Catalyst‑native** — Functions + Data Store + AppSail + Client hosting + Zoho QuickML LLM + Zia OCR;
  third parties only where Catalyst can't provide (Indian‑language speech, STT/TTS).
- **One UI system** — everything is Astryx; no ad‑hoc components.

Continue to [03-infrastructure-and-deployment.md](./03-infrastructure-and-deployment.md).
