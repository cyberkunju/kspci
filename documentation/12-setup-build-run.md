# 12 · Setup, Build & Run

## Prerequisites

- Node.js 18+ and npm
- Zoho **Catalyst CLI** (`npm i -g zcatalyst-cli`), logged in to the project's account
- Zoho QuickML LLM access (GLM‑4.7‑Flash) — a Self‑Client OAuth refresh token (scope `QuickML.deployment.READ`) — and a Sarvam AI key
- (ML research only) Python 3.12 + a GPU for the neural head‑to‑head

## 1 · Clone & install

```powershell
# function deps
cd functions/api ; npm install ; cd ../..
# client deps
cd client ; npm install ; cd ..
```

## 2 · Configure the function

Copy the template and fill in real values (this file is git‑ignored):

```powershell
Copy-Item functions/api/catalyst-config.example.json functions/api/catalyst-config.json
```

Set at minimum: `ADMIN_KEY`, `LLM_PROVIDER=quickml`, `QUICKML_MODEL=crm-di-glm47b_30b_it`,
`QUICKML_LLM_ENDPOINT`, `QUICKML_ORG_ID`, the Zoho OAuth vars
(`ZOHO_CLIENT_ID`/`ZOHO_CLIENT_SECRET`/`ZOHO_REFRESH_TOKEN`/`ZOHO_ACCOUNTS_URL`), `SARVAM_API_KEY`,
`FORECAST_SERVICE_URL` (your AppSail URL). Full list: [03‑infrastructure](./03-infrastructure-and-deployment.md#function-environment-variables).

## 3 · Create the Data Store tables

Create the **10 tables** exactly as specified in `datastore/SCHEMA.md` (Catalyst console →
Data Store → Create Table). Column names must match exactly.

## 4 · (Optional) Regenerate synthetic data

```powershell
node datastore/generate.js            # writes datastore/seed/*.csv and datastore/train/*.csv
```
Seed CSVs also ship bundled in `functions/api/seed/` for the function's own `/admin/seed`.

## 5 · Deploy the function

```powershell
catalyst deploy --only functions --org 60079622152
```

## 6 · Seed the Data Store

```powershell
# streams local CSV batches to POST /admin/insert using ADMIN_KEY
$env:ADMIN_KEY = "<your-admin-key>"
node datastore/load.js
# verify
#   GET /server/api/admin/status   (header x-admin-key)
```

## 7 · Build & deploy the client

```powershell
cd client
npm run build                                   # → client/dist (+ copy-config.cjs)
cd ..
catalyst deploy --only client --ignore-scripts --org 60079622152
```

## 8 · Deploy the AppSail ML service

From `ml/service` (vendored‑wheels path — managed Python runtime):
```powershell
# ensure ml/service/vendor/ holds the Linux cp312 wheels (numpy, scipy, scikit-learn,
# fastapi, uvicorn, pydantic); startup command MUST use python3:
catalyst appsail deploy --command "python3 app.py" ...
```
Or use the included `Dockerfile` (custom OCI runtime) which `pip install`s `requirements.txt`.
After deploy, set the function's `FORECAST_SERVICE_URL` to the AppSail URL.

## Local development

**Function** (Catalyst local serve):
```powershell
catalyst serve            # exposes the function at http://localhost:3000
```

**Client** (Vite dev server — proxies `/server` → `localhost:3000`):
```powershell
cd client ; npm run dev   # http://localhost:5173
```

**Client production preview**:
```powershell
cd client ; npm run build ; npm run preview   # serves dist/ (no backend proxy)
```

> On Windows PowerShell, use `;` to chain commands (not `&&`). Long CLI commands (deploys) can hit
> shell timeouts — redirect output to a log and read it back if needed.

## ML validation (reproduce the real‑data proof)

```bash
cd ml
python -m venv .venv && source .venv/bin/activate   # (Windows: .venv\Scripts\activate)
pip install -r requirements.txt
python ingest_chicago.py --start 2014-01-01 --end 2024-01-01   # 2.49M incidents → parquet
python get_covariates.py                                       # weather + holidays
python eval_harness.py --unit grid --grid-m 400                # weekly grid backtest
python eval_daily.py   --unit grid --grid-m 700                # daily grid + covariates
python train_neural.py --unit grid --grid-m 700 --epochs 8     # GPU GRU head-to-head
```
Results are written under `ml/data/eval_*.json`; the summary lives in `ml/RESULTS.md`.

## Smoke test (after deploy)

```
GET  /server/api/health                      → { status:'ok', catalyst:true }
POST /server/api/warmup                       → { warm:true }
POST /server/api/chat  {question:"top 5 districts by cases"}   (header x-user-role:investigator)
GET  /server/api/analytics/overview
GET  /server/api/analytics/forecast          → check servedBy = appsail (or fallback)
```

Continue to [13-file-reference.md](./13-file-reference.md).
