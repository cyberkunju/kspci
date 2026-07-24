# 11 · Feature Status (Accurate & Honest)

Status legend: ✅ Done & live · 🟡 Partial / caveat · 🔵 Optional / not built.

## Mandatory features

| # | Feature | Status | Notes |
|---|---|:--:|---|
| 1 | NL chatbot, English + Kannada | ✅ | Agentic GLM‑4.7‑Flash text‑to‑ZCQL, grounded. |
| 2 | Voice interaction (STT + TTS) | ✅ | Sarvam `saarika:v2.5` + `bulbul:v3`; round‑trip verified EN + KN. |
| 3 | Context‑aware multi‑turn | ✅ | Last 3 turns pulled from `AuditLog` into the prompt. |
| 4 | Save conversation as PDF (local) | ✅ | Client‑side print‑to‑PDF (`lib/pdf.js`). Server `/chat/:id/pdf` is an unused 501 stub. |
| 5 | Criminal network visualization | ✅ | d3‑force graph over `CoAccusedLinks`; ring detection. |
| 6 | Hotspot / trend analytics | ✅ | Leaflet map + Chart.js trends; seasonality modelled. |
| 7 | Predictive / early warning | ✅ | Ensemble + AppSail ML champion; real‑data validated; JS fallback. |
| 8 | Explainable AI + audit trail | ✅ | Evidence panel + `AuditLog` table + `GET /chat/:sessionId`. |
| 9 | RBAC | ✅ | 5 roles, per‑route guards. |
| + | OCR FIR ingestion | ✅ | Catalyst Zia OCR → LLM structuring → Data Store insert. |

## 10‑point framework

| # | Point | Status |
|---|---|:--:|
| 1 | Conversational Crime Intelligence Interface | ✅ |
| 2 | Criminal Network & Relationship Analysis | ✅ |
| 3 | Crime Pattern & Trend Analytics | ✅ |
| 4 | Sociological Crime Insights | ✅ |
| 5 | Criminology‑Based Offender Profiling | ✅ |
| 6 | Investigator Decision Support | ✅ |
| 7 | Financial Crime & Transaction Link Analysis | ✅ |
| 8 | Crime Forecasting & Early Warning | ✅ |
| 9 | Explainable AI & Transparent Analytics | ✅ |
| 10 | Secure Role‑Based Access & Governance | ✅ |

## Infrastructure

| Component | Status | Notes |
|---|---|:--:|
| Catalyst project (Project‑Rainfall, India DC) | ✅ | Live. |
| Advanced I/O Function `api` | ✅ | Node 18, 1 GB, all routes live. |
| Data Store (10 tables) | ✅ | Seeded ~1.5 lakh rows. |
| AppSail Python ML service | ✅ | Live; scale‑to‑zero (not 24×7). Deps vendored (or Dockerfile). |
| Client hosting `/app` | ✅ | Astryx SPA. |
| Custom domain + SSL (`ksp.cyberkunju.com`) | ✅ | `/app` and `/server/api` both route. |

## Data seeding (verified counts)

| Table | Rows |
|---|--:|
| Cases | 19,791 |
| Accused | 42,900 |
| Victims | 16,227 |
| Complainants | 19,791 |
| Arrests | 11,997 |
| CoAccusedLinks | 20,000 |
| OffenderRisk | 345 |
| FinancialTxns | 20,000 |
| ChatSessions / AuditLog | grows at runtime |

## Predictive engine — accuracy claims (honest)

- **Real‑data validation (the proof)**: 2.49M Chicago incidents, leak‑free walk‑forward — champion
  **MASE 0.811, PAI@1% 6.24, 90% coverage 91.1%** (grid×day); best MASE 0.700 (beat×week). Beats
  seasonal‑naive by 18–30% and the police historical‑pattern baseline by 1–3%.
- **Synthetic KSP self‑check**: at coarse district×month granularity the series is near seasonal‑naive
  (MASE ≈ 1.05) — reported honestly in the dashboard as a "live self‑check", with the real‑data
  validation shown as the actual proof.

## Optional / not built (backlog)

| Item | Status |
|---|:--:|
| Cron + Catalyst Mail proactive alert push | 🔵 |
| `SUBMISSION.md` demo/pitch doc | 🔵 |
| `ADMIN_KEY` env‑only (remove hard‑coded default) | 🟡 hardening |
| RBAC bound to Catalyst Authentication claims (vs header) | 🟡 hardening |
| Client bundle code‑splitting (~950 KB) | 🔵 optimization |
| Additional QuickML models (e.g. Qwen 3.6 VL) as alternate LLMs beyond the active GLM‑4.7‑Flash | 🔵 alternate provider |

Continue to [12-setup-build-run.md](./12-setup-build-run.md).
