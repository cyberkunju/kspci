# 13 · File‑by‑File Reference

A map of every meaningful file in the repository and what it does.

## Root

| File | Purpose |
|---|---|
| `catalyst.json` | Catalyst deploy config — functions target `api` (source `functions/`), client source `client/dist`. |
| `.catalystrc` | Project/env binding — Project‑Rainfall, env `60079622152`, India DC, Asia/Kolkata. |
| `.gitignore` | Excludes node_modules, build output, secrets/config, ML data/venv, seed/train CSVs, the confidential ER‑diagram PDF. |
| `Police_FIR_ER_Diagram.pdf` | The datathon's source ER diagram (git‑ignored, confidential). |

## `functions/api/` — Advanced I/O Function

| File | Purpose |
|---|---|
| `index.js` | Express app: all routes (health, warmup, chat, voice, ingest, analytics, investigator, forecast/backtest/watchlist/brief, admin seeder), `requireRole` RBAC, `adminGuard`, Catalyst init per request. Exported as the function. |
| `package.json` | Deps: express, zcatalyst‑sdk‑node, sarvamai, adm‑zip. |
| `catalyst-config.json` | Deployment config + env vars with **real keys** (git‑ignored). |
| `catalyst-config.example.json` | Placeholder template of the above. |
| `lib/chat.js` | Agentic chat loop, `query_crime_db` tool, ZCQL safety (`isSafeSelect`/`enforceLimit`), evidence/citation assembly, `handleChat`, `runZcql`. |
| `lib/llm.js` | Zoho QuickML (GLM‑4.7‑Flash) client (native tool‑calling, timeout, `max_tokens`). |
| `lib/schema.js` | `SCHEMA_PROMPT` — compact denormalized schema + value domains + strict ZCQL rules for grounding. |
| `lib/guard.js` | `assessSafety` deterministic self‑harm / harm‑enablement pre‑check (EN/KN). |
| `lib/csv.js` | Minimal RFC‑4180 CSV parser (shared with the loader). |
| `lib/analytics.js` | Aggregation engine: overview, hotspots, trends, network, offenders, financial, sociology, moneytrail; `KARNATAKA_CENTROIDS`. |
| `lib/forecast.js` | Forecast models (Seasonal‑Trend, Holt, Hawkes, hand‑written GBM), features, panel builder (`fetchPanel`), math helpers, population weights. |
| `lib/backtest.js` | Walk‑forward backtest + metrics (MAE/RMSE/MAPE/MASE, Hit‑Rate/PAI/PEI/recapture, conformal coverage), ensemble weight learning, AppSail service integration (`forecastViaService`), orchestrators (`computeForecast/EarlyWarning/Backtest/Watchlist`), `REAL_DATA_VALIDATION`. |
| `lib/investigator.js` | `caseSupport` — 360° case dossier (record, entities, timeline, similar cases + disposition, LLM leads). |
| `lib/ocr.js` | Catalyst Zia OCR (`extractOpticalCharacters`) → `structureFir` (GLM) → `insertIngestedCase` (Data Store). |
| `lib/oauth.js` | Zoho QuickML GLM OAuth token (the active LLM auth path). |
| `seed/*.csv` | Seed data bundled with the function (`Cases`, `Accused`, `Victims`, `Complainants`, `Arrests`, `CoAccusedLinks`, `OffenderRisk`, `FinancialTxns`). |

## `client/` — React SPA

| File | Purpose |
|---|---|
| `index.html` | Shell; sets `data-astryx-theme="neutral" data-theme="dark"`; loads Inter/JetBrains fonts. |
| `vite.config.js` | Vite config (`base:'./'`, dev proxy `/server → :3000`). |
| `package.json` | React 19, Astryx, StyleX, Chart.js, Leaflet, d3‑force, lucide; scripts dev/build/preview. |
| `scripts/copy-config.cjs` | Post‑build: copy `client-package.json` + `404.html` into `dist`. |
| `src/main.jsx` | Entry: imports Astryx CSS (reset, astryx, theme) + chart theme + `index.css`; mounts `<App/>`. |
| `src/App.jsx` | App shell (AppShell/SideNav/TopNav), chat view (Astryx Chat*), welcome, session state, evidence open/close. |
| `src/api.js` | Fetch client for `/server/api`; `ROLES`. |
| `src/ui.jsx` | Central Astryx component + lucide icon exports; Table width helpers. |
| `src/index.css` | Layout glue + responsive scaling media queries + canvas/timeline/code‑block styles. |
| `src/components/Composer.jsx` | Astryx `ChatComposer` + Sarvam voice button. |
| `src/components/EvidencePanel.jsx` | Explainable‑AI rail / mobile drawer. |
| `src/components/Analytics.jsx` | 6‑tab analytics dashboard. |
| `src/components/EarlyWarning.jsx` | Predictive dashboard (map, scorecard, backtest, alerts, watchlist, brief). |
| `src/components/CaseSupport.jsx` | Investigator dossier view. |
| `src/components/Sociology.jsx` | Sociological charts. |
| `src/components/MoneyTrail.jsx` | Money‑flow graph + hubs. |
| `src/components/Ingest.jsx` | OCR FIR upload view. |
| `src/components/NetworkGraph.jsx` | d3‑force SVG network graph. |
| `src/components/HotspotMap.jsx` | Leaflet hotspot map. |
| `src/components/TrendCharts.jsx` | Chart.js trend charts. |
| `src/components/Cards.jsx` | Shared `Kpi` + `VizCard`. |
| `src/lib/voice.js` | MediaRecorder capture + Sarvam STT/TTS playback. |
| `src/lib/pdf.js` | Conversation → printable HTML → print‑to‑PDF. |
| `src/lib/chartTheme.js` | Global Chart.js theme + palette. |

## `datastore/` — data model, generation, loading

| File | Purpose |
|---|---|
| `SCHEMA.md` | The 10‑table creation spec for the Catalyst console. |
| `generate.js` | Calibrated ETAS/Hawkes synthetic generator → `seed/` + `train/` CSVs. |
| `load.js` | Bulk loader — parses CSVs locally, streams batches to `POST /admin/insert`. |
| `seed/*.csv` | Denormalized app‑table data (loaded into Data Store). |
| `train/events.csv`, `train/weekly_panel.csv`, `train/meta.json` | Full event log + weekly feature series for model training/backtest. |

## `ml/` — predictive engine research, validation & serving

| File | Purpose |
|---|---|
| `ingest_chicago.py` | Pull 2.49M real Chicago incidents (Socrata) → `data/chicago.parquet`. |
| `get_covariates.py` | Weather + holiday covariates → `data/covariates.parquet`. |
| `eval_harness.py` | Weekly walk‑forward backtest harness (MASE/PAI/PEI/coverage, baselines). |
| `eval_daily.py` | Daily grid + covariates backtest. |
| `train_neural.py` | GPU GRU neural head‑to‑head vs GBM. |
| `requirements.txt` | Research deps (numpy, pandas, scikit‑learn, scipy, pyarrow, requests). |
| `RESULTS.md` | Real‑data validation report (the accuracy proof). |
| `data/eval_*.json` | Backtest result artifacts (grid/beat/daily/neural/report). |
| `service/app.py` | AppSail FastAPI forecasting champion (HistGBM + NNLS + conformal). |
| `service/Dockerfile` | Custom OCI runtime for AppSail (`python:3.12-slim`, pip install reqs). |
| `service/requirements.txt` | Service deps (fastapi, uvicorn, numpy, scipy, scikit‑learn). |
| `service/test_client.py` | Local test client for the `/forecast` endpoint. |
| `service/vendor/` | Vendored Linux cp312 wheels (managed‑runtime dependency path, ~202 MB). |

## `documentation/` — this documentation set

`README.md` (index) + `01`–`13` as listed in the [README](./README.md#documentation-map).

---

## Cross‑cutting helpers worth knowing

- **`flatten(row)`** (in chat/analytics/forecast/investigator) — ZCQL returns `{ Table: { col: val } }`;
  this flattens to `{ col: val }`.
- **`countOf(row)`** — robustly reads `COUNT(ROWID)`.
- **`pagedQuery`** (forecast) — pages grouped ZCQL beyond the 300‑row LIMIT cap.
- **`isSafeSelect` / `enforceLimit`** (chat) — the ZCQL safety gate.
- **`KARNATAKA_CENTROIDS` / `POP_WEIGHT`** — the 15‑district geo + population calibration shared by
  analytics, forecasting and the data generator.
