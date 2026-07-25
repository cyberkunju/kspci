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
| **TalukName** | **Text** — *real taluk/tehsil from the postal directory; the sub-district level* |
| **LocalityName** | **Text** — *real locality (village, town or urban locality) where the offence occurred* |
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
VictimMasterID(BigInt), CaseMasterID(BigInt), VictimName(Text), AgeYear(Int), Gender(Text),
**Caste(Text)**, **Religion(Text)**  — *added: drawn from the district's census composition, so
victim-profile analysis is demographically grounded rather than uniform*

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
| `datastore/generate.js` | Karnataka, 15 districts | original KSP-only demo, kept for reference |
| `datastore/generate-india.js` | **All-India** — 640 districts, 36 states/UTs, ~9,700 taluks, ~155,000 localities | current default |

```bash
# One-time: fetch the open-data inputs and build the geography reference
./datastore/fetch-geo.sh && node datastore/build-geo.js

# Generate (target case volume is a parameter)
node --max-old-space-size=12288 datastore/generate-india.js --cases 1500000
node datastore/generate-india.js --cases 200000 --years 3
```

`build-geo.js` produces the geography and demography reference; see
`datastore/ref/SOURCES.md` for full provenance of every input. The generator is
calibrated against:

- `india_districts_full.json` — all 640 Census 2011 districts: real centroid from the
  district boundary, population, and the district's actual religion, SC/ST, literacy,
  worker-class and age-band composition.
- `india_localities.json` — ~155,000 real localities across ~9,700 taluks, from the
  India Post directory, each attached to its district.
- `ncrb_states_2023.json` — NCRB *Crime in India 2023* per state/UT: total cases,
  crime rate per lakh, chargesheet rate, conviction rate, violent-crime rate and
  murder/rape/kidnapping/extortion/robbery rates.
- `ncrb_crime_heads_2022.json` — 186 real NCRB crime heads in 16 groups, each with its
  published 2022 all-India case count and charging provision.

How the numbers are anchored:

- **State volume** comes from each state's real NCRB 2023 case total, so the spread
  between states is real (Kerala and Delhi dense, Nagaland and Sikkim sparse).
- **Within a state**, districts split that total by population weighted by urban
  share.
- **Head mix** follows the real 2022 national shares, tilted per state by that state's
  real murder, rape, kidnapping, extortion and robbery rates. Generated group shares
  land within ~0.3pp of NCRB.
- **Outcomes** follow each state's real chargesheet and conviction rates, with trial
  pendency at ~82% to match Indian court reality.
- **People** draw caste, religion, occupation and age from their district's census
  distributions.

The generator prints a calibration report comparing generated shares against NCRB on
every state, group and top head. Read it: it is the check that the run is sound.

It also emits `functions/api/ref/india_districts.json`, which the API uses for
district and state map centroids. **Regenerate and redeploy the function together**,
otherwise new districts will have no coordinates on the hotspot map.

> **Scale.** Volumes are scaled down from the real ~6.24 million cases/year to the
> requested target; relative differences between states, districts and crime heads are
> preserved, absolute counts are not real. At `--cases 1500000` the output is ~9.1M
> rows across 8 tables and ~1.5 GB of CSV. Full real scale (~18.7M cases over three
> years, ~115M rows) generates locally but exceeds the development Data Store's
> practical load budget — see below.

---

## Loading data (fully automated — no console clicks)

Tables must already exist in the console with the current column set. Then:

```bash
node datastore/load.js
node datastore/load.js --only Cases,Accused
node datastore/load.js --restart          # ignore the resume checkpoint
```

The loader streams each CSV line by line and posts 200-row batches to
`POST /server/api/admin/insert` with an admin key. It never holds a table in memory,
which is required at this scale: an 852 MB `Cases.csv` cannot be read into a single
JavaScript string.

Progress is checkpointed to `datastore/seed/.load-state.json` after every batch, so an
interrupted run resumes instead of duplicating rows. Failed requests retry with
backoff.

> **Load budget.** The development environment allows ~200,000 API calls. At 200 rows
> per call, 9.1M rows costs ~45,700 calls — comfortable. Full real scale would cost
> ~575,000 calls and is not loadable here; the generator warns when a run exceeds the
> budget.
