# 13 · File‑by‑File Reference

A map of every meaningful file in the repository and what it does.

## Root

| File | Purpose |
|---|---|
| `catalyst.json` | Catalyst deploy config — functions target `api` (source `functions/`), client source `client/dist`, AppSail service `research` (container image `localhost/ksp-research:latest`, 1024 MB, port 9000). On the container path the CLI honours `memory` and `port` but not `env_variables` or `catalyst_auth`; see [16](./16-research-engine.md). |
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
| `lib/research.js` | Bridge to the AppSail research engine: gathers the identity anchors from the Data Store, summarises what our own records hold for the `[DB]` half of the report, determines the subject's role from our own records, and proxies start/poll/cancel with the internal key. |
| `lib/wa/*` | WhatsApp field-officer channel — see [15-whatsapp-field-bot.md](./15-whatsapp-field-bot.md). `tools.js` hosts the `open_source_research` tool, which starts a run and ends the turn; `wa/research.js` formats and delivers the finished run when the engine calls back. |
| `test/research.test.js` | Anchor-gathering, subject-role, proxy-failure, `[DB]` record-summary, WhatsApp tool and callback-delivery tests. |
| `test/wa.test.js` | WhatsApp channel logic tests. |
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
| `src/components/Research.jsx` | Open-source research view: purpose-bound request form, live stage progress, anchor-strength summary, attribution-banded source table, dated-claims timeline, PDF export. |
| `src/components/NetworkGraph.jsx` | d3‑force SVG network graph. |
| `src/components/HotspotMap.jsx` | Leaflet hotspot map. |
| `src/components/TrendCharts.jsx` | Chart.js trend charts. |
| `src/components/Cards.jsx` | Shared `Kpi` + `VizCard`. |
| `src/lib/voice.js` | MediaRecorder capture + Sarvam STT/TTS playback. |
| `src/lib/pdf.js` | One print shell, two exports: conversation report and open-source research report → printable HTML → print‑to‑PDF. |
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

## `research/` — OSINT research engine (AppSail container)

Full design notes in [16-research-engine.md](./16-research-engine.md).

| File | Purpose |
|---|---|
| `Dockerfile` | Custom OCI runtime for AppSail (`python:3.12-slim`, non-root uid 10001, uvicorn on `X_ZOHO_CATALYST_LISTEN_PORT`). |
| `requirements.txt` | fastapi, uvicorn, httpx, pydantic, trafilatura, lxml, pypdf. |
| `app/main.py` | HTTP surface: start / poll / cancel / SSE stream / callback / health, all behind `x-research-key`, failing closed. |
| `app/config.py` | `Budget` (standard / deep) and environment-driven `Settings`. Records why there is no headless-browser tier. |
| `app/models.py` | `Tier`, `Anchors` (with `strength()`), `Hit`, `Document`, `Story`, `Claim`, `Finding`. |
| `app/governance.py` | Purpose binding, subject-type gate, role gate, daily cap, audit line, disclaimer. |
| `app/plan.py` | Name variants, query neutralisation, anchor-driven query set, GDELT plan + absolute date window. |
| `app/tiers.py` | 27 official domains, 16 Kannada and 21 Hindi outlets, and the 9 on-site search endpoints — 6 through Quintype's JSON API, 3 by reading the results page. |
| `app/sources.py` | Discovery adapters: GDELT (rate-limited, cooldown), Bing News RSS across three markets, the general-web tier, on-site search, Wikipedia in three languages, Wikidata, Wayback, SearXNG, Mojeek, Marginalia. |
| `app/net.py` | Fetcher with SSRF defence on every redirect hop (including IPv4-mapped and CGNAT addresses and a cloud-metadata floor), robots, per-host limits, and per-host 429 penalties read from `Retry-After`. |
| `app/extract.py` | Trafilatura article extraction, PDF text, script-based language, prompt-injection screen. |
| `app/cluster.py` | Simhash clustering so syndication counts once; containment for truncated copies. |
| `app/attribute.py` | The attribution bands and the reasons behind each, person- and topic-shaped scoring. |
| `app/claims.py` | Span-verified claim extraction and marker-validated synthesis. |
| `app/llm.py` | One model interface: `openai` / `quickml` / `none`, with `none` as a supported mode. |
| `app/pipeline.py` | The run: deadline, stages, degradation, cross-encoder read ordering, deep mode's lead-following second round, findings and counts. |
| `app/runs.py` | In-memory run registry with TTL, eviction and a concurrency gate. |
| `app/fuse.py` | Weighted reciprocal-rank fusion across tiers, with field-level merging of duplicates. |
| `app/verdict.py` | Per-publisher record of whether a static fetch ever yields article text, used to order the read budget and to explain an unreadable page. |
| `app/rerank.py` | Cohere Rerank v4.0 Pro — which ~48 of ~165 candidates are worth reading. Falls back to lexical ordering. |
| `app/selftest.py`, `selftest_reason.py`, `selftest_claims.py`, `selftest_pipeline.py`, `selftest_fuse.py` | Five offline suites — extraction and network policy, attribution reasoning, claims, fusion and publisher verdicts, and the whole pipeline plus the HTTP surface. |
| `app/eval_attribution.py` | The labelled evaluation: 17 hand-labelled documents, gating false confirms and wrongly-dismissed sources at zero. The only suite that asks whether the answer is right. |

## `documentation/` — this documentation set

`README.md` (index) + `01`–`16` as listed in the [README](./README.md#documentation-map).

---

## Cross‑cutting helpers worth knowing

- **`flatten(row)`** (in chat/analytics/forecast/investigator) — ZCQL returns `{ Table: { col: val } }`;
  this flattens to `{ col: val }`.
- **`countOf(row)`** — robustly reads `COUNT(ROWID)`.
- **`pagedQuery`** (forecast) — pages grouped ZCQL beyond the 300‑row LIMIT cap.
- **`isSafeSelect` / `enforceLimit`** (chat) — the ZCQL safety gate.
- **`KARNATAKA_CENTROIDS` / `POP_WEIGHT`** — the 15‑district geo + population calibration shared by
  analytics, forecasting and the data generator.
