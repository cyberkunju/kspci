# KSP Crime AI — Catalyst Data Store schema (console creation spec)

Lean, denormalized model optimized for LLM text-to-ZCQL and instant analytics.
Create these **10 tables** in the Catalyst console (Data Store → Create Table), with the
columns below. Column names must match **exactly** (the seeder maps CSV headers to these).

Catalyst types used: **Text**, **Int**, **BigInt**, **Decimal**, **DateTime**, **Boolean**.
Every table also has the automatic `ROWID`, `CREATEDTIME`, `MODIFIEDTIME` columns.

> Tip: when creating a table you can add all columns as **Text** except where noted;
> ZCQL still filters/sorts fine. Types below are the ideal choice.

---

### 1. Cases   (denormalized FIR — the star table)
| Column | Type |
|---|---|
| CaseMasterID | BigInt |
| CrimeNo | Text |
| CaseNo | Text |
| CrimeRegisteredDate | Text |
| Year | Int |
| CrimeMonth | Int |  (note: `Month` is a reserved keyword) |
| IncidentDate | Text |
| **StateName** | **Text** — *added for all-India coverage; group by this for national comparisons* |
| DistrictName | Text |
| StationName | Text |
| latitude | Decimal |
| longitude | Decimal |
| CaseCategory | Text |
| Gravity | Text |
| CrimeHead | Text |
| CrimeSubHead | Text |
| CaseStatus | Text |
| CourtName | Text |
| OfficerName | Text |
| ActsSections | Text |
| AccusedCount | Int |
| VictimCount | Int |
| BriefFacts | Text (max length) |

### 2. Accused
CaseMasterID(BigInt), AccusedMasterID(BigInt), CrimeNo(Text), AccusedName(Text),
AgeYear(Int), Gender(Text), PersonID(Text), RingID(Int), DistrictName(Text), CrimeSubHead(Text)

### 3. Victims
VictimMasterID(BigInt), CaseMasterID(BigInt), VictimName(Text), AgeYear(Int), Gender(Text)

### 4. Complainants
ComplainantID(BigInt), CaseMasterID(BigInt), ComplainantName(Text), AgeYear(Int),
Gender(Text), Occupation(Text), Religion(Text), Caste(Text)

### 5. Arrests
ArrestID(BigInt), CaseMasterID(BigInt), AccusedMasterID(BigInt), AccusedName(Text),
ArrestType(Text), ArrestDate(Text), DistrictName(Text), IOName(Text)

### 6. CoAccusedLinks   (precomputed graph edges)
LinkID(BigInt), AccusedA(Text), AccusedB(Text), SharedCases(Int), RingID(Int)

### 7. OffenderRisk   (repeat-offender profiling)
OffenderRiskID(BigInt), AccusedName(Text), TotalCases(Int), ViolentCases(Int),
RingID(Int), RiskScore(Int), RiskBand(Text), Factors(Text)

### 8. FinancialTxns   (money-trail layer)
TxnID(BigInt), AccusedMasterID(BigInt), AccusedName(Text), Counterparty(Text),
Amount(Decimal), TxnDate(Text), AccountRef(Text)

### 9. ChatSessions   (conversation memory — created empty)
SessionID(Text), UserId(Text), Role(Text), Language(Text), Title(Text), CreatedAt(DateTime)

### 10. AuditLog   (explainability + governance — created empty)
| Column | Type |
|---|---|
| AuditID | Text |
| SessionID | Text |
| UserId | Text |
| Role | Text |
| QueryText | Text |
| GeneratedZCQL | Text (max) |
| CitedRecordIDs | Text |
| ReasoningPath | Text (max) |
| ModelUsed | Text |
| AnswerText | Text (max) |
| CreatedAt | DateTime |

---

---

## Generating seed data

Two generators are available; both write `datastore/seed/*.csv`.

| Script | Coverage | Use |
|---|---|---|
| `datastore/generate.js` | Karnataka (15 districts) | original, KSP-only demo |
| `datastore/generate-india.js` | **All-India** — ~416 districts, 35 states/UTs | current default |

```bash
# All-India, NCRB-2023-calibrated (target case volume is a parameter)
node datastore/generate-india.js --cases 200000
node datastore/generate-india.js --cases 200000 --years 3
```

The all-India generator is calibrated against real reference data held in
`datastore/ref/`:

- `india_cities.json` — 528 Indian cities (>=1 lakh, Census 2011) with district,
  state, population and coordinates. Aggregated to ~416 district centroids.
- `ncrb_states_2023.json` — NCRB *Crime in India 2023* per state/UT: crime rate per
  lakh, chargesheet rate, conviction rate, violent-crime rate and
  murder/rape/kidnapping/extortion/robbery rates.

It also emits `functions/api/ref/india_districts.json`, which the API uses for
district and state map centroids. **Regenerate and redeploy the function together**,
otherwise new districts will have no coordinates on the hotspot map.

> Volumes are scaled down from the real ~6.24 million cases/year to the requested
> target; relative differences between states are preserved, absolute counts are not
> real. City populations cover urban areas only, so largely rural states are
> under-represented relative to their true totals.

---

## Loading data (fully automated — no console clicks)

After the 10 tables exist, data is loaded via the deployed API's admin seeder
(SDK-based bulk insert, no interactive prompts):

```
# per table, batched; the loader script orchestrates all of them:
node datastore/load.js
```

The loader calls `POST /server/api/admin/seed` with an admin key, streaming each
table's rows from `functions/api/seed/*.csv` in batches.
