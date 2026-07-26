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

---

## 12. WhatsApp field-officer channel — provisioned state

Design and security model: `documentation/15-whatsapp-field-bot.md`. This section is only what
is live in this environment and what still needs an account-level action.

### Provisioned

| Resource | Value | How |
|---|---|---|
| Data Store tables | `Officers` (19 cols), `WaMessages` (14), `PersonPhotos` (21) | `tools/steps/create-table.js` + `add-column.js` over CDP |
| Stratus bucket | `ksp-field-photos` — permission **authenticated**, encryption **on**, PII/ePHI **on**, versioning off | `node tools/drive.js tools/steps/create-bucket.js ksp-field-photos` |
| Job pool | `kspwaturns` — type Webhook, max concurrent 5 | `node tools/drive.js tools/steps/create-jobpool.js` |
| Alert cron | `ksp_wa_early_warning` — daily 06:30 IST, `POST /whatsapp/alerts/dispatch` with `x-wa-internal-key` | `node tools/drive.js tools/steps/create-cron.js` |
| Secrets | `WA_APP_SECRET`, `WA_VERIFY_TOKEN`, `WA_INTERNAL_KEY`, `WA_JOBPOOL` + tuning keys | gitignored `functions/api/catalyst-config.json` |

All three steps are idempotent and re-runnable. Verify with:

```bash
curl -s https://ksp.cyberkunju.com/server/api/whatsapp/health -H "x-admin-key: $ADMIN_KEY"
```

### The number is now exclusively ours

`+91 94002 45958` (phone id `1079257601947704`, WABA `2306127019919794`, Meta app
`2592724907814162`) was wired into **three** projects at once on `reticule`
(`16.112.233.198`): SellThat, Tia and Versifine. A WhatsApp number delivers to exactly one
webhook, so "sharing" it meant whichever project last claimed a callback silently owned
inbound for all of them. It is now assigned to KSP alone.

**There are three levels of webhook configuration and the most specific one wins.** This is
the trap that cost the most time here. Repointing the app-level callback to KSP reported
`success: true` and changed nothing, because a **phone-number-level override** was still set
to `https://sellthat.in/webhook/whatsapp`. It is invisible unless you ask for it:

```bash
curl -s "https://graph.facebook.com/v23.0/2306127019919794/phone_numbers?access_token=$TOK"
# -> webhook_configuration: { phone_number: ..., application: ... }
```

All three levels are now KSP: app-level (`POST /<app-id>/subscriptions`), phone-number-level
(`POST /<phone-id>` with `webhook_configuration.override_callback_uri`), and the WABA has no
`override_callback_uri` on `subscribed_apps`. Set the phone-number one — the app-level alone
is not enough.

Server side, on `reticule`:

| Action | Detail |
|---|---|
| Stopped, `--restart=no` | `tia-whatsapp-1`, `versifine-bot`, `sellthat-backend-1` |
| Credentials commented out | `/opt/sellthat/backend/.env`, `~/Deploy/tia/.env`, `/etc/versifine/wabot.env` |
| Webhook routes retired | `/etc/nginx/snippets/sanket-webhook.conf` and the two blocks in `sellthat.in.conf` now `return 410` |
| Backups | `/opt/wa-dismantle-backup-<timestamp>/`, path recorded in `/opt/wa-dismantle-latest.txt` |

`sellthat.in/webhook/whatsapp` returns **410** and `tia.cyberkunju.com/webhook/whatsapp`
returns **502** (its container is down behind the Cloudflare tunnel), so nothing on that host
can answer Meta's handshake and re-claim the number.

**Consequence worth stating plainly:** SellThat's only input path was WhatsApp, so stopping
`sellthat-backend-1` also takes `sellthat.in`'s API down — the web container still serves the
SPA. Tia and Versifine lose only their WhatsApp workers; their api/web/db containers are
untouched and still running. To reverse any of it, restore the files from the backup
directory, `docker update --restart=unless-stopped` and start the container, then repoint the
phone-number override.

### Meta credentials — wired

Real credentials are in place, taken from the same Meta app this machine's other WhatsApp
projects use (`Projects/Tia`, `Projects/Versifine`, `sellthat`):

| | |
|---|---|
| Meta app | `2592724907814162` ("Versifine") |
| Sender | `+91 94002 45958` · phone id `1079257601947704` · APPROVED · quality GREEN · `account_mode: LIVE` |
| Token | SYSTEM_USER, **never expires**, scopes `whatsapp_business_management`, `whatsapp_business_messaging`, `business_management` |
| `WA_APP_SECRET` | the app's real secret, so genuine Meta signatures verify |
| `DATA_WINDOW` | `2023-07..2025-06` — see below, this one is not cosmetic |

**Outbound works and is verified live.** A signed inbound webhook, an agent turn, a Kannada
turn and two early-warning alerts were all delivered to a real handset, and a second dispatch
suppressed both alerts as duplicates.

**Inbound arrives at KSP and delivery receipts land in `WaMessages`.** That last part matters
more than it sounds: before the takeover, a business-initiated message outside Meta's 24-hour
window was accepted with a message id and then dropped, and the `failed` status went to
SellThat's webhook — so our ledger said `sent` and the handset showed nothing, with no way to
tell the difference. Receipts now come to us.

**The WABA id could not be fetched, only learned.** `me/businesses` is empty and every WABA
edge and phone→WABA expansion is rejected for a system-user token. It was recovered from a
15-digit id left in SellThat's container logs, confirmed against the Graph API, and the code
now captures `entry[0].id` from any callback so a fresh environment never needs that
archaeology (`lib/wa/inbound.js`, reported by `/whatsapp/health`).

**Templates are off by policy, and off structurally.** This deployment sends free-form only,
inside Meta's 24-hour service window, because a template is billable. `sendTemplate()` refuses
unless `WA_ALLOW_TEMPLATES=true` — the guard sits at the transport, not at the one call site
that exists today, so a future code path cannot reintroduce a template send by accident. An
alert for a closed window is **deferred**: nothing is written to the ledger, so the dedupe key
stays unclaimed and a later cycle still delivers it. And because a cron only reaches whoever
happens to be reachable when it fires, `flushAlertsFor()` runs at the end of every turn — an
officer who has just messaged us definitionally has an open window, so their own message is the
most reliable delivery trigger there is.

**Alert template.** `ksp_early_warning_v2`, UTILITY, four body parameters — approved and kept,
but unusable while the flag is off, so the review wait is already paid for whenever templates
are switched on. The `_v2` is not cosmetic: deleting a template puts a short lock on that name and language, `POST` then fails
with `Message template language is being deleted`, and re-issuing the `DELETE` restarts the
clock — so a delete-then-create script can never succeed. Meta's own advice is to use a new
name. The shape is dictated by the sender: `client.js sendTemplate()` emits a single `body`
component, so all four placeholders must live in the BODY. A header placeholder would fail
only when a real alert fires outside the window, which is the worst moment to discover it.

Testing inbound needs no Meta routing at all — with the real app secret you can sign a webhook
yourself, which is how the channel was verified before the takeover.

### Traps, all of which cost real time

**The SDK version is load-bearing.** `app.stratus()` and `app.jobScheduling()` only exist in
`zcatalyst-sdk-node` **3.x**; the `^2.1.1` range resolved to 2.5.1, where photo enrolment throws
on the first real photo and the async webhook path can never succeed. Neither failure is visible:
enqueue is *designed* to fall back inline rather than lose an officer's message. Every namespace
the rest of the API uses keeps the same surface in 3.4.0.

**`job_name` is capped at 20 characters** and Catalyst rejects the entire submission when it is
longer (`job_name should be within 1-20 char length`). A name built from a wamid was 26, so every
turn fell back inline. This is why `/whatsapp/health` now *probes* the SDK namespaces and resolves
the job pool instead of reporting whether an env var is set, and why the webhook answers with
`{received, queued, duplicates, inline, enqueueError}` — counts only, never content, on an
HMAC-gated endpoint. Without that, a broken queue and a working one are indistinguishable.

**Console naming rules contradict each other and fail silently.** A cron name must be
alphanumeric *and underscores*, hyphens rejected — the API says so in a response body the console
never renders, so the form just sits there looking saved. A job pool name must be alphanumeric
*only*, no underscores, and the console sends **no request at all**, so it is indistinguishable
from a dead button. Both rules are encoded in the steps, which now surface the API's own rejection.

**The Stratus create dialog defaults are wrong for this bucket.** It holds face photographs of
identifiable people, and Public sits one radio button from the default while encryption and
PII/ePHI are off unless ticked. `create-bucket.js` sets all three and refuses to create a public
bucket, which is why it is a step and not a docs instruction.

**A job retry can answer an officer twice, and the guard was on the wrong path.** Catalyst decides
a webhook job failed from the HTTP response it sees, so a turn slower than that timeout is
re-dispatched whatever status code the function eventually returns — `processEvent`'s "retry only
if the agent had not started" rule never gets consulted. Meanwhile duplicate suppression lived
only in `acceptWebhook`, because `claimMessage` also writes the inbound ledger row and so can run
once per message; the job POSTs straight to `/whatsapp/process` and skipped it. The first real turn
was answered twice, 60 seconds apart. `processEvent` now refuses a message already marked
complete, which is also what makes the documented promise about not enrolling a photo twice true.

**A gap in the data must never read as an absence of crime.** Asked "how many cases in Hoshiarpur
this year", the bot answered *"No cases in Hoshiarpur this year (2026). The database shows 0
records for that district in 2026."* — true of the table, and to an officer it says there is no
crime in their district. Putting the coverage in the system prompt was not enough: asked directly
the model reports the window correctly and still answered from the 2026 query. `lib/wa/window.js`
therefore attaches a note to any query filtered outside `DATA_WINDOW`, in the observation the
model reasons over. Note the first version of that check keyed on an empty result and never fired
once, because the model asked `COUNT(ROWID)`, which returns one row containing zero.

**Alerts must read the snapshot, not recompute.** `dispatchAlerts` originally called
`computeEarlyWarning`, which assembles a national panel and therefore hits the §11 ZCQL ceiling at
a million rows — every cron cycle failed with an opaque 400. `backtest.earlyWarningPreferSnapshot`
reads the batch-scored snapshot and falls back to live computation on a fresh environment, which
also guarantees an officer's push says the same thing the dashboard says.

### Removing a number from the roster

Day-to-day revocation is `POST /admin/officers` with `{"active": false}` — the lookup refuses an
inactive row and the row remains as the record that this number held access. `DELETE
/admin/officers` is for a number that should never have been registered:

```bash
curl -X DELETE .../admin/officers -H "x-admin-key: $ADMIN_KEY" \
  -H 'Content-Type: application/json' -d '{"phone":"919999900001","purgeLedger":true}'
```

The `WaMessages` ledger is kept by default because it is the audit trail for data that number was
shown. `purgeLedger` runs whether or not a roster row existed — the number that most needs its
ledger cleared is one that was never an officer.
