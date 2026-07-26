# KSP Crime Intelligence — Development Guide

Practical runbook for working on this project: the toolchain, how the local
dev loop talks to the **already-deployed** Catalyst backend, the Catalyst CLI,
and the browser/CDP setup used for console-only tasks.

> The whole platform is **already hosted and live on Zoho Catalyst** — serverless
> functions, Data Store, the AppSail ML forecast service, and client hosting.
> Local dev is therefore mostly **frontend against the live API**; you rarely need
> to run the backend locally.

---

## 1. Environment at a glance

| Thing | Value |
|---|---|
| Catalyst project | **Project-Rainfall** — `51589000000013024` |
| Org / Environment ID | `60079622152` (Development) |
| Data center | India (`.in`) |
| Node (local) | v22.x · **functions target Node 18** on Catalyst |
| Package managers | `npm` (client + functions), `pip` (ml service) |

### Live endpoints (verified working)
| Surface | URL |
|---|---|
| App (custom domain) | `https://ksp.cyberkunju.com/app` |
| API (custom domain) | `https://ksp.cyberkunju.com/server/api` |
| API (catalyst domain) | `https://project-rainfall-60079622152.development.catalystserverless.in/server/api` |
| AppSail forecast ML | `https://kspforecast-50044266480.development.catalystappsail.in` |

Health check: `GET /server/api/health` → `{"service":"ksp-crime-ai","status":"ok","catalyst":true}`

---

## 2. Local development loop (frontend → live API)

The Vite dev proxy forwards `/server/*` to an API target. It defaults to a local
`catalyst serve` (`localhost:3000`), but the fast path is to point it at the
**live deployment** so you get real data with no local backend.

```bash
# from repo root
cd client
KSP_API_TARGET=https://ksp.cyberkunju.com npm run dev -- --host 127.0.0.1
# → http://127.0.0.1:5173
```

- `KSP_API_TARGET` is read in `client/vite.config.js`. Unset → `http://localhost:3000`.
- This is why the app shows real KPIs (≈19,791 cases) and live forecasts in dev.
- Do **not** commit a hardcoded live target into the proxy default; keep it env-driven.

### Client scripts (`client/`)
| Command | Purpose |
|---|---|
| `npm run dev` | Vite dev server + HMR |
| `npm run build` | Production build → `client/dist` (what Catalyst hosts) |
| `npm run preview` | Serve the built `dist/` (no API proxy) |

> Browser cache gotcha: after CSS/token changes, a normal reload can serve a stale
> bundle. Use **Empty Cache and Hard Reload** (DevTools) or an Incognito window.

---

## 3. Catalyst CLI

Installed globally as `zcatalyst-cli` (command: `catalyst`, v1.27.0).

```bash
npm install -g zcatalyst-cli      # install / upgrade
catalyst --version
catalyst whoami                   # → knavaneeth786@gmail.com (logged in)
catalyst login --no-localhost --dc in   # headless login, India DC (re-auth if needed)
```

Project binding lives in `.catalystrc` (already points to Project-Rainfall / Development).
Deploy config lives in `catalyst.json`: functions target `api` (`functions/`),
client source `client/dist`.

### Common commands
| Command | Purpose |
|---|---|
| `catalyst serve` | Run functions locally at `localhost:3000` (Node runtime; may differ from Node 18 target) |
| `catalyst deploy` | Deploy everything per `catalyst.json` |
| `catalyst deploy --only functions` | Deploy just the API function |
| `catalyst deploy --only client` | Deploy just the built SPA |
| `catalyst pull` | Sync remote project config locally |
| `catalyst logout` | End CLI session |

> **Node version note:** functions run on Node 18 in Catalyst; local Node is 22.
> `catalyst serve` usually works, but if it errors on the runtime, prefer developing
> against the live API (Section 2) instead of local serve.

### Deploy safety
Deploys and Data Store / ZCQL mutations are **live actions** against the real
project. Always review the exact command first; treat schema changes, data deletes,
and re-deploys as high-risk and confirm before running.

---

## 4. Browser control via CDP (for console-only tasks)

Some Catalyst work has **no CLI equivalent** (console-only settings, dashboards).
The Chrome DevTools MCP can't launch a browser in this environment (no X server for
its process), so we drive a real Chrome over the DevTools Protocol instead.

### Launch Chrome on the user's display with remote debugging
```bash
DISPLAY=:10.0 /sbin/google-chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/ksp-catalyst-profile \
  --no-first-run --no-default-browser-check \
  "https://console.catalyst.zoho.in/baas/60079622152/index"
```
- `DISPLAY=:10.0` is the active desktop session (check with the running Chrome's `/proc/<pid>/environ`).
- Separate `--user-data-dir` keeps it isolated from the main browser profile.
- Verify: `curl -s http://127.0.0.1:9222/json/version` and `curl -s http://127.0.0.1:9222/json`.

### Drive it from Node (Playwright over CDP)
`playwright-core` is available in the npx cache. Example:
```js
const { chromium } = require('/home/cyberkunju/.npm/_npx/9833c18b2d85bc59/node_modules/playwright-core/index.js');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find(p => p.url().includes('catalyst'));
// ...drive page: click, fill, read...
await browser.close(); // detaches; does NOT close the user's Chrome
```
This shares the **logged-in** console session, so anything you do in the browser
is authenticated as the signed-in user.

### Playwright MCP (separate, headless)
The Playwright MCP runs its own headless browser — good for testing the local
dev app (`127.0.0.1:5173`) and screenshots, but it is **not** logged into Catalyst.
Use it for UI/UX verification; use the CDP path above for the authenticated console.

---

## 5. Services & where they live

Full credits in `CREDITS.md`. Condensed map for development:

| Capability | Provider | Notes |
|---|---|---|
| API (chat, analytics, forecast proxy, OCR ingest) | Catalyst **Serverless Function** `api` (Express, Node 18) | `functions/api/` |
| Data | Catalyst **Data Store** + **ZCQL** | 10 tables (FIRs, accused, victims, complainants, arrests, co-accused, offender risk, financial txns, chat sessions, audit log) |
| LLM (chat → ZCQL, FIR structuring, briefs) | Catalyst **QuickML** — GLM-4.7-Flash | OAuth self-client refresh-token flow via `accounts.zoho.in` |
| OCR (scanned FIR) | Catalyst **Zia** OCR | EN / Kannada / Hindi |
| Forecasting ML | Catalyst **AppSail** (FastAPI + scikit-learn) | seasonal + Holt + Hawkes + HistGBM ensemble, conformal intervals; JS fallback in the function |
| Speech (STT/TTS) | **Sarvam AI** (third party) | `saarika:v2.5` / `bulbul:v3` — only non-Catalyst service |
| Hosting | Catalyst **Web Client Hosting** + **API Gateway** + **Domain Mapping** | `/app` and `/server` |
| Token cache | Catalyst **Cache** | QuickML OAuth access token |

### Roles (RBAC, enforced server-side)
`investigator`, `analyst`, `supervisor`, `policymaker`, `admin`.
The client sends `x-user-role`; the API enforces access. `policymaker` is read-only
(cannot ingest FIRs). Test endpoints with a header:
```bash
curl -s -H "x-user-role: analyst" https://ksp.cyberkunju.com/server/api/analytics/overview
```

---

## 6. Repository layout

```
client/            React 19 + Vite + Astryx SPA  → client/dist (hosted)
  src/components/  feature workspaces (Analytics, EarlyWarning, CaseSupport, Ingest, ...)
  src/ui.jsx       single Astryx re-export surface
  src/index.css    app glue + theme tokens (radius/colour overrides live here)
  vite.config.js   dev proxy (KSP_API_TARGET)
functions/api/     Express Advanced I/O function (Catalyst)
  lib/             chat, analytics, forecast, ocr, llm, oauth, guard, ...
  seed/            CSV seed data
ml/                Python forecasting service (AppSail) + offline harness
datastore/         schema + synthetic data generator
documentation/     product/architecture docs (01–14)
CREDITS.md         services + **live credentials appendix (local only)**
```

---

## 7. Verify / smoke test

```bash
# API health (both domains)
curl -s https://ksp.cyberkunju.com/server/api/health
curl -s https://project-rainfall-60079622152.development.catalystserverless.in/server/api/health
# AppSail ML
curl -s https://kspforecast-50044266480.development.catalystappsail.in/
# Real data
curl -s -H "x-user-role: analyst" https://ksp.cyberkunju.com/server/api/analytics/overview
# Frontend build + syntax
cd client && npm run build
node --check functions/api/index.js
```

---

## 8. Guardrails

- **Secrets:** `CREDITS.md` has a live-credentials appendix (OAuth refresh token,
  Sarvam key, admin key). It is **local-only — never commit or push it**, and don't
  echo the values. The committed copy must not contain the appendix.
- **Live actions:** deploys, ZCQL/Data Store writes, and console changes hit the
  real project. Confirm the exact command before running; avoid destructive ops.
- **Commits:** don't create commits unless explicitly asked.
- **Node runtime:** keep function code Node 18-compatible.

---

## 9. AppSail forecast engine

The forecast is served by `ml/service`, which runs the `ml/engine` package — the same code
every number in `ml/RESULTS.md` was measured on. Deploy:

```bash
./ml/service/deploy.sh            # syncs ml/engine, vendors wheels, catalyst deploy --only appsail
curl -s https://kspforecast-50044266480.development.catalystappsail.in/health
```

`deploy.sh` copies `ml/engine` into the service directory because a build cannot reach outside
its context, and vendors the dependencies because the managed Python runtime does **not** install
`requirements.txt`. Re-vendoring is ~200 MB and is keyed on the requirements hash, so a redeploy
that only changes `app.py` skips it. Both generated directories are gitignored — `ml/engine` is
the single source of truth, and a served model that differs from the backtested one invalidates
the accuracy claims.

### Traps, all of which cost real time

- **The runtime has `python3`, not `python`.** A wrong startup command surfaces only as
  `Execution failed. Please check the startup command or port.`
- **There are no CLI logs for AppSail** and no `appsail:list`. When a container will not start,
  deploy a stdlib-only probe that reports `sys.path`, `os.listdir` and per-module import errors
  over HTTP — it cannot fail for the reasons the real app can, so whatever it says is the truth.
  That is how the `python3` problem was found after several blind redeploys.
- **`appsail:add` only accepts managed stacks for a source directory.** A custom Docker runtime
  needs a registry image URL, so a `Dockerfile` in the source is ignored.
- **LightGBM is deliberately not a dependency.** scikit-learn's `HistGradientBoostingRegressor`
  provides `loss="poisson"` and `loss="quantile"` natively, which is what the engine needs, and
  avoids vendoring a binary wheel plus libgomp. The engine prefers LightGBM when present
  (offline, and on Modal) and records the backend in every result, so numbers are never compared
  across backends by accident. Live is `sklearn-histgb-poisson` at MASE 0.820 against LightGBM's
  0.799 on the national monthly panel.
- **`--timeout-keep-alive`** matters: a national 640-district forecast takes ~28 s.

### Refreshing the served snapshot

```bash
ADMIN_KEY=... node datastore/refresh-forecast.js          # all states
ADMIN_KEY=... node datastore/refresh-forecast.js --states Karnataka
```

One state per request, because 28 s does not fit a Function's 25 s ceiling. Each call replaces
only its own rows inside the shared national scope. Requires the `Forecasts` and
`ForecastMetrics` tables (schema in `datastore/SCHEMA.md`); without them the read routes fall
back to live computation, so this is optional and additive.

---

## 10. Data Store migration and load

### Schema, applied via the console over CDP

The Catalyst CLI cannot change Data Store schema, and neither browser MCP works on this
machine — the Playwright server runs an unauthenticated profile and the Chrome DevTools server
needs an X server. So Chrome is launched on the existing X display with a debug port and
Playwright attaches over CDP:

```bash
DISPLAY=:10 google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/kspchrome \
    --password-store=basic --no-first-run "https://console.catalyst.zoho.in/baas/index" &
node tools/drive.js tools/steps/table-columns.js Cases
node tools/drive.js tools/steps/add-column.js Cases StateName:text TalukName:text
node tools/drive.js tools/steps/create-table.js Forecasts ForecastMetrics
```

Steps are idempotent and verify against the rendered schema rather than trusting a click. They
drive the console's `data-zcqa` hooks, which are stable across UI releases in a way CSS classes
are not. `openTable` always reloads the route: a left-open inline editor blocks clicks on the
table list and shows up as a click timeout on an element the log says it resolved.

Applied: `Cases` + StateName/TalukName/LocalityName, `Victims` + Caste/Religion, and the
`Forecasts` (21 columns) / `ForecastMetrics` (10 columns) tables.

> If a fresh Chrome profile lands on the sign-in page, the Zoho session cookies are
> **non-persistent** and a new profile never loads them. `tools/chrome-cookies.py` reads them
> out of a profile snapshot for injection — but note they only exist on disk while the session
> is live, and the file is rewritten without them.

### Loading, and the quota ceiling

```bash
KSP_API="https://ksp.cyberkunju.com/server/api" CONCURRENCY=8 node datastore/load.js
```

Concurrency is the difference between 200 rows/s and ~5,700 rows/s; the checkpoint advances
only across a contiguous prefix of completed batches, so an interrupted run resumes without
leaving a gap. Rerun the same command to resume from `datastore/seed/.load-state.json`.

**The binding constraint is the Catalyst subscription, not the API call budget.** A full-scale
load (1.5M cases, 8.24M rows) exhausts the plan amount partway through and the environment then
returns `SUBSCRIPTION_USAGE_LIMIT_REACHED` for *everything* — functions and AppSail included, so
the app goes down, not just the load. This was hit at ~608,000 rows.

Before a full load, either raise the plan or generate a dataset sized to it:

```bash
node datastore/generate-india.js --cases 150000 --years 3   # ~800k rows across 8 tables
```

Coverage of all 36 states and 640 districts is preserved at any `--cases` value; only the volume
per district shrinks. The forecast engine needs district-month history, not raw volume, so a
smaller corpus still exercises every code path — and `ml/RESULTS.md` is measured offline on the
full 27.4M-incident corpus regardless of what the Data Store holds.

---

## 11. ZCQL limits at scale, measured

At around a million rows in `Cases`, several dashboard endpoints started failing with a bare
`400 ... ZCQL QUERY ERROR, message: Error occurred during query processing`. That message names
neither the query nor the cause, so the limits were mapped by bisection through
`POST /admin/zcql` (admin-only, SELECT-only — it exists because there is no other scriptable way
to see what the store answers).

What was measured on 1,016,380 rows:

| Query | Result |
|---|---|
| `COUNT(ROWID) FROM Cases` | 330 ms |
| `GROUP BY Gravity` (3 groups) | 1.0 s |
| `GROUP BY Year` (3 groups) | 436 ms |
| `GROUP BY StateName` (36 groups) | **fails** |
| `GROUP BY StateName WHERE Year=2024` (36 groups, 512k rows) | 1.2 s |
| `GROUP BY StateName, DistrictName WHERE Year=…` (640 groups, 512k rows) | **fails** |
| `GROUP BY StateName, DistrictName WHERE StateName=…` (≤71 groups) | 1.1 s |
| 12 of those concurrently | **fails** |
| 4 of those concurrently | fine |

So there are two separate ceilings, and neither is about indexing: one scales with **rows scanned
× groups produced**, the other limits **concurrent query processing**. Both surface as the same
opaque error.

Consequences, applied in `analytics.js` and `forecast.js`:

- National aggregates are **partitioned and merged in process** — by `Year` where a few dozen
  groups suffice, and by `StateName` for district roll-ups, which also puts every partition under
  the 300-row `LIMIT` cap so no pagination is needed at all.
- Partitions run **4 at a time**: 36 sequential queries overshoot the function's execution
  ceiling, 12 concurrent ones trip the concurrency limit.
- `overview`'s KPI counts run **sequentially**. In parallel they failed intermittently, and a
  header that breaks one load in three is worse than one that takes four seconds.
- The 300-district cap on `hotspots` is gone. It existed because the roll-up was a single
  `LIMIT 300` query; now that the aggregate is assembled in process, all 640 districts are
  returned.

### Do not trust OFFSET or ORDER BY for pagination

Reading 640 stored forecast rows back was harder than writing them. `LIMIT offset, n` returned
**overlapping pages**, so a read produced one district twice and silently dropped another. Keyset
paging on `ROWID` then skipped rows, because Catalyst `ROWID`s are **not monotonic across insert
batches**. Both failures lost data without erroring.

The working pattern is a sequence column assigned at write time (`Forecasts.Seq`), read back in
explicit half-open ranges — which depends on neither `ORDER BY` nor `OFFSET`. Where a partition
naturally fits under 300 rows, prefer no pagination at all.

Inserts are also not exactly-once: a request can fail at the client after succeeding at the
server, and its retry writes a duplicate. `POST /admin/forecast/dedupe` repairs that; it refuses
to treat a row as its own duplicate, because under the old offset paging the same physical row
appeared on two pages and "removing the older copy" deleted real districts.
