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
