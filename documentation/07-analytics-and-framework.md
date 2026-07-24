# 07 · Analytics & 10‑Point Framework Coverage

This document maps each of the challenge's 10 framework points to its concrete implementation.

Backend engines: `lib/analytics.js` (aggregations), `lib/investigator.js` (decision support),
`lib/backtest.js` + `lib/forecast.js` (prediction). Frontend views under `client/src/components/`.

---

## #1 Conversational Crime Intelligence Interface ✅
NL chatbot over FIRs/accused/victims/locations/status/history; multi‑turn; PDF export; EN+KN; voice.
→ Fully detailed in [06-conversational-ai.md](./06-conversational-ai.md). UI: `App.jsx` chat view
(Astryx `ChatLayout`/`ChatMessage`), `Composer.jsx`, `EvidencePanel.jsx`.

## #2 Criminal Network & Relationship Analysis ✅
- **Data**: `CoAccusedLinks` (edges with `SharedCases`, `RingID`), `RingID` on `Accused`.
- **Engine**: `analytics.network()` builds `{ nodes, links, rings }`; node degree from edge
  incidence, ring assignment, and a ring filter (top rings by link count). Capped at 400 edges.
- **UI**: `NetworkGraph.jsx` — a **D3‑force** interactive graph (link/charge/center/collide forces,
  ring‑coloured nodes sized by degree), with a ring selector in `Analytics.jsx`.
- Detects organized‑crime rings and repeat‑offender clusters.

## #3 Crime Pattern & Trend Analytics ✅
- **Engine**: `analytics.trends()` → by month (Year×CrimeMonth), by crime head, by status, by gravity.
  `analytics.hotspots()` → per‑district counts (mapped to Karnataka centroids) + sampled incident points.
- **UI**: `TrendCharts.jsx` (Chart.js line/bar/doughnut) and `HotspotMap.jsx` (Leaflet dark‑matter
  basemap, district volume circles + incident scatter). Seasonality is visible in the monthly series
  and is explicitly modelled by the forecast engine (#8).

## #4 Sociological Crime Insights ✅
- **Data**: `Complainants` carries `Occupation`, `Religion`, `Caste`; `Accused`/`Victims` carry
  `AgeYear`, `Gender`.
- **Engine**: `analytics.sociology()` → accused/victim **age bands**, gender splits, complainant
  **occupation** (socio‑economic proxy), **religion**, **caste/social category**, and a **crime‑type ×
  gender** behavioural cross‑tab. Urban proxy via district.
- **UI**: `Sociology.jsx` (bar + doughnut charts). Framed as aggregate decision‑support only, never
  individual profiling (explicit note in the payload).

## #5 Criminology‑Based Offender Profiling ✅
- **Data**: `OffenderRisk` (`TotalCases`, `ViolentCases`, `RingID`, `RiskScore` 0–100, `RiskBand`,
  human‑readable `Factors`).
- **Engine**: `analytics.offenders()` ranks by `RiskScore` with optional band filter; the forecast
  engine's `computeWatchlist()` adds a **logistic reoffending propensity** driven by case‑history
  depth, violence and organized‑ring membership.
- **UI**: offender table in `Analytics.jsx` (Offenders & Finance tab) with risk‑band badges; the
  reoffending watchlist in `EarlyWarning.jsx`.

## #6 Investigator Decision Support ✅
- **Engine**: `investigator.caseSupport(crimeNo|caseId, language)` assembles a **360° dossier**:
  1. full `Cases` record; 2. related `Accused`/`Victims`/`Complainants`/`Arrests`;
  3. **investigation timeline** (incident → FIR registration → arrests → current status, sorted);
  4. **similar past cases** (same sub‑head + district) and **statewide disposition stats**
     (conviction / chargesheet rates) for that crime type;
  5. an **LLM case summary + 3–5 prioritized investigative leads** (grounded, cited, EN/KN).
- **UI**: `CaseSupport.jsx` — search a CrimeNo → dossier with `MetadataList`, timeline, outcome KPIs,
  similar‑cases table, and the AI brief.

## #7 Financial Crime & Transaction Link Analysis ✅
- **Data**: `FinancialTxns` (`AccusedName`, `Counterparty`, `Amount`, `TxnDate`, `AccountRef`).
- **Engine**: `analytics.moneytrail()` builds an **accused ↔ counterparty money‑flow graph** and
  flags **suspicious hubs** — counterparties linked to many distinct accused = potential
  **mules / layering** (ranked by linked‑accused count then total flow). Capped at ZCQL's 300‑row limit.
  `analytics.financial()` lists the largest transactions.
- **UI**: `MoneyTrail.jsx` — flow graph (accused blue / counterparty amber) + suspicious‑hub table
  with mule‑risk colour coding.

## #8 Crime Forecasting & Early Warning ✅✅
- **Engine**: 4‑model ensemble + walk‑forward backtest + conformal intervals; production forecasts
  served by the AppSail Python champion with a JS fallback. Real‑data validated on 2.49M Chicago
  incidents. Early‑warning alerts from forecast‑vs‑baseline z‑scores.
- **UI**: `EarlyWarning.jsx` — predicted‑hotspot Leaflet map, KPI scorecard (MASE/PAI/PEI/coverage),
  backtest chart, model‑comparison table, severity alerts, reoffending watchlist, and an AI brief.
- → Full detail in [08-predictive-engine.md](./08-predictive-engine.md).

## #9 Explainable AI & Transparent Analytics ✅
- **Every chat answer** returns the generated **ZCQL**, a **rationale** ("why this query"), the
  **cited records**, the **raw result rows**, and an optional reasoning trace — rendered in the
  **Evidence & Reasoning** panel (`EvidencePanel.jsx`) as an Astryx `Table` + code block + citations.
- **Audit trail**: every query is persisted to `AuditLog` (query text, generated ZCQL, cited record
  IDs, reasoning path, model, answer, timestamp), retrievable via `GET /chat/:sessionId`.
- Reasoning path / correlations are visualized (query, cited evidence, result table).

## #10 Secure Role‑Based Access & Governance ✅
- **RBAC**: 5 roles (`investigator`, `analyst`, `supervisor`, `policymaker`, `admin`) via
  `requireRole()`; sensitive routes (network, offenders, financial, moneytrail, backtest, watchlist)
  restricted to analyst+. Role selected in the UI (`Selector` in the SideNav).
- **Audit & traceability**: `AuditLog` + `ChatSessions`; admin endpoints separately key‑guarded.
- **Data protection framing**: synthetic data; aggregate‑only sociological framing; "decision‑support,
  not enforcement" caveats throughout.
- → Detail in [10-security-and-governance.md](./10-security-and-governance.md).

---

## Analytics helper details

- **Karnataka centroids** (`KARNATAKA_CENTROIDS`) map the 15 districts to lat/lng for the maps.
- **`flatten()`** normalizes ZCQL's `{ Table: { col: val } }` result shape to flat objects; shared
  across `analytics.js`, `chat.js`, `forecast.js`, `investigator.js`.
- **`countOf()`** reads `COUNT(ROWID)` (or `cnt`/`count`) robustly.
- Overview KPIs run 5 `COUNT(ROWID)` queries in parallel (`Promise.all`).

Continue to [08-predictive-engine.md](./08-predictive-engine.md).
