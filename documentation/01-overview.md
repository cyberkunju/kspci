# 01 · Project Overview

## The challenge

**KSP Datathon 2026** — *Intelligent Conversational AI & Crime Analytics Platform.*

> Design and develop a platform that enables investigators, analysts, and policymakers to interact
> with the state crime database using natural language, while providing advanced analytical
> capabilities grounded in criminology and sociological insight — discovering hidden relationships
> between crimes, offenders, victims, locations and socio‑economic patterns, supporting
> investigative decision‑making, and providing predictive & preventive intelligence.

Deployment on **Zoho Catalyst** is mandatory.

## The 10‑point Proposed Solution Framework

1. **Conversational Crime Intelligence Interface** — NL chatbot over FIRs/accused/victims/locations/
   status/criminal history; context‑aware follow‑ups; save conversation as PDF; English + Kannada; voice Q&A.
2. **Criminal Network & Relationship Analysis** — links between accused/victims/locations/accounts/
   incidents; network visualization; organized‑crime & repeat‑offender network detection.
3. **Crime Pattern & Trend Analytics** — trends across time/geography/type/MO; hotspots & emerging
   clusters; seasonal/event‑based analysis.
4. **Sociological Crime Insights** — demographic (age/gender/socio‑economic) patterns; social risk
   factors; correlation with urbanization/migration/economic stress/education.
5. **Criminology‑Based Offender Profiling** — repeat/habitual offenders; behavioural analysis by
   history + MO; risk scoring to prioritize investigation.
6. **Investigator Decision Support** — automated case summaries & timelines; similar past cases &
   outcomes; recommended investigative leads.
7. **Financial Crime & Transaction Link Analysis** — detect crime‑linked transactions; money trails
   & suspicious networks; integrate with financial‑crime workflows.
8. **Crime Forecasting & Early Warning** — emerging pattern detection; early‑warning alerts;
   predictive hotspot analysis.
9. **Explainable AI & Transparent Analytics** — every answer supported by data references & evidence
   trails; visualization of reasoning; accountability compliance.
10. **Secure Role‑Based Access & Governance** — RBAC for investigators/analysts/supervisors/
    policymakers; secure handling with audit logs & traceability; data‑protection compliance.

**All 10 points are implemented.** See [07-analytics-and-framework.md](./07-analytics-and-framework.md)
and [11-feature-status.md](./11-feature-status.md).

## The 9 mandatory features (from framework #1 and cross‑cutting)

| # | Mandatory feature | Status |
|---|---|---|
| 1 | NL chatbot, English + Kannada | ✅ Done |
| 2 | Voice interaction (STT + TTS) | ✅ Done (Sarvam AI) |
| 3 | Context‑aware multi‑turn conversation | ✅ Done |
| 4 | Save conversation history as PDF (local) | ✅ Done (client‑side print‑to‑PDF) |
| 5 | Criminal network visualization | ✅ Done (D3‑force graph) |
| 6 | Hotspot / trend analytics | ✅ Done (Leaflet + Chart.js) |
| 7 | Predictive / early‑warning | ✅ Done (ensemble + AppSail ML; real‑data validated) |
| 8 | Explainable AI + audit trail | ✅ Done (Evidence panel + AuditLog table) |
| 9 | RBAC | ✅ Done (5 roles, header‑based) |
| + | OCR FIR ingestion (differentiator) | ✅ Done (Catalyst Zia OCR) |

## What makes it strong

- **Grounded, not hallucinated** — the model can only answer by executing read‑only ZCQL against the
  Data Store; every factual claim traces back to real rows, surfaced in the Evidence panel and logged.
- **Agentic** — GLM‑4.7‑Flash decomposes a question into multiple ZCQL queries, cross‑references, and
  synthesizes an answer (up to 5 tool‑calling steps).
- **Honest, validated ML** — the predictive engine's method is backtested leak‑free on **2.49M real
  Chicago incidents** (MASE 0.68–0.81, PAI@1% up to 6.3, ~90% interval coverage). We report what
  works and what doesn't rather than inflating numbers.
- **Genuine Astryx UI** — the whole interface is built from Meta's Astryx design‑system components,
  professional and responsive across phones → large monitors.

## Technology stack at a glance

| Layer | Technology |
|---|---|
| Frontend | React 19, Vite 5, Astryx design system (`@astryxdesign/core`, StyleX), lucide icons, Chart.js 4, Leaflet 1.9, d3‑force 3 |
| API | Zoho Catalyst Advanced I/O Function, Node 18, Express 4, `zcatalyst-sdk-node` |
| Database | Catalyst Data Store (NoSQL‑ish tables), queried via ZCQL |
| Conversational LLM | **Zoho QuickML — GLM‑4.7‑Flash** (`crm-di-glm47b_30b_it`, native tool‑calling) |
| Speech | **Sarvam AI** — `saarika:v2.5` (STT), `bulbul:v3` (TTS) |
| OCR | **Catalyst Zia OCR** (`extractOpticalCharacters`, native) |
| Predictive ML (prod) | Catalyst **AppSail** Python service — scikit‑learn `HistGradientBoostingRegressor` + scipy NNLS ensemble + split‑conformal |
| Predictive ML (fallback) | In‑function JS engine — Seasonal‑Trend, Holt, Hawkes, hand‑written GBM |
| ML research/validation | Python (pandas, scikit‑learn, PyTorch GRU on RTX 4060) over real Chicago open data |
| Hosting | Catalyst Functions + AppSail + Client hosting; custom domain `ksp.cyberkunju.com` with SSL |

Continue to [02-architecture.md](./02-architecture.md).
