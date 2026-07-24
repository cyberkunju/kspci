# Credits and Acknowledgements

**KSP Crime Intelligence** — Intelligent Conversational AI & Crime Analytics Platform
Built for the **KSP Datathon 2026** (Karnataka State Police x Hack2skill x Zoho).

This document credits every platform, service, model, library, and data source the
project depends on. The platform is **Zoho-native first**: the language model, OCR,
data store, compute, authentication, and hosting all run on Zoho Catalyst. A single
third-party service (Sarvam AI, for speech) is used only where Catalyst offers no
equivalent, and is explicitly called out below.

---

## 1. Platform — Zoho Catalyst

The entire application is deployed on **Zoho Catalyst** (Serverless application
platform, India data center, `.in` domain).

| Catalyst service | Role in this project |
|---|---|
| **Serverless Functions — Advanced I/O** (Node 18) | Hosts the Express API that powers chat, analytics, forecasting, and OCR ingestion |
| **Data Store** | Primary datastore — 10 relational tables holding FIRs, accused, victims, complainants, arrests, co-accused links, offender risk, financial transactions, chat sessions, and audit log |
| **ZCQL (Zoho Catalyst Query Language)** | SQL-like query layer; every grounded answer is retrieved through read-only ZCQL SELECTs |
| **API Gateway** | Public routing to the API (`/server/api`) |
| **Authentication** | User identity and role-based access control (investigator, analyst, supervisor, policymaker, admin) |
| **Cache** | Cross-instance caching of the QuickML OAuth access token |
| **AppSail** | Hosts the Python forecasting microservice (FastAPI) |
| **Web Client Hosting** | Serves the static React single-page app (`/app`) |
| **Zia** | AI services — Optical Character Recognition (see models below) |
| **QuickML — LLM Serving** | Serves the GLM-4.7-Flash language model (see models below) |
| **Catalyst CLI** | Build and deployment tooling |
| **Zoho Accounts (OAuth 2.0)** | Self-client refresh-token flow (`accounts.zoho.in`) that authorizes QuickML LLM calls (scope `QuickML.deployment.READ`) |

---

## 2. Models

### Language model (reasoning, text-to-ZCQL, FIR structuring, analyst briefs)
- **GLM-4.7-Flash** — model id `crm-di-glm47b_30b_it` (30B Mixture-of-Experts, ~3B
  active parameters, 200K context window), served through **Zoho Catalyst QuickML
  LLM Serving**. Drives the conversational agent (ReAct loop over the crime database),
  the OCR field-structuring step, and the early-warning analyst brief.

### Optical Character Recognition (scanned-FIR ingestion)
- **Zoho Catalyst Zia OCR** — `zia().extractOpticalCharacters`. Native OCR supporting
  English, Kannada, and Hindi (among 10 Indian + 9 international languages). Converts
  scanned/photographed FIRs into text that is then structured and stored.

### Speech — Text-to-Speech and Speech-to-Text (third party, justified)
Catalyst/Zia provides no speech model, so voice uses **Sarvam AI**:
- **Sarvam `saarika:v2.5`** — Speech-to-Text (STT), English + Kannada.
- **Sarvam `bulbul:v3`** — Text-to-Speech (TTS), speaker `ritu`, English + Kannada.

### Predictive / forecasting ensemble (in-house)
A custom crime-forecasting engine (no external model service) combining:
- Seasonal-trend decomposition
- Holt linear exponential smoothing
- A Hawkes self-exciting point-process model (near-repeat victimization)
- Gradient-Boosted Regression (scikit-learn)
- Conformal prediction intervals for calibrated uncertainty
The models are ensembled with walk-forward backtested weights and served from the
AppSail Python microservice, with a JavaScript fallback inside the API function.

---

## 3. Frontend

| Library | Purpose |
|---|---|
| **Meta Astryx** (`@astryxdesign/core`, `@astryxdesign/theme-neutral`, `@astryxdesign/cli`) | Design system and UI component library |
| **React 19** (`react`, `react-dom`) | UI framework |
| **React Router DOM 6** | Client-side routing |
| **StyleX** (`@stylexjs/stylex`) | Styling engine (used by Astryx) |
| **Chart.js 4** | Trend and analytics charts |
| **D3-force 3** | Criminal-network force-directed graph |
| **Leaflet 1.9** | Crime hotspot maps |
| **lucide-react** | Icon set |
| **Vite 5** + `@vitejs/plugin-react` | Build tooling and dev server |

---

## 4. Backend / API

| Library | Purpose |
|---|---|
| **Express 4** | HTTP framework for the Advanced I/O function |
| **zcatalyst-sdk-node 2** | Official Zoho Catalyst Node.js SDK (Data Store, ZCQL, Zia, Cache) |

---

## 5. Machine-learning service and offline tooling (Python)

**Forecast microservice (AppSail):**
- **FastAPI** + **Uvicorn** — service framework and ASGI server
- **NumPy**, **SciPy**, **scikit-learn** — numerical computing and the gradient-boosting model

**Offline training / evaluation harness:**
- **pandas**, **pyarrow** — data wrangling
- **requests** — data acquisition
- **NumPy**, **SciPy**, **scikit-learn** — modeling and evaluation

---

## 6. Data sources

- **Synthetic Karnataka crime dataset** — generated in-house via a Hawkes
  self-exciting point-process simulator across 15 Karnataka districts and 7 crime
  heads (generation parameters recorded in `datastore/train/meta.json` for
  reproducibility). All FIR numbers, names, and figures are synthetic; no real
  personal data is used.
- **City of Chicago open crime data** — used only for offline benchmarking and
  validation of the forecasting models (not part of the deployed application).

---

## 7. Standards and references

- **IPC / BNS** section references and Indian FIR structure informed the data model.
- **OpenAI-style chat-completions request/response format** is referenced only as an
  API shape convention; no OpenAI model or service is used anywhere in the project.

---

## Summary of the AI stack

| Capability | Provider | Model / service |
|---|---|---|
| Conversational reasoning + text-to-ZCQL | **Zoho Catalyst QuickML** | GLM-4.7-Flash (`crm-di-glm47b_30b_it`) |
| OCR (scanned FIR ingestion) | **Zoho Catalyst Zia** | Zia OCR |
| Speech-to-Text | Sarvam AI | `saarika:v2.5` |
| Text-to-Speech | Sarvam AI | `bulbul:v3` |
| Crime forecasting | In-house | Seasonal-trend + Holt + Hawkes + GBM ensemble (conformal) |

Everything except speech runs natively on Zoho Catalyst.
