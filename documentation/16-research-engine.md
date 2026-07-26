# 16 — Open-source research engine

> Feature: an officer names a person, a crime, an event or an organisation, and the
> system searches the open internet — news, courts, government, Kannada and English —
> then returns every source it found **graded by how confident it is that the source is
> actually about that subject**, plus a cited summary.
>
> Code: `research/` (the engine, a Catalyst AppSail container) and
> `functions/api/lib/research.js` (the bridge that anchors and proxies it).

---

## Why it is a separate service

A Catalyst **Advanced I/O function is killed at 30 seconds**. A broad research run takes
40 seconds in standard mode and up to five in deep mode, most of it waiting on other
people's servers. There is no way to fit that in the function, so the engine runs as an
AppSail service — a container with no request ceiling — and the function starts runs
there and polls.

Everything else follows from that one fact: the run registry, the poll endpoint, the
progress stream, and the sync endpoint that exists only for the callers (WhatsApp, voice)
that cannot poll and are willing to accept quick mode's smaller budget in exchange.

---

## The two ideas that make it accurate

### 1. Anchors, not names

"Suresh Kumar" has millions of matches. "Suresh Kumar", Mysuru, aged 34, FIR 118/2023,
co-accused Manjunath has approximately one. **The engine's accuracy is almost entirely a
function of what it knew before it searched**, so the bridge pulls those facts from our
own Data Store before the run starts:

| Anchor | Where it comes from |
|---|---|
| district, age, FIR numbers | `Accused` rows matching the name |
| state, station, acts & sections, dates | the `Cases` rows behind those |
| co-accused | `CoAccusedLinks`, matched on **either** side |
| subject role | `Victims` / `Complainants` — see governance below |

Anchors are used twice. They go **into the queries** (`"Suresh Kumar" "118/2023"` finds
the right person directly instead of finding a thousand and filtering), and they **cap
what the attribution stage may conclude** — a run anchored on a bare name cannot reach
`confirmed`, because the evidence could not possibly distinguish two people. The UI shows
which anchors were used and labels the run *Strongly anchored*, *Partly anchored* or
*Name only*, because "confirmed" means something very different in each case.

If the Data Store is unreachable the run still happens on the name alone and reports that
the anchors were thin. A weakly anchored run that says so is useful; a weakly anchored run
that claims certainty is dangerous.

### 2. Attribution is the product

Every source comes back in one of five bands, each with the reasons behind it:

| Band | Meaning |
|---|---|
| `confirmed` | multiple discriminating anchors matched |
| `probable` | the name plus at least one anchor |
| `possible` | the name, nothing more |
| `different_person` | it is a namesake, and we can show why |
| `unrelated` | not about this subject at all |

`different_person` is a first-class useful answer: it tells the officer we looked and it
was not them, which is not the same as finding nothing. Wikidata is queried for how many
public figures share the name, and a crowded name lowers the ceiling on every band.

**Attribution grades what is shown, it does not decide what is shown.** Every retrieved
link reaches the officer's table with its band, the reasons behind it, which anchors it
matched, the site, the publication date, the language, the source authority, how many
independent outlets carried it, and which tier found it — including links that could not
be read at all. Cross-checking is the officer's job, and a tool that hides a weak match to
protect its own precision has made that job harder.

The summary follows the same posture with one refinement: it rests on sources at
`probable` or better when any exist, and falls back to the weaker ones only when there is
nothing better. Every claim carries its confidence into the prose — *"a report that may
refer to the same person…"*, *"a lower-authority source…"* — and the run states how many
weaker matches were listed but not summarised. When nothing at all could be attributed, a
separate note is written saying so, what was searched for, and who the retrieved coverage
was actually about. That replaces the old behaviour of returning an empty summary, which an
officer cannot distinguish from a crash.

### An alias is an anchor

Two of the caller's distinct names in one document — a legal name and an alias — is the
strongest identity evidence available when no case anchors exist. Aliases are split out of
`"Vipul Singh alias Khooni"` once, in `plan.resolve_names`, and used by both the planner and
the scorer; when only the planner split them the scorer went on hunting for the literal
phrase, which no document contains, and graded every source `unrelated`.

---

## Source tiers

Grouped by **how each one fails**, because that is what determines how to use it.

| Tier | Sources | Why |
|---|---|---|
| **News feed** | Bing News RSS | The breadth tier, and the one that fixed the engine's worst blind spot. Keyless, answers from a datacenter, multilingual, and the item link embeds the **publisher's** url so there is no redirect to follow. |
| **Datasets** | GDELT DOC 2.0, Wikipedia, Wikidata, Wayback CDX | Published for machines. No key, no quota, reliable from a datacenter. |
| **On-site** | 27 official domains + 16 Kannada + 21 Hindi outlets; 13 with a queryable search endpoint | For a court or a newsroom this is simply the correct method, and it reaches vernacular coverage no English-first index surfaces. |
| **Metasearch** | SearXNG, Marginalia, (Mojeek) | Long-tail breadth. Deliberately last, deliberately optional. |

### Why a news feed, and why that one

The on-site registry was Karnataka, national English and Kannada. A live test on a wanted
man shot dead in Baghpat — covered the same day by Hindustan Times, ThePrint, Aaj Tak, ABP,
Bhaskar and Live Hindustan — returned **zero attributable sources**, because not one of
those outlets was queried. Crime reporting in India is local and vernacular first, so a
registry that speaks one language knows one part of the country.

Two dozen Hindi and national search endpoints were probed against that live subject before
choosing. Most Indian newsrooms answer `/search` with a JavaScript shell and hand a crawler
their front page; only ThePrint and New Indian Express returned real article urls, and those
two were added. The rest of the country is reached through the feed instead, which is the
honest place for it.

**Google News RSS was rejected**, despite returning 56 Hindi items for the same subject:
`news.google.com/robots.txt` is `Disallow: /` with an allow-list that excludes `/rss`, and
its item links resolve to a search page rather than to the publisher. Bing's robots
disallows `/search`, which does not match `/news/search`, and has no `/news` rule. Same
standard that keeps Mojeek switched off.

**Google is deliberately absent.** SearXNG has no index of its own — it scrapes Google
and Bing, and those CAPTCHA datacenter ranges. Building discovery on it would work in
development and degrade badly in production, so the reliable tiers carry the weight and
metasearch is opportunistic and non-load-bearing.

**Mojeek is off by default.** Its `robots.txt` disallows `/search` and we honour robots.
The adapter is kept because Mojeek offers a licensed API; if that is ever arranged this
becomes a one-line switch.

**There is no headless browser.** Every URL fetched comes from a news index or a
newsroom's own search, and those pages are server-rendered because their publishers need
them indexed — the live runs read 30 of 30. A Chromium container would be 2 GB of
infrastructure answering a problem we have not observed.

### GDELT's rate limit, and why it also shapes the design

GDELT allows **one request every five seconds** and answers a violation with HTTP 429 and
a **plain-text body** — which parses as "no coverage exists" unless you check. That is
the most dangerous wrong answer a research engine can give, so:

- the adapter enforces 5.5 s spacing, detects both the 429 and the non-JSON body, and
  puts GDELT in a 180-second cooldown that survives the end of a run (a rate limit is a
  property of our IP, not of one run);
- GDELT gets **one rich query** carrying the subject plus every corroborating fact as an
  OR group, asking for up to 250 records, rather than a share of fourteen narrow ones;
- a failure is named in the run's `sources_failed`, so thin coverage never masquerades as
  an absence of coverage.

### GDELT is a recency tier, not an archive tier

Per [GDELT's own API documentation](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/),
the DOC 2.0 full-text API searches a **rolling window of the last three months**, and
`timespan` can only *narrow* that window — a larger value is silently clamped. So:

- The default is `3months`, not a larger number that reads like coverage and is not.
- When the case period falls **inside** the window, the bridge passes the earliest date
  it holds and the planner converts it to an absolute window opening **60 days before**
  the case date — reporting routinely precedes registration. It is left open at the top,
  because the chargesheet and the verdict come later.
- When the case period falls **outside** it — a 2019 offence — no absolute window is sent
  (the API would reject it) and the run **says so in its warnings**: *"GDELT indexes only
  the last three months, which does not reach 2019-06-15; its contribution covers recent
  reporting about this subject, not the incident period."* GDELT is still queried, because
  a chargesheet reported this month about a 2019 offence is inside the window and is
  exactly what an officer wants.

That distinction — **a tier that cannot reach the period is a limit, not an absence** — is
the same principle as the 429 detection, and it is the one thing this engine must never
get wrong.

---

## The pipeline

```
plan → discover → prefilter → retrieve → cluster → attribute → claims → summarise
```

Two properties govern all of it.

**The deadline is real.** Every stage checks it. When it expires the run returns what it
has, labelled `partial`, naming the stages it never reached. A research tool that hangs is
worse than one that says "here are 31 sources, I ran out of time before reading the last
12" — the officer can act on the second and can only wait on the first.

**Degradation is the normal case, not the error path.** With nine sources something is
always having a bad day, and the model may be unreachable. Each stage is written so its
absence costs exactly one capability: no model means no summary but a full attributed
source list; no GDELT means less breadth, named in the report. Nothing cascades.

Stage notes worth knowing:

- **prefilter** — asked for something it has no match for, a newsroom's search page
  returns its *latest* articles rather than nothing. Fetch in discovery order and thirty
  reads get spent on today's front page while a real match sits unread at position forty.
  So hits are ordered by apparent relevance first. Nothing is discarded; a title is weak
  evidence and the relevance decision belongs to attribution, which has the full text.
- **cluster** — simhash over 3-word shingles, threshold 10, **measured**: boilerplate
  variants of one page land at 2–8, truncation at 13–17, independent reporting at 36. A
  wire report republished by twelve outlets is one fact carried twelve times, not twelve
  independent confirmations, and counting URLs instead of stories is how one unverified
  claim becomes "widely reported".
- **claims** — each claim carries the **verbatim span** it came from, and the span is
  re-found in the stored document text before the claim is admitted. A citation that
  points at a URL is a promise; one that points at a quoted span is checkable, and the
  pipeline checks it. The summary's markers are validated against the admitted set, so a
  marker cannot refer to a source that was withheld.

---

## Governance

This is a police force searching the open web for named individuals. That is ordinary
lawful investigative practice, and it is also the exact shape of thing that becomes
surveillance if built without limits. The limits sit in front of the pipeline
(`research/app/governance.py`), not in a policy document:

- **Purpose binding.** A run states why, in at least three real words — `"checking"` and
  `"test"` are rejected by pattern. It is recorded. There is no anonymous lookup.
- **Subject-type gate.** Victims, complainants, witnesses, informants and minors are
  refused outright, and not configurably. The bridge determines the subject's role **from
  our own records**, never from the caller, so a client cannot launder a protected person
  past the gate by asserting they are a suspect. Someone who is *both* an accused and a
  victim is researchable — the accused record governs, or the tool would be useless on
  exactly the people it exists for.
- **Role gate.** Person-level research needs an operational role; the read-only
  policymaker role gets aggregate kinds only. This mirrors the web API's RBAC so the same
  officer cannot reach further by switching channel. **The rule lives in one place** — the
  function does not re-implement it, because two copies drift and the one that drifts
  loose is the one that matters.
- **Daily cap** per officer. A researcher needing sixty subjects a day is doing something
  this tool was not built for, and the cap makes that visible.
- **Audit.** One structured JSON line per governed action to stdout, which Catalyst
  captures — the audit trail without a second store to keep. The WhatsApp channel sends
  the officer *id*, not the handset number, because a phone number does not need to be in
  a log line.
- **Disclaimer** attached to every result and to every exported report.

Access control on the service itself: **every route requires `x-research-key` and fails
closed** — with no key configured, nobody may drive it. This service fetches
attacker-influenceable URLs on instruction, and that key is what stops it being an open
proxy. It never reaches a browser.

### Fetch-path hardening

- **SSRF defence**: every resolved address is checked, and re-checked on **each redirect
  hop** — a public hostname that 302s to `169.254.169.254` is the whole attack.
- `robots.txt` is honoured, failing open on an unreachable robots file.
- Per-host concurrency limits and a real, contactable User-Agent. That is not politeness
  theatre: it is what lets a publisher rate-limit us instead of banning us.
- Page text is screened for prompt injection before any model sees it, and flagged.

---

## What it costs and how long it takes

Measured against real sources, subject "Rameshwaram Cafe blast" (a real Bengaluru case):

| | |
|---|---|
| Full run, model on | **34–42 s** — discover ~15, retrieve ~5, cluster+attribute 0.1, claims+summary ~21 |
| Same run, no model | 6.0 s warm, 12–31 s cold (TLS handshakes to 12 hosts) |
| Found | 49 candidates → 30 fetched → 30 readable → 29 stories |
| Graded | **13 confirmed, 1 probable, 15 unrelated**; 5 Kannada sources, 2 official |
| Claims | 19–26 extracted, **all span-verified, 0 withheld** |
| Output | cited summary naming the IED, 1 March, and the NIA arrests (Muzammil Shareef, Mussavir Hussain Shazib); a dated timeline of the same length |

That run reached its result **with GDELT contributing nothing** — our IP was inside
GDELT's rate-limit penalty window, and the run reported that rather than pretending
otherwise. The on-site tier carried it, which is the argument for building discovery on
publishers' own search rather than on a metasearch layer.

Budgets (`research/app/config.py`): **quick** 25 s / 10 fetches, **standard** 90 s / 48,
**deep** 300 s / 120. `max_fetch` is the number that matters: it decides how many
discovered links are actually READ rather than merely listed, and only a read link can earn
an attribution band. Deep mode has not been measured against live sources.

A second live case, run on the deployed service — a wanted man in Baghpat, subject given as
`"Vipul Singh alias Khooni"` with **no anchors at all**:

| | |
|---|---|
| Time | 63.8 s engine, 66.7 s wall (discovery 31.6 s, retrieval 26 s, claims + summary 5 s) |
| Found | 123 candidates → 48 read → 30 stories |
| Graded | 1 probable, 10 possible, 18 unrelated, 1 different_person |
| Summary | led with the correct finding — the encounter, the STF unit, the 38 cases across UP and Delhi — from the one `probable` source, and said that 10 weaker matches were listed but not summarised |

Worth noting what that run illustrates: `Khooni` is also an ordinary Hindi word, so the
feed returned film columns titled "Khooni Monday", a haunted stepwell, a renamed village
and a 2013 political remark. All eleven are in the table at `possible` with their reasons.
Only the one document that named **both** the legal name and the alias reached `probable`,
and only that one was summarised.

Nothing is persisted. Runs live in memory with a 30-minute TTL, a hard count cap and a
concurrency gate — this is a real-time engine, there is no corpus and no document store,
and a run's value expires with the officer's attention. What persists instead is what the
officer keeps (the exported report) and the audit line. **Consequence, stated rather than
hidden:** with more than one instance a poll could land on the instance that does not hold
the run, so the service runs as a single instance and returns a clear 404 rather than an
empty result if that assumption is ever broken.

---

## API

### On the function (`/server/api`)

| Method | Route | Notes |
|---|---|---|
| `POST` | `/research` | start a run. Body: `subject`, `kind`, `purpose`, `question?`, `mode?`, `crimeNo?`. Returns `{ id, poll, anchors }` |
| `POST` | `/research/sync` | quick mode, completed inside the request (capped at 27 s) |
| `GET` | `/research/:id` | poll state, events, and the result once finished |
| `DELETE` | `/research/:id` | cancel |
| `GET` | `/research/health` | engine reachability and which tiers are live |

All require `x-user-role`; `x-user-id` becomes the officer in the audit line.

### On the engine (internal, `x-research-key` only)

`POST /research`, `POST /research/sync`, `GET /research/{id}`, `DELETE /research/{id}`,
`GET /research/{id}/stream` (SSE), `GET /health`.

The SSE stream exists for a caller that can hold a connection; the function proxies by
polling instead, because a long-lived stream through the API Gateway is not a dependency
worth taking for a progress bar.

---

## Where it appears in the product

- **Desk UI** — `client/src/components/Research.jsx`, nav item *Open Sources*. Form with
  the purpose field, live stage progress (a spinner with no detail invites the officer to
  conclude it has hung and start it again), the anchor summary with its strength label, a
  filterable source table with attribution bands, the dated-claims timeline, and PDF
  export via `client/src/lib/pdf.js`.
- **WhatsApp** — the `open_source_research` tool in `functions/api/lib/wa/tools.js`.
  Operational roles only, quick mode only, purpose required and not defaulted (a default
  would satisfy the check while destroying the thing it protects). Returns the confirmed
  and probable sources; if nothing could be attributed it tells the model to say that
  plainly rather than report "nothing exists about them".

---

## Configuration

**On the AppSail service** (console → Configurations → Environment Variables; container
runtimes have no `app-config.json`):

| Key | Purpose |
|---|---|
| `RESEARCH_INTERNAL_KEY` | **required** — nothing works without it, by design |
| `RESEARCH_LLM_BACKEND` | `openai` \| `quickml` \| unset |
| `QUICKML_LLM_ENDPOINT`, `QUICKML_MODEL`, `QUICKML_ORG_ID`, `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`, `ZOHO_ACCOUNTS_URL` | the QuickML path, same credentials the function uses |
| `OPENAI_API_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL` | any OpenAI-compatible endpoint, including a self-hosted vLLM/Ollama |
| `SEARXNG_URL`, `MARGINALIA_KEY`, `MOJEEK_ENABLED` | optional extra tiers |
| `RESEARCH_DEFAULT_MODE`, `RESEARCH_RUN_TTL_S`, `RESEARCH_MAX_CONCURRENT`, `RESEARCH_FETCH_TIMEOUT_S`, `RESEARCH_USER_AGENT`, `RESEARCH_CONTACT` | tuning |

Two QuickML details that cost real time to find: the org header must be **`CATALYST-ORG`**
(anything else is a 400 that does not mention headers), and Catalyst's GLM serving returns
a flat `{"response": ...}` rather than OpenAI's `choices[0].message.content` — reading only
the OpenAI shape yields a working model that looks unconfigured. Also, **Zoho rate-limits
refresh-token grants**, so the access token is cached module-level for its full lifetime.

**On the function:** `RESEARCH_SERVICE_URL` and the same `RESEARCH_INTERNAL_KEY`. See
`functions/api/catalyst-config.example.json`.

---

## Build, test, deploy

```bash
# Build the image (must be tagged into the local registry for AppSail)
docker build -t localhost/ksp-research:latest research/

# The four suites. All run offline; the pipeline suite fakes discovery and retrieval,
# because a test that depends on what a newsroom published today fails for reasons
# unrelated to our code.
docker run --rm -w /app -e PYTHONPATH=/app localhost/ksp-research:latest python -m app.selftest
docker run --rm -w /app -e PYTHONPATH=/app localhost/ksp-research:latest python -m app.selftest_reason
docker run --rm -w /app -e PYTHONPATH=/app localhost/ksp-research:latest python -m app.selftest_claims
docker run --rm -w /app -e PYTHONPATH=/app localhost/ksp-research:latest python -m app.selftest_pipeline

# Run it locally against real sources
docker run -d --rm --name ksp-research -p 9099:9000 \
  -e RESEARCH_INTERNAL_KEY=dev localhost/ksp-research:latest
curl -s -H 'x-research-key: dev' localhost:9099/health | jq

# Deploy (catalyst.json already carries the appsail entry)
catalyst deploy --only appsail:research
```

See **Deployment state** below for the two non-obvious steps around that last command.

The function's own tests, including the anchor logic, run with `npm test` in
`functions/api` (95 checks).

### Deployment state

**Deployed and verified live.** AppSail service `research` at
`https://research-50044266480.development.catalystappsail.in` — 1024 MB, port 9000,
QuickML model configured, twelve environment variables including a 43-character random
`RESEARCH_INTERNAL_KEY`.

Verified against the running service, not just against the image:

| Surface | Result |
|---|---|
| `GET /health` | 200; model configured, eight source tiers reported |
| `POST /research` without the key | **401** |
| Purpose `"check"` | **403** `purpose` |
| `subject_role: victim` | **403** `subject_role` |
| `role: policymaker` on a person | **403** `role` |
| `GET /research/<unknown>` | **404** |
| Full standard run, "Rameshwaram Cafe blast" | **35.2 s** — 44 candidates → 30 read → 29 stories, **13 confirmed / 1 probable / 15 unrelated**, 6 Kannada, 2 official, **19/19 claims span-verified**, cited summary naming Whitefield, the IED, and the NIA arrests |
| `POST /research/sync` quick mode | **16.2 s**, comfortably inside the calling function's 27 s cap |

The GDELT out-of-range warning fired correctly in production for the 2024 incident date:
*"GDELT indexes only the last three months, which does not reach 2024-03-01…"*

Two things about deploying it are worth knowing, because neither is obvious.

**The image upload target may be unreachable from your network.** `catalyst deploy` asks
the API for a signed URL and then PUTs the image to
`cr-<env>-<project>.zohostratus.in`. On the build host used here that address answered
100% packet loss on TCP 443 while `api.catalyst.zoho.in` responded in 60 ms — an ISP path
problem, not a configuration one, and it presents as a bare `ETIMEDOUT` after four
retries. If you hit it, the deploy works unchanged through any egress that can reach Zoho
Stratus. What was used here: an SSH SOCKS tunnel to a cloud host, plus a small local HTTP
CONNECT proxy, because the Catalyst CLI is built on `request` v2 and therefore honours
`HTTPS_PROXY` but speaks CONNECT rather than SOCKS.

```bash
ssh -N -D 127.0.0.1:1080 <a-host-that-can-reach-zoho-stratus>   # SOCKS5
# any HTTP-CONNECT-to-SOCKS bridge on 127.0.0.1:3128, then:
HTTPS_PROXY=http://127.0.0.1:3128 catalyst deploy --only appsail:research
```

**Only `memory` and `port` are read from `catalyst.json` on the container path.** The
default memory is 256 MB, which is not enough, so it is declared. `env_variables` and
`catalyst_auth` are *not* read — the CLI hard-codes `catalyst_auth: true` for
container-image sources (`lib/util_modules/config/lib/appsail.js`) and never sends
environment variables on that path.

Environment variables therefore live on the service, not in the repo. They are set
through `POST /baas/v1/project/<project>/appsail/<id>/configuration` with a body of
`{"environment": {"variables": {…}}}` — flat, because nesting them under a
`configuration` key is accepted with HTTP 200 and silently ignored — or through
**Console → AppSail → research → Configurations**. Either way they survive a redeploy;
all three redeploys here preserved the twelve variables.

The hard-coded `catalyst_auth: true` is inert for a custom runtime and needs no action:
an unauthenticated `curl` carrying only `x-research-key` reached the app and was answered,
and the same call without the key was refused by the app's own gate with 401. Access
control here is the internal key, and that is what is actually enforcing.

> One transient condition worth recognising if you meet it: for about ten minutes after
> the first deploy every route on the project — the research service, the forecasting
> service and the main API function alike — answered
> `SUBSCRIPTION_USAGE_LIMIT_REACHED`. It cleared on its own. It reads like a permanent
> billing wall and is not necessarily one; check whether the *other* services are also
> refusing before concluding anything about the new one.

---

## Honest limits

- **A Latin-script name is not transliterated into Kannada script.** Doing it correctly
  needs a phonetic model; doing it badly produces queries that match nothing while looking
  like coverage was checked. Kannada coverage is reached three other honest ways instead —
  the Kannada outlets are queried by their own search, GDELT indexes Kannada sources and
  reports their language, and a caller holding a Kannada-script name can pass it as
  another anchor. The consequence is real and visible in the pipeline test: a Kannada
  report that never spells the subject's name in a form we hold is graded `unrelated`.
- **Recall is bought with noise, deliberately.** A subject whose name or alias is a common
  word will return coverage of unrelated things at `possible`. That is the requested
  tradeoff: everything found is shown, labelled, and left to the officer. The summary is
  protected from it by preferring `probable` and above.
- **Some publishers cannot be read even when they are found.** MSN, for example, is a
  JavaScript shell — its copies of the correct story appear in the table with "could not be
  read: no article text found" and a working link, but they cannot earn a band or a claim.
- **The on-site article detector is a heuristic.** It requires the link to be on the
  searched site, to avoid known navigation paths, and to carry a long slug or a numeric id.
  Per-site templates change; a miss costs one source's hits for one run and the run says so,
  and a false positive is discarded when extraction finds no article text.
- **`deep` mode is unmeasured** against live sources.
- **GDELT reaches back only three months.** Historical breadth for an older case therefore
  comes from the on-site tier alone, and the run states that. Verified live: an in-window
  `startdatetime` returns dated results, and a 2024 subject queried with `timespan=3months`
  returns an empty object — which is exactly the "no coverage exists" mirage the warning
  exists to prevent.
- **The daily cap and the run registry are in memory**, so both reset on restart. That is
  honest for a single always-on instance and it is a guard-rail, not a billing control.
- **Nothing here is evidence**, and the product says so in the result, in the UI banner and
  on the exported PDF.
