# KSP Crime Intelligence — Project Documentation

Complete, A‑to‑Z documentation for the **Intelligent Conversational AI & Crime Analytics Platform**
built for the **KSP Datathon 2026** (Karnataka State Police × Hack2skill × Zoho), deployed on
**Zoho Catalyst**.

> Live app: `https://ksp.cyberkunju.com/app/index.html`
> API base: `https://ksp.cyberkunju.com/server/api` (also on the Catalyst dev domain)

---

## What this project is

A production‑style crime‑intelligence platform that lets investigators, analysts, supervisors and
policymakers **interrogate the state crime database in natural language** (English + Kannada, with
voice), and get **grounded, explainable, evidence‑cited** answers — plus a full analytics suite
covering criminal networks, hotspots, sociological insight, offender profiling, financial trails,
and an **AI predictive early‑warning engine** validated on 2.49M real incidents.

It covers **all 10 points** of the challenge's Proposed Solution Framework and **all 9 mandatory
features**.

---

## Documentation map

| # | Document | What's inside |
|---|----------|---------------|
| 00 | **[README.md](./README.md)** | This index |
| 01 | **[01-overview.md](./01-overview.md)** | Challenge, goals, capability summary, tech stack at a glance |
| 02 | **[02-architecture.md](./02-architecture.md)** | End‑to‑end architecture, request flow, component map |
| 03 | **[03-infrastructure-and-deployment.md](./03-infrastructure-and-deployment.md)** | Catalyst project, Functions, AppSail, client hosting, custom domain, env vars, deploy commands |
| 04 | **[04-data-model.md](./04-data-model.md)** | Data Store 10‑table schema, ETAS synthetic generator, seeding pipeline |
| 05 | **[05-backend-api.md](./05-backend-api.md)** | Full REST API reference — every endpoint, RBAC, payloads |
| 06 | **[06-conversational-ai.md](./06-conversational-ai.md)** | Agentic chat loop, text‑to‑ZCQL, grounding, LLM, guardrails, multi‑turn, voice, OCR |
| 07 | **[07-analytics-and-framework.md](./07-analytics-and-framework.md)** | The 10‑point framework coverage & each analytics feature |
| 08 | **[08-predictive-engine.md](./08-predictive-engine.md)** | Forecast models, walk‑forward backtest, metrics, AppSail ML service, real‑data validation |
| 09 | **[09-frontend.md](./09-frontend.md)** | Client architecture, Astryx design system, components, responsive scaling, charts |
| 10 | **[10-security-and-governance.md](./10-security-and-governance.md)** | RBAC, audit trail, safety guardrails, secrets hygiene |
| 11 | **[11-feature-status.md](./11-feature-status.md)** | Honest, accurate status of every feature |
| 12 | **[12-setup-build-run.md](./12-setup-build-run.md)** | Build, run, deploy from scratch; ML reproduce steps |
| 13 | **[13-file-reference.md](./13-file-reference.md)** | File‑by‑file reference of the whole repo |
| 14 | **[14-zoho-ai-migration.md](./14-zoho-ai-migration.md)** | Migration to Zoho/Zia AI (QuickML LLM + Zia OCR + Web Speech), provisioning steps |
| 15 | **[15-whatsapp-field-bot.md](./15-whatsapp-field-bot.md)** | WhatsApp field-officer channel — agent, photo identification, alerts, security model, provisioning |

---

## 30‑second summary

- **Frontend**: React 19 + Vite, Meta's **Astryx** design system (StyleX), Chart.js, Leaflet, D3‑force.
- **Backend**: Catalyst **Advanced I/O Function** (Node/Express) behind the API Gateway.
- **Data**: Catalyst **Data Store** (10 tables), queried with **ZCQL**; ~1.5 lakh seeded rows.
- **AI**: **Zoho QuickML (GLM‑4.7‑Flash)** (agentic native tool‑calling → text‑to‑ZCQL); **Sarvam AI** for STT/TTS; **Catalyst Zia OCR** for FIR OCR.
- **ML**: Catalyst **AppSail** Python service (scikit‑learn HistGBM + NNLS ensemble + conformal),
  with a self‑contained JS forecasting engine as fallback.
- **Governance**: header‑based RBAC (5 roles), full audit log, deterministic safety pre‑check.

See **[01-overview.md](./01-overview.md)** to start.
