# 04 · Data Model, Generation & Seeding

## Design philosophy

The schema is **lean and denormalized**: names and key attributes are embedded directly in each
table so that generated ZCQL is **single‑table with no JOINs** (ZCQL does not do JOINs well, and
LLM‑generated JOINs are error‑prone). This makes text‑to‑ZCQL reliable and analytics fast.

Catalyst types used: **Text, Int, BigInt, Decimal, DateTime, Boolean**. Every table automatically
gets `ROWID`, `CREATEDTIME`, `MODIFIEDTIME`. Full creation spec: `datastore/SCHEMA.md`.

## The 10 tables

### 1. `Cases` — denormalized FIR (the star table)
`CaseMasterID`(BigInt), `CrimeNo`(Text), `CaseNo`(Text), `CrimeRegisteredDate`(Text),
`Year`(Int), `CrimeMonth`(Int — note `Month` is reserved), `IncidentDate`(Text),
`DistrictName`(Text), `StationName`(Text), `latitude`(Decimal), `longitude`(Decimal),
`CaseCategory`(Text), `Gravity`(Text), `CrimeHead`(Text), `CrimeSubHead`(Text),
`CaseStatus`(Text), `CourtName`(Text), `OfficerName`(Text), `ActsSections`(Text),
`AccusedCount`(Int), `VictimCount`(Int), `BriefFacts`(Text max).

### 2. `Accused`
`AccusedMasterID`, `CaseMasterID`, `CrimeNo`, `AccusedName`, `AgeYear`, `Gender`, `PersonID`,
`RingID`, `DistrictName`, `CrimeSubHead`.

### 3. `Victims`
`VictimMasterID`, `CaseMasterID`, `VictimName`, `AgeYear`, `Gender`.

### 4. `Complainants`
`ComplainantID`, `CaseMasterID`, `ComplainantName`, `AgeYear`, `Gender`, `Occupation`,
`Religion`, `Caste`. *(socio‑economic attributes power framework #4)*

### 5. `Arrests`
`ArrestID`, `CaseMasterID`, `AccusedMasterID`, `AccusedName`, `ArrestType`, `ArrestDate`,
`DistrictName`, `IOName`.

### 6. `CoAccusedLinks` — precomputed criminal‑network edges
`LinkID`, `AccusedA`, `AccusedB`, `SharedCases`, `RingID`. *(powers framework #2 graph)*

### 7. `OffenderRisk` — repeat‑offender profiling
`OffenderRiskID`, `AccusedName`, `TotalCases`, `ViolentCases`, `RingID`, `RiskScore`(0–100),
`RiskBand`(High/Medium/Low), `Factors`(Text). *(powers framework #5)*

### 8. `FinancialTxns` — money‑trail layer
`TxnID`, `AccusedMasterID`, `AccusedName`, `Counterparty`, `Amount`(Decimal), `TxnDate`, `AccountRef`.
*(powers framework #7)*

### 9. `ChatSessions` — conversation memory
`SessionID`, `UserId`, `Role`, `Language`, `Title`, `CreatedAt`(DateTime). Created empty.

### 10. `AuditLog` — explainability + governance
`AuditID`, `SessionID`, `UserId`, `Role`, `QueryText`, `GeneratedZCQL`(Text max), `CitedRecordIDs`,
`ReasoningPath`(Text max), `ModelUsed`, `AnswerText`(Text max), `CreatedAt`(DateTime). Created empty.

## Canonical value domains (the LLM is told these — `lib/schema.js`)

- **CrimeHead**: Body Offences · Property Offences · Crime Against Women · Economic Offences ·
  Cyber Crime · Narcotics · Public Order
- **CrimeSubHead** (examples): Murder, Robbery, Burglary, Theft, Dowry Harassment, Online Fraud,
  UPI Fraud, Possession NDPS, …
- **Gravity**: Heinous · Non‑Heinous · Economic
- **CaseStatus**: Under Investigation · Chargesheet Filed · Convicted · Acquitted · Closed ‑
  Undetected · Pending Trial
- **CaseCategory**: FIR · UDR · PAR · Zero FIR
- **Gender**: M · F · T
- **Districts (15)**: Bengaluru City, Bengaluru Rural, Mysuru, Mangaluru (DK), Hubballi‑Dharwad,
  Belagavi, Kalaburagi, Ballari, Vijayapura, Shivamogga, Tumakuru, Davanagere, Udupi, Hassan, Raichur
- Dates are TEXT `YYYY-MM-DD`; `Year` INT (2024–2026); `CrimeMonth` INT 1–12.

## Synthetic data generation — `datastore/generate.js`

The demo dataset is **not random noise**. It is a **calibrated ETAS (Epidemic‑Type Aftershock
Sequence / Hawkes) self‑exciting spatio‑temporal point process** — the same generative model that
modern predictive‑policing systems try to detect. It is calibrated to real Karnataka NCRB anchors so
the data carries genuine, learnable structure:

- **Near‑repeat / retaliation clustering** in space‑time (what Hawkes models forecast).
- **Seasonality** — festival/summer annual cycle + weekly + diurnal cycles.
- **Organized‑crime rings** with bursty co‑offending (drives `CoAccusedLinks` + `RingID`).
- **District skew** by population weight; **crime‑head mix** by NCRB‑like shares; **YoY decline**.

Key calibration tables inside the generator:
- `DISTRICTS` — `[name, lat, lng, populationWeight, urbanSpread°]` for the 15 districts.
- `HEADS` — `[head, share, branchingRatio ρ, meanDelayDays, spatialSigma°, gravityBias]` per crime head.
- `SUBHEADS` — sub‑categories per head.
- Deterministic seeded RNG (LCG) + Box‑Muller Gaussian + Knuth Poisson + weighted samplers → reproducible.

**Outputs:**
- `datastore/seed/*.csv` — app tables, denormalized, capped to dev limits, recent window (what gets loaded).
- `datastore/train/*.csv` — the FULL event log + weekly feature series (`events.csv`,
  `weekly_panel.csv`, `meta.json`) for local model training/backtesting.

**Run:**
```bash
node datastore/generate.js [--scale 1.0]
```

> Honest note: at the app's coarse district×month granularity the synthetic series is close to
> seasonal‑naive (MASE ≈ 1.05 there) — which is why the **accuracy proof is the real Chicago
> validation**, not the synthetic self‑check. See [08-predictive-engine.md](./08-predictive-engine.md).

## Seeding pipeline — `datastore/load.js` + admin endpoints

The loader **parses each CSV locally** and streams row batches to the deployed function so the
function never re‑parses large files server‑side (scales to any size).

```
datastore/load.js  ──(batch of N rows, x-admin-key)──▶  POST /server/api/admin/insert
                                                          └─▶ adminApp.datastore().table(T).insertRows(rows)
```

Admin endpoints (all guarded by `x-admin-key === ADMIN_KEY`):

| Endpoint | Purpose |
|---|---|
| `GET  /admin/seed` | List seed tables + row counts available in bundled `functions/api/seed/*.csv`. |
| `POST /admin/seed` | Insert one batch from a bundled seed CSV `{ table, offset, limit }` (server reads file). |
| `POST /admin/insert` | Insert a client‑supplied batch `{ table, rows }` (used by `load.js`). |
| `GET  /admin/status` | Row counts per table (verification, via `SELECT COUNT(ROWID)`). |
| `POST /admin/reset` | Clear tables before a fresh re‑seed (`{ tables? }`), looped `DELETE` with progress guard. |

The CSV parser (`functions/api/lib/csv.js`) is a minimal **RFC‑4180** implementation (quoted fields,
escaped quotes, embedded commas/newlines) shared by the function and the loader.

Continue to [05-backend-api.md](./05-backend-api.md).
