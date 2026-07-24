# 10 · Security & Governance (Framework #10)

## Role‑Based Access Control (RBAC)

Five roles: `investigator`, `analyst`, `supervisor`, `policymaker`, `admin`.

- Enforced by `requireRole(...allowed)` middleware in `functions/api/index.js`.
- The role arrives as the `x-user-role` header (front end sends the selected role; in a full
  production deployment this maps to a **Catalyst Authentication** user role/claim rather than a
  client‑supplied header).
- Unknown role → `400`; disallowed role → `403 { error:'forbidden for role', role }`.

**Route access matrix:**

| Route group | investigator | analyst | supervisor | policymaker | admin |
|---|:--:|:--:|:--:|:--:|:--:|
| chat, voice, overview, hotspots, trends, sociology, forecast, earlywarning, brief, investigator/case | ✅ | ✅ | ✅ | ✅ | ✅ |
| network, offenders, financial, moneytrail, backtest, watchlist | ⛔ | ✅ | ✅ | ✅ | ✅ |
| ingest/ocr | ✅ | ✅ | ✅ | ⛔ | ✅ |
| /admin/* | — (key‑guarded, not role‑guarded) | | | | |

## Audit trail & traceability

- **`AuditLog`** row on every `/chat` call: `AuditID`, `SessionID`, `UserId`, `Role`, `QueryText`,
  `GeneratedZCQL`, `CitedRecordIDs`, `ReasoningPath`, `ModelUsed`, `AnswerText`, `CreatedAt`.
- **`ChatSessions`** row per conversation (user, role, language, title, created).
- History retrievable via `GET /chat/:sessionId` — full accountability of who asked what, which query
  ran, which records were cited, and what was answered.

## Explainable AI

- Every answer is **grounded** — the model can only report rows returned by a read‑only ZCQL query it
  itself generated; no free‑floating claims.
- The **Evidence & Reasoning** panel surfaces the generated ZCQL, the rationale, the cited records,
  and the raw result table for each answer — the transparency layer that satisfies law‑enforcement
  accountability requirements.

## ZCQL query safety

`lib/chat.js` hard‑guards every model‑generated query before execution:
- `SELECT`‑only; rejects `insert|update|delete|drop|alter|create|truncate|grant|revoke`.
- No semicolons (blocks statement chaining / injection‑via‑second‑statement).
- Forces `LIMIT` (adds `LIMIT 200`, caps larger). Single table, no JOINs.
- The Data Store connection used for chat is read via ZCQL; the only write paths are the guarded
  admin seeder and OCR ingestion.

## Content / behavioural safety

`lib/guard.js` (`assessSafety`) — a **deterministic pre‑check** so safety isn't left to the model:
- Self‑harm → crisis‑line guidance (112 / KIRAN 1800‑599‑0019), EN/KN.
- Real‑world harm enablement (weapons/explosives/CBRN synthesis) → refuse + redirect.
- Everything else passes (discussing crimes in the dataset is the tool's job).
- The system prompt adds prompt‑injection resistance (ignore user/data instructions to reveal
  internals or break rules) and reinforces read‑only scope.

## Fairness framing

Throughout the predictive/sociological features the platform frames outputs as **exposure‑normalized
decision‑support, not automated enforcement**, with explicit caveats in payloads and the LLM brief
prompt. Sociological aggregates are never used to profile individuals.

## Secrets hygiene

- Real keys live only in `functions/api/catalyst-config.json` (**git‑ignored**) and Catalyst function
  env vars; `catalyst-config.example.json` ships placeholders. Keys are used **server‑side only** — the
  browser never sees the Zoho QuickML / Sarvam keys.
- `.gitignore` excludes `node_modules`, build output, `.venv`, ML data/parquet, seed/train CSVs,
  `.env*`, `*.pem`, `*.key`, and the confidential `Police_FIR_ER_Diagram.pdf`.

## Known items / hardening backlog

| Item | Note |
|---|---|
| `datastore/load.js` `ADMIN_KEY` default | Hard‑coded fallback `ksp-2026-seed-9f3ab7c1d84e`; make env‑only before public release. |
| RBAC via header | Currently trusts `x-user-role`; wire to Catalyst Authentication claims for production trust. |
| `AuditLog.ModelUsed` label | Written as `GLM_MODEL||'glm'`; matches the active model, GLM‑4.7‑Flash. |
| `lib/pdf.js` header glyph | The exported PDF report header uses a 🛡️ shield glyph (the app UI itself has no emoji). |
| Proactive alerts | Cron + Catalyst Mail for push early‑warning alerts is a possible enhancement (not built). |

Continue to [11-feature-status.md](./11-feature-status.md).
