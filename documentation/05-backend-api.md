# 05 · Backend API Reference

Base URL: `https://ksp.cyberkunju.com/server/api` (also the Catalyst dev domain `/server/api`).
Implemented by the Express app in `functions/api/index.js`. All requests/responses are JSON
(`express.json({ limit: '10mb' })`).

## Authentication & RBAC headers

RBAC is header‑based (the front end sends the selected role; in a full deployment this maps to
Catalyst Authentication user roles).

| Header | Meaning |
|---|---|
| `x-user-role` | one of `investigator`, `analyst`, `supervisor`, `policymaker`, `admin` (default `investigator`) |
| `x-user-id` | user identifier for audit logging (default `demo-user`) |
| `x-admin-key` | required for `/admin/*` endpoints; must equal `ADMIN_KEY` |

`requireRole(...allowed)` middleware validates the role and enforces per‑route access. Unknown role →
`400`; disallowed role → `403 { error: 'forbidden for role', role }`.

## Health & lifecycle

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/` | any | `{ service, status:'ok' }` |
| GET | `/health` | any | `{ service, status, catalyst:bool, time, phase }` |
| POST | `/warmup` | any | Pings the LLM with a 1‑token request to warm the instance. Client calls on load. Returns `{ warm, ms }`. |

## Conversational core

### `POST /chat`
Grounded, agentic natural‑language query. **Body**: `{ question, sessionId?, language? }`
(`language` = `en`|`kn`). Headers: role + user id.

Flow: creates a `ChatSessions` row if new; pulls the last 3 turns from `AuditLog` for multi‑turn
context; runs `handleChat()` (agentic tool‑calling loop, up to 5 steps); writes an `AuditLog` row.

**Response:**
```json
{
  "sessionId": "sess_...",
  "answer": "The 5 districts with the most cases are: 1. Bengaluru City — 5,328 ...",
  "zcql": "SELECT DistrictName, COUNT(ROWID) FROM Cases GROUP BY DistrictName ORDER BY COUNT(ROWID) DESC LIMIT 5",
  "rationale": "Identify the five districts with the highest total case volume.",
  "citations": [ { "type": "FIR|Case|Person", "id": "..." } ],
  "rowCount": 5,
  "rows": [ { "DistrictName": "Bengaluru City", "COUNT(ROWID)": 5328 }, ... ],
  "reasoning": "",
  "role": "investigator",
  "language": "en"
}
```

### `GET /chat/:sessionId`
Returns the full audit trail for a session (multi‑turn history) ordered ascending:
`{ sessionId, turns: [{ QueryText, AnswerText, GeneratedZCQL, CitedRecordIDs, ReasoningPath, CREATEDTIME }] }`.

### `POST /chat/:sessionId/pdf`
**Stub** — returns `501 { error:'not_implemented' }`. PDF export is implemented **client‑side**
(browser print‑to‑PDF in `client/src/lib/pdf.js`), so the feature works without this endpoint.

## Voice (Sarvam AI)

| Method | Path | Body | Description |
|---|---|---|---|
| POST | `/voice/stt` | `{ audio(base64), mime?, language? }` | Speech‑to‑text via Sarvam `saarika:v2.5`. Returns `{ text, language }`. |
| POST | `/voice/tts` | `{ text, language? }` | Text‑to‑speech via Sarvam `bulbul:v3` (speaker `ritu`, mp3). Returns `{ audio(base64), mime }`. Text capped at 2500 chars. |

Language mapping: `kn → kn-IN`, else `en-IN` (STT accepts `unknown` for auto‑detect).

## OCR ingestion

### `POST /ingest/ocr`
Roles: investigator, analyst, supervisor, admin. **Body**: `{ fileBase64, filename?, language?, insert? }`.
Runs Catalyst Zia OCR → LLM structures fields → inserts into `Cases` (+ `Accused`)
when `insert !== false`. Returns `{ engine, confidence, text, structured, inserted }`.
See [06-conversational-ai.md](./06-conversational-ai.md#ocr-fir-ingestion).

## Analytics (`lib/analytics.js`)

| Method | Path | Roles | Returns |
|---|---|---|---|
| GET | `/analytics/overview` | any | KPI totals: cases, accused, heinous(+pct), chargesheeted(+rate), high‑risk offenders, districts. |
| GET | `/analytics/hotspots` | any | `{ districts:[{name,count,lat,lng}], points:[{lat,lng,sub,district}] }`. |
| GET | `/analytics/trends` | any | `{ byMonth, byHead, byStatus, byGravity }`. |
| GET | `/analytics/network` | analyst+ | Co‑accused graph `{ nodes, links, rings }`. Query `?ring=`. |
| GET | `/analytics/offenders` | analyst+ | Ranked `OffenderRisk` rows. Query `?band=`. |
| GET | `/analytics/financial` | analyst+ | Largest transactions. |
| GET | `/analytics/sociology` | any | Demographic aggregations (age/gender/occupation/religion/caste + crime×gender). |
| GET | `/analytics/moneytrail` | analyst+ | Money‑flow graph + suspicious hubs (mule/layering detection). |

*"analyst+" = analyst, supervisor, policymaker, admin.*

## Investigator decision support

### `GET /investigator/case`
Roles: any. Query `?crimeNo=` (or `?caseId=`) `&language=`. Assembles a 360° dossier: full case
record, accused/victims/complainants/arrests, investigation timeline, similar past cases + outcome
stats, and an LLM‑generated summary + investigative leads. See framework #6.

## Predictive / early‑warning (`lib/backtest.js`)

| Method | Path | Roles | Returns |
|---|---|---|---|
| GET | `/analytics/forecast` | any | Per‑district next‑month forecast (predicted/low/high/baseline/trend/z), horizon, weights, `servedBy`. |
| GET | `/analytics/earlywarning` | any | Alerts (critical/elevated/watch) from forecast‑vs‑baseline z‑scores. |
| GET | `/analytics/backtest` | analyst+ | Walk‑forward model comparison table, spatial metrics (Hit‑Rate/PAI/PEI), conformal, statewide series, + `validation` (real Chicago headline). |
| GET | `/analytics/watchlist` | analyst+ | Reoffending watchlist with logistic reoffend probability. Query `?limit=`. |
| GET | `/analytics/brief` | any | LLM‑written decision‑ready early‑warning brief (English/Kannada) from live forecast + alerts. |

## Admin (seeding & maintenance) — `x-admin-key` required

| Method | Path | Description |
|---|---|---|
| GET | `/admin/seed` | list bundled seed tables + counts |
| POST | `/admin/seed` | insert a batch from bundled CSV `{table,offset,limit}` |
| POST | `/admin/insert` | insert client‑supplied `{table, rows}` (used by `datastore/load.js`) |
| GET | `/admin/status` | per‑table `COUNT(ROWID)` |
| POST | `/admin/reset` | clear tables `{tables?}` before re‑seed |

## Errors & conventions

- `400` — missing/invalid input (e.g. no `question`, unknown role/table).
- `401` — bad/missing admin key.
- `403` — role not permitted for the route.
- `501` — declared‑but‑unimplemented (only `POST /chat/:sessionId/pdf`).
- `500` — handler error `{ error:'<name>_failed', message }`.
- `404` — unknown route `{ error:'not_found' }`.
- All analytics/forecast routes are wrapped so an internal error returns `{ error:'<fn>_failed', message }`.

## ZCQL safety (applies to all model‑generated queries)

Enforced in `lib/chat.js` before any query runs:
- Must start with `SELECT`; **rejects** `insert|update|delete|drop|alter|create|truncate|grant|revoke`.
- **No semicolons** (no statement chaining).
- **LIMIT enforced** — appends `LIMIT 200` if absent; caps any larger limit to 200.
- Single table, no JOINs (schema is denormalized so none are needed).
- Grouped analytics that need >300 rows are **paged** with `LIMIT offset,count` (ZCQL caps LIMIT at 300).

Continue to [06-conversational-ai.md](./06-conversational-ai.md).
