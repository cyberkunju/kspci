# KSP Crime Intelligence

Conversational and predictive crime intelligence, built end to end on Zoho Catalyst for the
**KSP Datathon 2026 — Challenge 1**.

An officer asks a question in English or Kannada, typed or spoken. The system answers from the live
case store and shows the query it ran and the records it read, so the answer can be checked rather
than trusted. Around that sit the analytics suite, a forecasting engine validated on 6.37 million
real incidents, a 360° case dossier, scanned-FIR ingestion by OCR, an open-source research engine
that grades every source by how confident it is the source is really about your subject, and a
WhatsApp channel that puts the same platform on a field officer's phone in English, Kannada or Hindi.

| | |
|---|---|
| Web console | **https://ksp.cyberkunju.com/app** |
| WhatsApp field channel | **+91 94002 45958** — [open a chat](https://wa.me/919400245958) |
| API | `https://ksp.cyberkunju.com/server/api` |
| Forecast service | `https://kspforecast-50044266480.development.catalystappsail.in` |
| Research engine | `https://research-50044266480.development.catalystappsail.in` — internal key only |
| Catalyst project | Project-Rainfall · `51589000000013024` · India DC · Asia/Kolkata |

The web console is open — pick a role in the sidebar and ask it something. The WhatsApp number
answers **only numbers on the `Officers` roster**, which is that channel's entire trust boundary, so
an unenrolled number receives a bilingual "not registered" notice and nothing else. That is the
intended behaviour, not a fault. To enrol a demo handset:

```bash
curl -X POST "https://ksp.cyberkunju.com/server/api/admin/officers" \
  -H "x-admin-key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"phone":"91XXXXXXXXXX","name":"Demo Officer","rank":"PSI","district":"Mysuru","role":"analyst"}'
```

Then send `reset` to the number to choose a language and an access context.

All case data is synthetic, generated from real NCRB and Census aggregates. No real FIR, person or
case is represented anywhere in this repository.

---

## Contents

1. [How a question becomes a grounded answer](#how-a-question-becomes-a-grounded-answer)
2. [Data](#data)
3. [Predictive early-warning engine](#predictive-early-warning-engine)
4. [WhatsApp field channel](#whatsapp-field-channel)
5. [Open-source research engine](#open-source-research-engine)
6. [Analytics and investigation surfaces](#analytics-and-investigation-surfaces)
7. [Working at national scale](#working-at-national-scale)
8. [API surface](#api-surface)
9. [Catalyst services used](#catalyst-services-used)
10. [Build, run, deploy](#build-run-deploy)
11. [Repository layout](#repository-layout)
12. [Security posture — enforced and not enforced](#security-posture--enforced-and-not-enforced)
13. [Verification](#verification)
14. [Documentation](#documentation)

---

## How a question becomes a grounded answer

The chat path is an agent loop, not a template. `lib/chat.js` gives GLM-4.7-Flash one tool —
`query_crime_db`, a single read-only ZCQL SELECT — plus a compact schema and value-domain prompt.
The model queries, reads the rows, queries again to compare or cross-reference, and only then writes
prose. Five steps maximum; most questions resolve in one or two.

Every query the model emits passes a gate before it reaches the store (`isSafeSelect` /
`enforceLimit`):

- must begin with `SELECT`
- rejected on `insert · update · delete · drop · alter · create · truncate · grant · revoke`
- no semicolons, so no statement chaining
- `LIMIT` appended when absent, capped at 200 when larger
- one table, no joins — the schema is denormalised so none are needed

A rejected query goes back to the model as a tool error and it rewrites. The rejection never reaches
the user as a failure.

What returns to the client is the answer **plus** the executed ZCQL, the per-query purpose, the row
count, the first 100 rows, and citations harvested from the rows themselves (`CrimeNo` → FIR,
`CaseMasterID` → Case, `AccusedName` → Person). The evidence rail renders all of it. Sessions carry
three turns of history, replayed from `AuditLog`.

Two loops exist. GLM supports native tool-calling on QuickML, so that is the default. A
provider-agnostic ReAct loop — a fenced zcql block out, rows fed back as a `DATA (rows=N)` message —
is kept behind `LLM_FORCE_REACT=true` for any model without tool support, and was validated to
produce the same grounded answers.

Voice is Sarvam (`saarika:v2.5` STT, `bulbul:v3` TTS, speaker `ritu`), the one third-party service
in the stack, used because Catalyst has no developer speech model. Keys stay server-side.

---

## Data

The corpus is **all-India**, not a Karnataka sample, and it is anchored on published statistics
rather than invented ranges.

| Dimension | What it is |
|---|---|
| Geography | all **640** Census 2011 districts across **36** states and UTs, ~9,700 taluks, ~155,000 real localities from the India Post directory, each with the district's real centroid, population and urban share |
| Taxonomy | **186** real NCRB crime heads in 16 operational groups, weighted by published 2022 all-India case counts |
| Volume | each state's total anchored on its real NCRB *Crime in India 2023* count, then split across districts by population weighted by urban share |
| Outcomes | chargesheet and conviction rates follow each state's real 2023 figures, with trial pendency at ~82% |
| People | caste, religion, occupation and age drawn from that district's actual census distributions |

Incidents are simulated as a self-exciting spatio-temporal (ETAS/Hawkes) process, so the corpus
carries the structure a forecaster is supposed to find — near-repeat clustering, seasonality, weekly
cycles, co-offending rings — rather than uniform noise. `generate-india.js` prints a calibration
report comparing generated shares against NCRB on every state, group and head; generated group
shares land within ~0.3pp. Provenance for every input is in `datastore/ref/SOURCES.md`.

**What is actually loaded, and why not all of it.** The generator produces **8,241,503 rows**; the
Data Store holds **1,546,194 — 18.8%**. That is a cost ceiling, not an unfinished job: Catalyst
bills Data Store inserts per row at ₹0.006, so the full corpus is about ₹49,400. `Cases` is loaded
as a contiguous 24-month prefix (1,016,380 rows, 2023-07 → 2025-06) covering **all 36 states and all
640 districts**, chosen because monthly forecasting needs a full seasonal cycle plus enough beyond
it to fit, calibrate and score. `OffenderRisk` is 100% loaded.

The consequence is stated plainly rather than hidden: the child tables are prefixes too, so
person-level views (criminal network, money trail, victim demography, case drill-down) describe the
earliest cases rather than all of them. Referential integrity is intact — no orphans. Per-table
counts, the exact cost to finish, the value-for-money ranking, and the commands are in
[`datastore/DATA_STATE.md`](./datastore/DATA_STATE.md), which is the current truth for what the
store holds.

Fifteen tables: the ten case tables, three for the WhatsApp channel (`Officers`, `WaMessages`,
`PersonPhotos` — filled only by real field use, never generated), and two forecast snapshot tables.
Definitions in `datastore/SCHEMA.md`.

---

## Predictive early-warning engine

Forecasts crime volume per unit with calibrated prediction intervals and derives graded alerts from
the gap between forecast and baseline. The engine is `ml/engine/` — features, models, walk-forward,
Mondrian conformal, metrics — served by a FastAPI container on AppSail, with a self-contained JS
implementation in `lib/forecast.js` as the fallback path.

**Window discipline.** Features at origin *t* use strictly data before *t*. NNLS ensemble weights
are fitted on a stack window, conformal quantiles on a calibration window, and every reported metric
on the test window and nowhere else. Models refit every 8 origins on past data only, so the numbers
describe a periodically retrained system rather than one fitted with hindsight.

### Validated on real data — 6.37M incidents, five cities, 28 panels

Chicago, New York, Los Angeles, San Francisco and Seattle open-data portals, 2018–2023,
incident-level and geocoded, run through the *same* code as the Indian corpus so the validation
numbers cannot come from a different path than the numbers they validate.

| panel | units | MASE | police baseline | PAI@1% | police PAI | cov90 |
|---|---|---|---|---|---|---|
| chicago grid 700 m × week | 1155 | 0.739 | 0.781 | 6.30 | 6.13 | 86.8% |
| newyork grid 700 m × week | 1511 | 0.706 | 0.794 | 7.72 | 7.52 | 88.9% |
| losangeles grid 1 km × week | 1151 | 0.722 | 0.765 | 9.56 | 9.40 | 90.7% |
| sanfrancisco grid 500 m × week | 447 | 0.722 | 0.776 | 13.60 | 12.93 | 90.0% |
| seattle grid 800 m × week | 378 | 0.712 | 0.768 | 10.47 | 10.39 | 91.1% |
| newyork district × week | 6 | 0.468 | 1.852 | 1.67 | 1.67 | 95.1% |

- Beats seasonal-naive on **28 of 28** panels (MASE 0.47–0.83) and the police historical-pattern
  baseline on **27 of 28** — the exception is Los Angeles taluk × day, where it ties.
- **Grid resolution is the operational unlock and it replicates in every city:** PAI@1% goes from
  1.5–2.3 at district level to **6.3–13.6** on a fine grid. 1% of the city, ranked by the model,
  holds six to fourteen times its share of crime.
- **At grid resolution the model adds almost nothing spatially over the police baseline** — its PAI
  is within a few per cent of the baseline's own PAI in all five cities. The grid produces the
  concentration, not the model. Both columns are reported side by side precisely so that gain is not
  misattributed.
- Where the model earns its keep is the aggregate series: district × week edges of 21–75%, because a
  long-run-mean baseline cannot track trend or level shifts. New York is the extreme — the police
  baseline scores MASE 1.852, worse than repeating last year.
- Mondrian conformal 90% intervals land at 85.7–96.5% coverage across 28 panels with no per-panel
  tuning.

### The correction that matters: the Poisson floor is the wrong yardstick

A forecaster that knew the true intensity exactly still could not predict the realised count,
because arrivals are random. Dividing that floor by the achieved error gives an efficiency, and at
1.0 no model can do better. But crime is **not** Poisson — near-repeat victimisation makes counts
over-dispersed, so the Poisson floor is only a lower bound and overstates remaining headroom.

That was measured, not assumed. The generator's intensity field is deterministic, so changing the
seed redraws the realisation of the same process. Six independent 27.4M-incident realisations give a
model-free oracle: predict each from the mean of the other five.

| Quantity | district × week |
|---|---|
| dispersion index (variance / mean) | **1.705** |
| measured irreducible floor MAE | **11.46** |
| closed-form Poisson floor MAE | 8.86 |
| Poisson bound understates the floor by | **1.293×** |

√1.705 = 1.306 against a measured 1.293 — the floor scales with the standard deviation as theory
says. Consequence: at district × week the engine's MAE 13.07 is efficiency 0.677 with 32% headroom
against the Poisson floor, but **efficiency 0.877 with about 12% headroom** against the measured
one. Two-thirds of the apparent opportunity was an artefact of the Poisson assumption. Because real
data arrives as a single realisation and cannot be replicated, the engine reports a dispersion
**bracket** rather than a point estimate — a point estimate there would be false precision that
silently rewrites every headroom figure.

### Hypotheses tested and rejected

Reported because a negative result that cost a few container-hours is worth more than an untested
assumption.

- **Hierarchical decomposition does not help.** Forecasting 14 offence groups and summing gives
  MASE 0.737 against 0.741 top-down: 0.5% for 14× the models and 14× the operational surface. The
  per-group efficiencies that motivated the attempt turned out to be the Poisson artefact, not
  signal.
- **A national 1 km grid is not viable** — 464,859 cells with a median of one event each, because
  India is roughly 5,000× the area of Chicago. Grid panels are per-metropolitan-district.
- **`state × month` fails** — MASE 1.083, worse than seasonal-naive. 36 units × 36 periods is not
  enough signal, which is why **district × week** is the live default.
- **Finer time closes the gap finer space does not** — district × day reaches efficiency 0.929 and
  0% corrected headroom against district × week's 0.677 and 10–23%. The unclaimed signal is
  within-week timing, which is a more useful answer than "train a bigger model".
- **Mondrian conformal is necessary, not decorative** — global split-conformal coverage by volume
  band was 99.8 / 94.8 / 76.9 / **47.8**% against a nominal 90; stratifying gives 88.2 / 87.7 / 86.6
  / 85.1%. One interval width cannot describe a metropolitan district and a Himalayan one at once.
- **A GPU neural net ties gradient boosting** — 0.811 vs 0.815 MASE. Gradient boosting is a
  brutally strong baseline here, so the simpler champion shipped.

### Live service

Scored from the loaded rows across **640 districts**: MASE **0.855** against the police
historical-pattern baseline's **0.939**, 90% interval coverage **90.2%**, PAI@1% **7.90** at PEI
**0.993**.

Two operational properties matter as much as accuracy. **Enforcement-led offences are forecast
separately and never drive deployment alone** — recorded volume for liquor, narcotics, arms and
regulatory offences is largely a record of where officers went, so forecasting it and deploying
against it closes a feedback loop where the model sends patrols where patrols already were. And
**recapture rate is reported** — the share of flagged units that stay flagged between origins. High
persistence is expected, and it is also the warning sign for exactly that loop.

No individual crime is predicted. The output is where risk concentrates, with honest uncertainty,
for decision support, never automated enforcement. Full report and reproduction commands:
[`ml/RESULTS.md`](./ml/RESULTS.md).

---

## WhatsApp field channel

The console assumes a desk. A constable at a checkpoint has a phone and no app.
`functions/api/lib/wa/` implements a Meta Cloud API bot over the same tools the console uses —
natural language only, no command syntax, in **English, Kannada or Hindi**, typed or spoken.

Live on **+91 94002 45958** ([open a chat](https://wa.me/919400245958)) over the Meta Cloud API,
Graph v25.0, with Catalyst Stratus holding the photo blobs, a Catalyst job pool processing turns
asynchronously and a cron dispatching alerts. Enrolment is at the top of this file.

| The officer sends | What happens |
|---|---|
| "any history on Suresh Kumar" | prior cases, arrests, and — analyst and above — risk band and known associates |
| a photo of a person | Zia `analyseFace` / `compareFace` against the enrolled gallery; ranked candidate leads with confidence bands |
| a photo + "save this as … in FIR 4021/2026" | enrolled into the gallery against that record (blob in Stratus) |
| a photo of an FIR, notice or plate | Zia OCR, identifiers extracted, records looked up |
| a voice note | Sarvam transcribes, auto-detecting Kannada or English, then it runs as a normal request |
| their location | resolved to the nearest district and used as the area for what they ask |
| "what's flagged in Mysuru next month" | live output of the early-warning engine |
| *(nothing — a district is flagged)* | proactive push with a one-line advisory, on a Catalyst cron |

What makes it safe to hand to the field:

- **Roster-gated.** A number absent from `Officers` receives nothing. No self-registration. Role
  comes from the roster row, not from a message — that is what stops an investigator talking their
  way into risk scores and associate networks. `WA_SELF_ROLE` relaxes it for demonstration and is
  **off unless explicitly enabled**.
- **Setup never reaches the model.** `reset` → language (three buttons, each label in its own
  script) → access context. Choosing a language or a role is a consent decision about identity, so
  it has the same standing as `help` and `stop`: it must work when the model is down, which is
  exactly when an officer reaches for `reset`.
- **Grounding refusal.** An FIR the tool did not actually return is refused, not rendered.
- **Write gate.** Every write is confirmed; a negated caption blocks it and audits the denial. A
  model that re-attempts a denied action is cut off rather than left to burn the turn budget.
- **Undo codes.** A reversible action returns a code that reverses it with no further model call.
- **Fails loudly.** With the model down, `help` and opt-out still work and an error produces a
  message rather than silence.
- **Trilingual by construction**, enforced by a copy lint that fails the build when an
  officer-facing string is missing a language.

Turns process through a Catalyst job pool when configured, inline otherwise. Every message and every
biometric use is written to `WaMessages`. Full design, security model and provisioning:
[`documentation/15-whatsapp-field-bot.md`](./documentation/15-whatsapp-field-bot.md).

---

## Open-source research engine

A separate AppSail service (`research/`, FastAPI on a custom Docker runtime) that searches the open
internet about a subject and grades every source by how confident it is that the source is really
about *that* subject. It is separate because a run takes 40 to 300 seconds and an Advanced I/O
function is killed at 30.

Two ideas do the work.

**Anchors, not names.** "Suresh Kumar" has millions of matches. "Suresh Kumar", Mysuru, aged 34,
FIR 118/2023, co-accused Manjunath has approximately one. Those facts are in our own Data Store, so
`functions/api/lib/research.js` reads them and hands them to the engine — which is why the bridge
lives in the function and not in the browser. The same lookup decides *who the subject is to us*: a
name that appears as a victim or a complainant and not as an accused is passed through as
`subject_role` and the engine refuses the run. A person who reported a crime did not volunteer to
have their open-source footprint assembled.

**Attribution is the product, not retrieval.** Every source is returned with a confidence band —
confirmed, probable, possible, different person, unrelated — and the reasons behind it. Weak matches
are shown rather than hidden, because an officer cross-checks everything and a silently dropped
"possible" reads as certainty. The summary is written only from claims whose quoted span was
re-found in the stored text of the document it came from; anything that could not be re-found is
dropped and reported. Caste, religion, community and political affiliation are never carried into a
summary about a person, in any of the three scripts our sources publish in.

Eight discovery tiers (five live), a Cohere cross-encoder choosing which ~48 of ~140 candidates are
worth reading, `trafilatura` for boilerplate removal, and no browser anywhere — the render tier was
measured and rejected rather than assumed.

Where it appears:

- **Desk** — the *Open Sources* panel: purpose field, live stage progress, the anchor summary with
  its honest strength label, a filterable graded source table, the dated-claims timeline, and a PDF
  export. Each citation in the summary resolves to a row in the table.
- **WhatsApp** — the run is started and the turn ends, because there is no honest way to answer
  inside it. The engine calls back minutes later and the report arrives as its own message, in the
  officer's language, with the full article url for every source. The report becomes part of the
  conversation, so the officer can question it afterwards — and asking about a subject already
  reported reads the report rather than searching again.

Governance is not decoration here: purpose is required and recorded, person-level research needs an
operational role while aggregate subjects do not, and there is one authoritative gate rather than
two of differing strictness. Full design, measurements and honest limits:
[`documentation/16-research-engine.md`](./documentation/16-research-engine.md).

---

## Analytics and investigation surfaces

Read off the Data Store through ZCQL aggregation, partitioned where national volume requires it.

- **Overview** — case volume, heinous share, chargesheet rate, high-risk offenders, district count
- **Hotspots** — state or district volume plus incident-level scatter on Leaflet
- **Trends** — by month, crime head, case status, gravity
- **Criminal networks** — co-accused edges resolved into rings, d3-force graph
- **Money trail** — transaction graph with mule and layering hub detection
- **Sociology** — age, gender, occupation, community bands, crime × gender
- **Offender risk** — ranked risk rows with band filter (complete: `OffenderRisk` is fully loaded)
- **Case dossier** — the record, linked persons, arrests, an investigation timeline, similar past
  cases with outcome statistics, and model-written investigative leads
- **FIR ingestion** — Zia OCR (Kannada, Hindi, English, auto-detect retry) → field structuring by
  the model → confirmed insert

The frontend is React 19 on Meta's Astryx design system, Chart.js for charts, Leaflet for maps,
d3-force for graphs, no emoji. Responsive down to a phone: below 1200 px the nav becomes a drawer
and the evidence rail a slide-over; above it, three columns. Because Astryx is rem-based,
`index.css` lifts the root font size by CSS-viewport width, which is what makes the UI scale
correctly on displays running OS-level scaling.

---

## Working at national scale

A million rows in a Catalyst Data Store behaves differently from a hundred thousand, and the
findings are written down rather than rediscovered.

- **Forecasting moved out of the request.** The routes used to fit a model inside the HTTP call —
  about seventy paged ZCQL queries plus a gradient-boosted fit inside a 25-second function ceiling.
  That does not survive national scale and is wasted work, since the answer is identical for every
  caller. `POST /admin/forecast/refresh` writes a snapshot to `Forecasts` / `ForecastMetrics`;
  `/analytics/forecast` serves it with one indexed query and falls back to live computation when the
  snapshot is missing or stale, so the tables are additive.
- **Two ZCQL ceilings, neither about indexing.** One scales with rows scanned × groups produced:
  `GROUP BY Gravity` (3 groups) succeeds over a million rows where `GROUP BY StateName` (36 groups)
  fails on the same rows. The other limits concurrent processing: a 1.1 s query fails when twelve
  run at once. National aggregates are therefore partitioned and merged in process, four at a time.
- **`OFFSET` pagination cannot be trusted.** `LIMIT offset, n` returned overlapping pages, and
  keyset paging on `ROWID` skipped rows because Catalyst ROWIDs are not monotonic across insert
  batches. Both lost data without erroring. The working pattern is a sequence column assigned at
  write time, read back in explicit half-open ranges.
- **Inserts are not exactly-once.** A request can fail at the client after succeeding at the server
  and the retry writes a duplicate; `POST /admin/forecast/dedupe` repairs it.
- **The billing meter is rows, not API calls.** 8.24M rows is ~41,200 calls out of a 200,000 budget,
  which looks free, and costs ₹49,400. A full-scale load was once started on the call budget, hit
  the plan limit at ~608,000 rows, and returned `SUBSCRIPTION_USAGE_LIMIT_REACHED` for *every*
  resource in the environment — the app went down, not just the load. Loads are now priced with
  `tools/usage.js` and capped with `MAX_ROWS`.

Measurements and fixes: `DEVELOPMENT.md` §11 and `datastore/DATA_STATE.md` §6.

---

## API surface

Base `/server/api`. JSON in, JSON out. Role in `x-user-role`, user id in `x-user-id`, admin key in
`x-admin-key`.

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/health` · `/` | any | liveness, Catalyst binding, phase |
| POST | `/warmup` | any | one-token LLM ping to warm the instance |
| POST | `/chat` | any | grounded agentic question |
| GET | `/chat/:sessionId` | any | full turn history |
| POST | `/voice/stt` · `/voice/tts` | any | Sarvam speech in / out |
| POST | `/ingest/ocr` · `/ingest/confirm` | investigator, analyst, supervisor, admin | scanned FIR → fields → insert |
| GET | `/analytics/overview` · `hotspots` · `trends` · `sociology` | any | aggregations |
| GET | `/analytics/network` · `offenders` · `financial` · `moneytrail` | analyst+ | graphs and risk |
| GET | `/investigator/case` | any | dossier by `crimeNo` |
| GET | `/analytics/forecast` · `earlywarning` · `brief` | any | snapshot forecast, alerts, written brief |
| GET | `/analytics/backtest` · `watchlist` | analyst+ | scorecard, reoffending list |
| POST | `/research` | any (the engine decides by subject kind) | start an open-source research run |
| GET/DELETE | `/research/:id` | any | poll or cancel a run |
| GET | `/research/health` | any | engine reachability, model, rerank and per-tier state |
| POST | `/research/callback` | engine (internal key) | a finished run, delivered to WhatsApp |
| GET/POST | `/whatsapp/webhook` | Meta | verification and inbound messages |
| POST | `/whatsapp/process` · `/whatsapp/alerts/dispatch` | internal | turn processing, alert fan-out |
| GET | `/whatsapp/health` | any | channel configuration state |
| GET/POST/DELETE | `/admin/officers` | admin key | field roster |
| POST | `/admin/forecast/refresh` · `purge` · `dedupe` · `put` | admin key | snapshot lifecycle |
| POST | `/admin/zcql` | admin key | read-only diagnostic query (SELECT only, refuses mutations) |
| GET/POST | `/admin/seed` · `/admin/insert` · `/admin/status` · `/admin/reset` | admin key | seeding and maintenance |

`GET /admin/status?llm=1` additionally probes the language model and reports what came back. Without
it every model failure — an expired credential, a revoked scope, a provider outage — presents
identically as "something went wrong" on every surface at once.

`POST /chat/:sessionId/pdf` returns `501` on purpose — export is a client-side print pipeline
(`client/src/lib/pdf.js`), so the feature works without a server round-trip. `/admin/reset` is
irreversible and does not touch the forecast tables.

---

## Catalyst services used

| Service | Role |
|---|---|
| Serverless Functions — Advanced I/O (Node 18, 1 GB) | the entire API |
| Data Store | 15 tables; ~1.55M rows loaded |
| ZCQL | read layer for every grounded answer |
| QuickML — LLM Serving | GLM-4.7-Flash (`crm-di-glm47b_30b_it`), 30B MoE / 3B active, 200K context |
| Zia | OCR (`extractOpticalCharacters`) and face analysis/comparison (`analyseFace`, `compareFace`) |
| AppSail | two Python services, containerised, scale-to-zero: the forecasting engine and the open-source research engine |
| Stratus | object store for field-enrolled photo blobs |
| Cron | scheduled early-warning push to subscribed officers |
| Job Scheduling (job pool) | asynchronous WhatsApp turn processing |
| Cache | cross-instance caching of the QuickML OAuth token |
| Web Client Hosting | the React SPA at `/app` |
| API Gateway | public routing to `/server/api` |
| Authentication | user identity and the five-role model |
| Zoho Accounts (OAuth 2.0) | self-client refresh-token flow authorising every LLM call |
| Domain mapping | `ksp.cyberkunju.com`, SSL live |
| India data centre (`.in`) | data residency |

Language model, OCR, face comparison, storage, object storage, scheduling, compute, routing and
hosting are all Catalyst-native. Speech is one exception, because Catalyst has no developer STT/TTS
model — confirmed in the live console. The research engine's two others are named plainly rather than
buried: a Cohere cross-encoder for candidate reranking and Firecrawl for the general-web discovery
tier. Both degrade a run rather than failing it when absent, and `/health` reports each separately so
the degradation is visible instead of silent.

---

## Build, run, deploy

```bash
# function
cd functions/api && npm install && npm test     # 120 checks + copy lint + turn smoke
# client
cd client && npm ci && npm run build            # -> client/dist

# research engine: BUILD THE IMAGE FIRST. catalyst.json points at a docker:// tag, so
# the deploy ships whatever that tag holds and never builds from research/ — skip this
# and you get DEPLOYMENT SUCCESSFUL on the previous code, silently.
docker build -t localhost/ksp-research:latest research/
for s in selftest selftest_reason selftest_claims selftest_pipeline; do
  docker run --rm -w /app -e PYTHONPATH=/app localhost/ksp-research:latest python -m app.$s
done

# deploy
catalyst deploy --only functions --org 60079622152
catalyst deploy --only client --ignore-scripts --org 60079622152
catalyst deploy --only appsail:kspforecast --org 60079622152
catalyst deploy --only appsail:research --org 60079622152
```

Local: `catalyst serve` for the function on `:3000`, `npm run dev` in `client/` for Vite on `:5173`
with `/server` proxied.

Data, in the order it has to happen:

```bash
# one-time: fetch the open-data inputs and build the geography/demography reference
./datastore/fetch-geo.sh && node datastore/build-geo.js

# generate (coverage of all 36 states and 640 districts holds at any --cases value)
node --max-old-space-size=12288 datastore/generate-india.js --cases 1500000 --years 3

# PRICE THE LOAD FIRST - inserts bill per row, and the failure mode is the whole
# environment going offline, not a slow load
node tools/usage.js
export KSP_API="https://ksp.cyberkunju.com/server/api" ADMIN_KEY=...
CONCURRENCY=8 MAX_ROWS=1505504 node datastore/load.js --only Cases   # resumable, checkpointed

# re-score the live forecast from exactly what the store holds
ADMIN_KEY=... ml/.venv/bin/python ml/score_live.py --max-rows 1016380
```

Reproduce the accuracy numbers:

```bash
ml/.venv/bin/python ml/ingest_cities.py --all --start 2018-01-01 --end 2024-01-01
ml/.venv/bin/modal run ml/modal_app.py::cities        # 28 real panels
ml/.venv/bin/modal run ml/modal_app.py::full          # 55 synthetic panels
ml/.venv/bin/modal run ml/modal_app.py::floor --k 6   # the measured noise floor
ml/.venv/bin/python ml/report_table.py ml/out/reports --real
```

`ml/run_engine.py` produces identical numbers locally; Modal only changes how many run at once. An
accuracy claim that depends on where the code ran is not an accuracy claim.

Full sequence, environment variables and the browser-automation notes:
`documentation/12-setup-build-run.md` and `DEVELOPMENT.md`.

---

## Repository layout

```
functions/api/            Express app on Advanced I/O - every route
  index.js                routing, RBAC middleware, admin guards, per-request Catalyst init
  lib/chat.js             agent loop, ZCQL safety gate, evidence and citation assembly
  lib/llm.js              QuickML GLM client (native tool-calling, timeout, token cap)
  lib/schema.js           schema and value-domain prompt used for grounding
  lib/analytics.js        aggregations, partitioned for national volume
  lib/forecast.js         seasonal-trend, Holt, Hawkes, GBM - the in-function fallback
  lib/forecastStore.js    snapshot read/write against Forecasts / ForecastMetrics
  lib/backtest.js         walk-forward backtest, PAI/PEI, ensemble weights, AppSail integration
  lib/investigator.js     case dossier
  lib/ocr.js              Zia OCR -> field structuring -> insert
  lib/voice.js            Sarvam STT/TTS
  lib/oauth.js            Zoho OAuth token, cached
  lib/wa/                 WhatsApp channel: agent, tools, frames, write gate, copy packs,
                          roster, photo/biometrics, alerts, research delivery, inbound routing
  lib/research.js         bridge to the research engine: supplies the anchors from our records
  test/                   node:test suite + scripted turn smoke run + copy lint
client/                   React 19 + Astryx SPA
datastore/
  SCHEMA.md               the 15-table console creation spec
  DATA_STATE.md           what is loaded, what it cost, how to finish it
  generate-india.js       NCRB/Census-calibrated all-India ETAS generator
  generate.js             the original Karnataka generator, kept for reference
  build-geo.js            geography and demography reference builder
  load.js                 streaming, checkpointed, resumable loader
  ref/                    NCRB and Census reference data + SOURCES.md provenance
ml/
  engine/                 features, models, walk-forward, Mondrian conformal, metrics
  ingest_cities.py        five city open-data portals -> one schema
  modal_app.py            fan-out runner for the panel sweeps and the noise floor
  hierarchical.py         the decomposition hypothesis test
  score_live.py           score the live Data Store panel
  service/                AppSail FastAPI forecasting service
  RESULTS.md              every measured number, with reproduction commands
research/                 the open-source research engine (AppSail, custom Docker)
  app/plan.py             query planning from anchors
  app/sources.py          the discovery tiers and their adapters
  app/rerank.py           cross-encoder candidate selection
  app/extract.py          fetch, boilerplate removal, injection screen
  app/cluster.py          syndication clustering and independence counting
  app/attribute.py        the confidence bands and their reasons
  app/claims.py           claim extraction, span re-verification, the cited summary
  app/governance.py       purpose binding, role and subject-role refusal, audit lines
  app/eval_attribution.py hand-labelled attribution harness
  app/selftest*.py        four offline suites, run inside the built image
tools/                    CDP browser automation for the Catalyst console (schema changes the
                          CLI cannot make), usage.js for spend before a load, wa-send/wa-log for
                          the field channel, connect-proxy.js for the engine deploy
documentation/            01-18, the full technical set
```

---

## Security posture — enforced and not enforced

Stated directly, because a governance claim that does not hold is worse than none.

**Enforced.** Read-only ZCQL gate on every model-generated query (single statement, no DML or DDL,
mandatory capped `LIMIT`). Admin routes behind a shared key compared in constant time; the
diagnostic `/admin/zcql` refuses anything but a single SELECT. Model and OCR output treated as
untrusted and never executed. Secrets server-side only, never in the client bundle. On the WhatsApp
channel: roster-only access, role from the roster row rather than from a message, confirmation and
reversibility on writes, grounding refusal, and an audit row per message and per biometric use.

**Not enforced, and this matters.** Web RBAC is the `x-user-role` request header, trusted as sent
and defaulting to `investigator`; anyone who can reach the API can claim `admin`. Until roles bind
to Catalyst Authentication claims, every role gate on the web surface is advisory. The research
engine inherits this and it costs the most there: its governance layer correctly refuses a
policymaker's person lookup, and a caller simply says `investigator` instead. Open-source research on
named individuals is the feature where an advisory role gate is least acceptable. The chat
tool has no table allow-list, so the gate that blocks writes does not restrict which table a read
touches. Session-history reads interpolate the session id into the query string rather than binding
it. The `AuditLog` covers conversational turns; ingestion and admin actions are not written to it,
and there is no retention policy or query path over what is logged. `datastore/load.js` carries a
hard-coded `ADMIN_KEY` fallback for seeding convenience. `WA_SELF_ROLE` is enabled in this
environment, which is right for a demonstration and is not a default a deployment should inherit.
Two Leaflet popups build HTML from field values that OCR ingestion can write.

Closing the first item is the single highest-value hardening step. The rest are tracked in
`documentation/10-security-and-governance.md` and `documentation/11-feature-status.md`.

---

## Verification

- **120 automated checks** on the function (`npm test` in `functions/api`) covering the WhatsApp
  agent's grounding refusals, write gate, negation handling, undo path, language routing and
  model-down behaviour, plus the research anchors, role rule and report delivery — followed by a
  scripted end-to-end turn smoke run and a copy lint that fails the build when an officer-facing
  string is missing a language.
- **Four offline suites on the research engine**, run inside the built image so they exercise the
  code that ships: span verification, the protected-attribute guard in all three scripts, admission
  and clustering, and the pipeline and API contract with discovery faked — a test that depends on
  what a newsroom published today fails for reasons unrelated to our code. Plus
  `app/eval_attribution.py`, a hand-labelled attribution harness with two hard gates at zero: a
  false confirm, and one of our own documents dismissed.
- **Live verification of the research path end to end**, on the deployed services and a real
  handset: a run started from WhatsApp, delivered by callback, questioned afterwards about its own
  cited sources, in English, Kannada and Hindi — plus the desk panel driven over CDP through the
  purpose gate, the live stages, the graded table and the export
  (`tools/steps/check-research.js`).
- **Real-data forecast validation** on 6.37M incidents across five city portals, 28 panels,
  reproducible from `ml/RESULTS.md`.
- **A measured noise floor** from six independent realisations of one intensity field, which is what
  makes the headroom figures honest rather than optimistic.
- **A calibration report** printed by every generator run, comparing generated shares against NCRB
  per state, group and head.
- **`/admin/status` and `/admin/zcql`** for verifying what the store actually holds, and
  `tools/usage.js` for what it cost.

---

## Documentation

`documentation/` is the technical set, written to be read in order.

| | |
|---|---|
| 01–02 | overview, architecture |
| 03–04 | infrastructure and deployment, data model |
| 05–06 | API reference, conversational AI |
| 07–08 | analytics framework, predictive engine |
| 09–10 | frontend, security and governance |
| 11–13 | feature status, setup, file-by-file reference |
| 14 | migration to Zoho-native AI |
| 15 | WhatsApp field-officer channel |
| 16–18 | open-source research engine, its retrieval techniques, and the remaining-work list |

Two files are the operational truth and are kept current ahead of the numbered set:
[`datastore/DATA_STATE.md`](./datastore/DATA_STATE.md) for what the Data Store holds and what it
costs, and [`ml/RESULTS.md`](./ml/RESULTS.md) for every accuracy claim. `DEVELOPMENT.md` covers the
build environment, the console browser automation, and the scale findings.

Platform, model, library and data-source attribution: [CREDITS.md](./CREDITS.md).
