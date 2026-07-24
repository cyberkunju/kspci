# 03 · Infrastructure & Deployment

## Catalyst project

| Item | Value |
|---|---|
| Project name | **Project-Rainfall** |
| Project ID | `51589000000013024` |
| Environment / Org ID | `60079622152` (Development) |
| Data center | **India (`.in`)** |
| Timezone | Asia/Kolkata |
| Dev domain | `project-rainfall-60079622152.development.catalystserverless.in` |
| Custom domain | **`ksp.cyberkunju.com`** (SSL live; both `/app` and `/server/api` route) |

Binding lives in `.catalystrc`. Deploy config lives in `catalyst.json`:

```json
{
  "functions": { "targets": ["api"], "ignore": [".output", "node_modules"], "source": "functions" },
  "client":    { "source": "client/dist", "ignore": [] }
}
```

## Component 1 — Advanced I/O Function `api`

- **Path**: `functions/api` · **Entry**: `index.js` (`module.exports = app` Express app)
- **Stack**: `node18` · **Type**: `advancedio` · **Memory**: 1024 MB
- **Config**: `functions/api/catalyst-config.json` (git‑ignored, holds real keys).
  Template with placeholders: `catalyst-config.example.json`.
- **URL**: `https://ksp.cyberkunju.com/server/api` (and the dev domain `/server/api`).

### Function environment variables

| Variable | Purpose |
|---|---|
| `ADMIN_KEY` | Guards `/admin/*` seeding endpoints (`x-admin-key` header). |
| `LLM_PROVIDER` | `quickml` (Zoho QuickML GLM — the sole LLM path in `lib/llm.js`). |
| `QUICKML_MODEL` | `crm-di-glm47b_30b_it` (GLM‑4.7‑Flash). |
| `QUICKML_LLM_ENDPOINT` | Zoho QuickML GLM chat endpoint (server‑side only). |
| `QUICKML_ORG_ID` | Catalyst org id sent as the `CATALYST-ORG` header. |
| `SARVAM_API_KEY` | Sarvam AI key (STT/TTS voice only). |
| `SARVAM_STT_MODEL` | `saarika:v2.5`. |
| `SARVAM_TTS_MODEL` | `bulbul:v3`. |
| `SARVAM_TTS_SPEAKER` | `ritu`. |
| `FORECAST_SERVICE_URL` | AppSail base URL for the Python forecasting service. |
| `FORECAST_SVC_TIMEOUT_MS` | Optional; forecast service call timeout (default 25000). |
| `LLM_TIMEOUT_MS` | Optional; LLM call timeout (default 60000). |
| `ZOHO_CLIENT_ID` / `ZOHO_CLIENT_SECRET` / `ZOHO_REFRESH_TOKEN` / `ZOHO_ACCOUNTS_URL` | For `lib/oauth.js` (QuickML GLM OAuth token, scope `QuickML.deployment.READ`) — used on every LLM request. |

> **Active LLM path** is Zoho QuickML (GLM‑4.7‑Flash) (`LLM_PROVIDER=quickml`). `lib/oauth.js` fetches
> the Zoho QuickML OAuth token used to authorize every LLM request. It is the sole LLM — there is no
> third‑party GPT provider.

## Component 2 — Client hosting `/app`

- Built with Vite (`base: './'`) to `client/dist`; Catalyst serves it at `/app/index.html`.
- `client/scripts/copy-config.cjs` runs after `vite build` to copy `client-package.json` and a
  `404.html` into `dist` (SPA fallback / Catalyst client packaging).
- Dark theme is fixed on `<html data-astryx-theme="neutral" data-theme="dark">`.

## Component 3 — Data Store

- 10 tables (see [04-data-model.md](./04-data-model.md)). Created once via the Catalyst console.
- Seeded (~1.5 lakh rows) via the function's admin endpoints (see below).
- Current seeded counts (verified): Cases 19,791 · Accused 42,900 · Victims 16,227 ·
  Complainants 19,791 · Arrests 11,997 · CoAccusedLinks 20,000 · OffenderRisk 345 · FinancialTxns 20,000.

## Component 4 — AppSail Python ML service

- **Path**: `ml/service` (`app.py`, `Dockerfile`, `requirements.txt`, `test_client.py`).
- **URL**: `https://kspforecast-50044266480.development.catalystappsail.in`
- **appComputeId**: `51589000000311025` · **Memory**: 1 GB.
- **Runtime**: managed Python. **Startup command**: `python3 app.py`
  (AppSail runs the command directly with no shell, and only `python3` is on `PATH` — *not* `python`).
- **Dependencies**: since the managed Python runtime does **not** auto‑install `requirements.txt`,
  the Linux cp312 wheels (numpy, scipy, scikit‑learn, fastapi, uvicorn, pydantic) are **vendored**
  into `ml/service/vendor/` (~202 MB) and added to `sys.path` at the top of `app.py`.
  - Alternatively the included `Dockerfile` builds a custom OCI runtime (`python:3.12-slim`,
    `pip install -r requirements.txt`) — the container path installs deps normally.
- **Lifecycle**: serverless / scale‑to‑zero. Cold start on first request after idle; ~5‑min instance
  life; billed (~$0.08/GB‑hr) only while active, free when idle. It is **not** a 24×7 server.
- **Endpoints**: `GET /health`, `POST /forecast` (see [08-predictive-engine.md](./08-predictive-engine.md)).
- **Port**: AppSail injects `X_ZOHO_CATALYST_LISTEN_PORT`; `app.py` reads it from argv or env
  (fallback 9000).

## Deploy commands (Windows PowerShell)

> Long CLI commands can be killed by shell timeouts — deploys are run with output redirected to a
> log and read back. The CLI is logged in as `knavaneeth786@gmail.com`.

**Build the client:**
```powershell
cd client
npm run build          # vite build → client/dist  + copy-config.cjs
```

**Deploy the client only:**
```powershell
catalyst deploy --only client --ignore-scripts --org 60079622152
```

**Deploy the function:**
```powershell
catalyst deploy --only functions --org 60079622152
```

**Deploy the AppSail service** (from `ml/service`, with vendored wheels):
```powershell
catalyst appsail deploy --command "python3 app.py" ...   # see AppSail app config
```

## Seeding the Data Store

After the 10 tables exist and the function is deployed with `ADMIN_KEY`:

```powershell
# from repo root — parses CSVs locally, streams batches to POST /admin/insert
node datastore/load.js
# or a subset:
node datastore/load.js --only Cases,Accused
```

`datastore/load.js` reads `KSP_API` (defaults to the dev domain `/server/api`) and `ADMIN_KEY`.

## Secrets hygiene

- `functions/api/catalyst-config.json` (real keys) is **git‑ignored**; `catalyst-config.example.json`
  holds placeholders.
- `.gitignore` also excludes `node_modules`, `client/dist`, `ml/.venv`, `ml/data`, parquet files,
  seed/train CSVs, `Police_FIR_ER_Diagram.pdf`, and `.env*` files.
- **Known item**: `datastore/load.js` has a hard‑coded default `ADMIN_KEY` fallback
  (`ksp-2026-seed-9f3ab7c1d84e`) for convenience; before making the repo public this should be
  env‑only. See [10-security-and-governance.md](./10-security-and-governance.md).

Continue to [04-data-model.md](./04-data-model.md).
