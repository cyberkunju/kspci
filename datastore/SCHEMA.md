# KSP Crime AI — Catalyst Data Store schema (console creation spec)

> **What is actually loaded, what is not, why, and how to finish it:
> [`DATA_STATE.md`](DATA_STATE.md).** Read that before running any bulk load — Catalyst bills
> Data Store inserts **per row** (₹0.006), so the full 8.24M-row corpus costs about ₹49,400 and
> exhausting the plan takes the whole environment offline, not just the load.


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

## WhatsApp field-officer channel (3 more tables)

Required only for the WhatsApp bot (`functions/api/lib/wa/*`). Create them the same
way; all three start empty. Full context: `documentation/15-whatsapp-field-bot.md`.

### 11. `Officers`   (the channel's allow-list — a WhatsApp number is its only credential)
| Column | Type | Notes |
|---|---|---|
| OfficerID | Text | generated `off_...` |
| **Phone** | **Text** | E.164 digits, no `+` (matches WhatsApp's `wa_id`). The lookup key |
| Name | Text | |
| Rank | Text | |
| Role | Text | investigator / analyst / supervisor / policymaker / admin |
| StateName | Text | |
| DistrictName | Text | posting; also the default alert subscription |
| StationName | Text | |
| Language | Text | `en` or `kn` |
| IsActive | Text | `true` / `false` — set `false` to revoke a handset instantly |
| AlertDistricts | Text | comma-separated subscription list |
| AlertSeverity | Text | critical / elevated / watch / none |
| OptedInAt | DateTime | |
| LastSeenAt | DateTime | last inbound message — decides Meta's 24-hour window |
| Pending | Text (max) | JSON conversational state: open frame, language prior, undo ledger. Bounded and self-healing (see below) |

> A number absent from this table, or with `IsActive` false, receives no data. There
> is no self-registration.

`Pending` is the channel's only mutable per-officer state, written once per turn in
the same update that stamps `LastSeenAt`:

```json
{
  "openFrame": { "v": 1, "kind": "pick", "prompt": "Which Suresh Kumar?",
                 "options": [{ "id": "1", "label": "…", "resolve": "…" }],
                 "context": { "promptMsgId": "wamid…" }, "ts": 1750000000000, "retries": 0 },
  "recentLangs": ["kn", "kn", "en"],
  "undo": [{ "token": "A2B3C4", "action": "undo_enroll", "payload": { "photoId": "pht_…" }, "ts": 1750000000000 }]
}
```

Every part is bounded by construction — one frame, twelve prior entries, five undo
records — and an unparseable or oversized value is read as `{}` rather than failing
the write that also stamps the service window. Losing a frame costs one turn;
losing `LastSeenAt` costs the ability to send an alert.

> Not cached. The officer's identity and role are cached because a roster edit is
> rare; this changes every turn, and a stale copy would make the bot forget the
> question it just asked.

### 12. `WaMessages`   (field-channel audit trail, de-duplication, and alert ledger)
| Column | Type | Notes |
|---|---|---|
| **MsgID** | **Text** | Meta `wamid` for inbound, or the alert dedupe key. Uniqueness is enforced by lookup, not by the store |
| Direction | Text | in / out / alert / status / audit |
| Phone | Text | |
| OfficerID | Text | |
| MsgType | Text | text / image / audio / location / alert-template / … |
| Body | Text (max) | message text, or the alert payload |
| MediaKey | Text | Stratus object key when media was retained |
| SessionID | Text | |
| Status | Text | sent / failed / rejected / released (a claim given back after a failed attempt, so the job's retry is not read as a duplicate) |
| CreatedAt | DateTime | |

### 13. `PersonPhotos`   (reference gallery for Zia facial comparison)
| Column | Type | Notes |
|---|---|---|
| PhotoID | Text | generated `pht_...` |
| PersonName | Text | |
| PersonID | Text | from `Accused` where the name resolved |
| AccusedMasterID | BigInt | 0 when unlinked |
| CaseMasterID | BigInt | 0 when unlinked |
| CrimeNo | Text | |
| DistrictName | Text | narrows the comparison shortlist |
| StateName | Text | |
| Gender | Text | narrows the comparison shortlist |
| AgeYear | Int | narrows the comparison shortlist |
| RingID | Int | |
| ObjectKey | Text | Stratus key, `gallery/<PhotoID>.<ext>` |
| Mime | Text | |
| Source | Text | `field-enrolment` |
| EnrolledBy | Text | officer name |
| EnrolledByPhone | Text | |
| CreatedAt | DateTime | |

> The crime dataset contains **no photographs**. This gallery holds only what
> officers enrol in the field, so facial comparison matches nothing until it is
> populated — and it says so rather than pretending otherwise.

Also create a **Stratus bucket** for the image bytes (default name
`ksp-field-photos`, override with `WA_PHOTO_BUCKET`).

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

---

## Forecast snapshot tables (batch scoring)

Two tables that hold **derived** data, not case records. They exist because the forecast
routes previously fitted a model inside the HTTP request — roughly seventy paged ZCQL queries
plus a gradient-boosted fit inside a Catalyst Function's 25-second ceiling. That does not
survive national scale, and it is also wasted work: the answer is identical for every caller
and changes only when new cases land.

`POST /server/api/admin/forecast/refresh` computes a snapshot and writes it here;
`GET /analytics/forecast` and `/analytics/earlywarning` serve it with a single indexed query.
When the tables are absent or the snapshot is older than `maxAgeHours` (default 168), the
routes fall back to live computation, so creating these tables is optional and additive.

```
Forecasts(Scope, Level, StateName, DistrictName, UnitName, Horizon,
          Predicted, Baseline, TrendPct, Low, High, Band,
          Latitude, Longitude, ComputedAt)
```
- `Scope` — TEXT, `route|level|state`, e.g. `forecast|district|ALL`. **Index this**; every
  read and every scope-clear filters on it.
- `Level` — TEXT, `district` or `state`. `Horizon`, `Band`, `UnitName` — TEXT.
- `Predicted`, `Baseline`, `TrendPct`, `Low`, `High`, `Latitude`, `Longitude` — NUMBER.
- `ComputedAt` — TEXT, ISO-8601.

```
ForecastMetrics(Scope, Level, StateName, Payload, UnitCount, ComputedAt)
```
- One row per scope. `Payload` is TEXT holding the snapshot's scalar context — model weights,
  ensemble accuracy, horizon — as JSON, so a read reconstructs the exact payload shape the
  client already expects. It is stored once rather than repeated across 640 unit rows.
- `UnitCount` — NUMBER.

Not added to the text-to-ZCQL schema prompt in `functions/api/lib/schema.js`: these are model
outputs, and grounding the assistant on them would let it answer questions about recorded
crime with predictions.

> **Why not Cache.** A national district-level payload is ~300 KB. A single Catalyst cache
> item is capped at 16,000 characters, so it would have to be split across ~25 keys and
> reassembled non-atomically on every read — a partial write would serve a half-updated
> forecast undetectably. See the Catalyst
> [cache implementation limits](https://docs.catalyst.zoho.com/en/cloud-scale/help/cache/implementation).
