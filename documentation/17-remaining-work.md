# 17 — Remaining work

An honest list of what is not finished, as of the `research` branch head. Ordered by what
blocks value, not by effort.

Legend: 🔴 blocks the feature being usable · 🟠 real gap worth closing · 🔵 optional or
watch-only · 👤 needs a human decision or an account action

---

## 1. Wiring the research engine into the product — **done**

The engine, the function, the desk client and the WhatsApp channel are all deployed and
verified live end to end: a run started from a handset, delivered by callback, answered
follow-up questions about its own sources, and rendered in all three languages. `research`
is merged to `main`.

What is left here is one operational hazard, and it is not a wiring gap.

| | Item | Notes |
|---|---|---|
| 🟠 | **A run in flight can be lost silently, and the officer waits forever** | Observed: a run started ~25 s after an engine deploy never produced a callback, and nothing told the officer. Runs live in the AppSail instance's memory, so a container replaced mid-run takes the run with it — a rollout, a scale event, or a recycle. The officer has already been promised "I will send the findings here". The proper fix is the shared run store in §2; the cheap mitigation is not to deploy the engine while a run is outstanding. |

Two smaller things settled along the way, recorded so they are not re-litigated:

* The web `POST /research` uses a bare `requireRole()` and defers to the engine's
  governance layer for the kind-level decision. That is deliberate — **one** authoritative
  gate. The WhatsApp tool mirrors the same rule locally only so it can answer with the
  reason instead of spending a round-trip; it does not add a second, coarser gate, which is
  the mistake it previously made.
* The copy lint now has nothing research-shaped left to catch: every officer-facing string
  in the delivery path, bands and disclaimer included, comes from `lib/wa/copy.js`, and the
  three-language parity test recurses into the pack's nested maps.

---

## 2. The research engine

Nothing here is broken. These are the places where it is thinner than it looks.

| | Item | Notes |
|---|---|---|
| 🔵 | **`deep` mode is real now, and measured** | It was worse than untested: `max_rounds` was set to 2, documented as following leads, and read by nothing — so `deep` was `standard` with a bigger fetch budget. Round two now asks the model what round one revealed, and only chases leads that both name the subject and add a term we did not already have. Measured live: 72 s, 241 candidates, 119 of 120 pages readable. See [18 §7](./18-engine-techniques.md). |
| ✅ | **WhatsApp delivery now runs against Meta** | Was: never exercised past the unit tests. Verified live on a real handset in English, Kannada and Hindi, including the follow-up path. Four defects only that exercise could find are written up in [16](./16-research-engine.md) — wrong language, the report missing from history, history truncating the source list, and the list carrying its own numbering that contradicted the summary's citation markers. |
| 🔵 | **The render tier was investigated and rejected** | This row previously said the render tier was justified and unbuilt. It was measured and the justification did not survive: MSN is not fixed by a browser, LiveLaw's search is closed by robots.txt rather than by JavaScript, and the remaining JS-only search pages were six Quintype sites whose own JSON API is better than a rendered page. A 1.38 GB Chromium image would have bought nothing. Full findings in [18](./18-engine-techniques.md). Revisit only if a tier appears that surfaces app-shell pages we are permitted to read and that have no API. |
| 🔵 | **Cross-encoder reranking — done** | Cohere Rerank v4.0 Pro scores every candidate against the subject before the read budget is spent. See [18 §5](./18-engine-techniques.md) for the measurements. The lexical path remains as the fallback. |
| 🔵 | **The general-web tier is live** | Firecrawl `/v2/search`, keyed by `WEB_SEARCH_KEY` (falls back to `FIRECRAWL_API_KEY`). It is the only tier that reaches forums, video, social and district-level local sites, and on the first live query it also surfaced a court record no news tier had. Switching it on caused two regressions which are fixed and documented in [18 §6](./18-engine-techniques.md) — social/video pages were burning reads, and 20 results per query crowded Kannada coverage out of the budget. |
| 🟠👤 | **The web tier is the first paid dependency in the retrieval path** | Five search calls per standard run, ten per deep run, on the operator's Firecrawl key. Fine for a pilot; KSP needs its own key and a view on volume before this is production. Unset the variable and the engine degrades to press-only and says so — `/health` reports `web: false`. |
| 🟠 | **Reranking depends on an Azure resource this project does not own** | The Cohere deployment lives on an Azure AI Foundry resource belonging to another of the operator's projects, reached with a key held in AppSail env. It works and it is cheap, but KSP should own the resource before this is anything but a pilot. Losing it degrades runs quietly rather than loudly, which is why `/health` reports `rerank` separately. |
| 🟠 | **Chunk-level attribution** | Up to 60,000 characters of a story are scored as one blob. Attributing the specific passage that names the subject would sharpen both the band and the claim spans. |
| 🔵 | **The failing on-site adapters were diagnosed and fixed** | Was: three adapters failed every run and nobody had looked. Diagnosed by querying each with three unrelated subjects and comparing the link sets. Four were returning the same front page every time — `thehindu`, `indianexpress` (partly), `udayavani`, `vijaykarnataka` — and `livelaw` was refused by its own `robots.txt`. Five removed, six switched to Quintype's JSON API, and link extraction now ranks by query-term overlap instead of DOM position. A standard run went from 38.4 s to 22.9 s with 48 of 48 pages readable. What remains: `onsite:indiankanoon` still returns nothing for some subjects, which is genuine — it holds judgments, not news. |
| 🟠 | **Quintype's search is fuzzy and we cannot tighten it** | `advanced-search` ORs the query terms; an exact-phrase query returns zero. So a search for "Vipul Singh" also returns Manmohan Singh, and roughly two-thirds of a run's stories grade `unrelated`. That is the documented preference — recall over precision, every link shown with its band — and global title-match ranking in `_prefilter` keeps the real matches at the top of the read order. It still costs reads. A cross-encoder reranker (next row) is the honest fix, not a per-site filter. |
| 🔵 | **Attribution is measured now, and the measurement found two false confirms** | `app/eval_attribution.py` — 17 hand-labelled documents across four subjects, every one retrieved by this engine during live testing, with the namesake traps that actually fooled earlier versions. Two hard gates at zero: somebody else's document graded `probable`+ (a false confirm), and our document graded `unrelated`/`different_person` (a dismissal). Currently 0 of 11 and 0 of 6, with 4 of 5 graded confident. It found and fixed a social-profile false confirm and a keystone-only topic false confirm. |
| 🟠 | **17 documents is a harness, not a field validation** | The eval catches the day a change makes attribution worse. It cannot give the false-confirm rate on the real distribution of KSP casework, because that distribution is not in it. Growing it towards thirty subjects with real case files — especially deliberate same-district namesakes, which is the hardest class — is work only KSP can do. Every added case is permanent protection. |
| 🟠 | **GDELT rate-limits our IP** | One request per five seconds with a penalty window that outlasts a run. Half of this was our own fault and is fixed: a 429 is now recorded per host with the server's own `Retry-After` (120 s when it sends none), the window survives the run, and nothing re-asks inside it — previously each run cheerfully re-asked while the last penalty was open and earned a longer one. Alias legs are also deep-mode-only now, so `standard` spends two GDELT calls rather than four. What remains is not engineering: back-to-back runs still lose the tier for ~2 minutes. If GDELT breadth matters operationally, ask its maintainer for a larger quota. |
| 🔵 | **Three discovery tiers are off** | 5 of 8 live. SearXNG needs a self-hosted instance (`SEARXNG_URL`); Marginalia needs a key its maintainer gives out freely (`MARGINALIA_KEY`); Mojeek stays off because its `robots.txt` disallows `/search`. Each is breadth for the long tail, not load-bearing. |
| 🟠 | **The vernacular summary depends on the model, and GLM is weaker in Hindi** | `reply_language` makes the summary come back in Kannada or Hindi and it works, but the Hindi output is visibly rougher than the English: one live run misspelled *राज्य* and repeated the same sentence three times. Retrieval, grading and the source list are unaffected — this is prose quality in the one part a model writes. Worth measuring against a stronger model before anyone reads these in the field. |
| 🔵 | **No Kannada-script transliteration of Latin names** | A deliberate ceiling, documented in `plan.py`: doing it badly produces queries that match nothing while looking like coverage was checked. The visible consequence is that a Kannada report which never spells the subject's name in a form we hold is graded `unrelated`. Closing it properly needs a phonetic model. |
| 🔵 | **Single-instance assumption** | Runs and the per-officer daily cap live in memory. With more than one AppSail instance a poll can land on the wrong one; the API returns a clear 404 rather than an empty result, but the feature degrades. A second instance needs a shared store first. |
| 🔵 | **The SSE stream is only auth-tested** | `GET /research/{id}/stream` is verified to refuse an unauthenticated caller. Its event sequence is not covered by a test, and the desk UI polls instead of streaming, so nothing in the product exercises it today. |

---

## 3. Deployment and platform

| | Item | Notes |
|---|---|---|
| 🟠 | **The image upload host is unreachable from this build host** | `catalyst deploy` PUTs the container image to `cr-<env>-<project>.zohostratus.in`; TCP 443 to that address is filtered on this ISP path while the Catalyst API itself is fine. Worked around with an SSH SOCKS tunnel plus `tools/connect-proxy.js` (see [16](./16-research-engine.md)). A build host with clean egress removes the workaround entirely. |
| 🟠 | **`catalyst deploy` ships a stale image without saying so** | The engine's AppSail source is a `docker://` tag, so the CLI publishes whatever that tag points at and never builds from `research/`. Forget `docker build` and you get `DEPLOYMENT SUCCESSFUL` on last week's code. It cost two "verified" deploys here. There is no guard; the only defence is running the build in the same breath as the deploy, and the schema probe in [16](./16-research-engine.md) when a change appears not to land. |
| 🟠 | **`catalyst_auth` cannot be set from the repo** | The CLI hard-codes it to `true` for container images and the configuration API ignores the flag. It is inert for a custom runtime — verified — so nothing is broken, but it is not declarable, and a future Catalyst change could start enforcing it. |
| 🔵 | **Environment variables are not in version control** | Also a CLI limitation on the container path: `env_variables` in `catalyst.json` is not read. The twelve variables live on the service and survive redeploys, but there is no declarative record of *which* keys should exist beyond `catalyst-config.example.json`. |
| 🔵 | **Watch memory and disk** | 1024 MB / 256 MB disk. Thirty concurrent fetches with trafilatura fit comfortably in local runs; `deep` mode with eighty has not been observed on the platform. |
| 🔵 | **A transient project-wide halt was observed once** | For about ten minutes after the first deploy, every route on the project — research, forecasting and the main API — answered `SUBSCRIPTION_USAGE_LIMIT_REACHED`, then recovered unprompted. If it recurs, check whether the *other* services are also refusing before blaming the newest one. |
| 🔵 | **`ml/service` is not declared in `catalyst.json`** | Pre-existing. The forecasting AppSail is live but was deployed outside the project config, so `catalyst deploy` does not manage it. |

---

## 4. Security and governance

The first row is the largest gap in the whole system and it is not specific to research.

| | Item | Notes |
|---|---|---|
| 🔴👤 | **RBAC is a request header** | `x-user-role` is trusted as sent. Anyone who can reach the API can claim `admin`. Research inherits this: its governance module correctly refuses a `policymaker` person lookup, but a caller simply says `investigator`. Binding roles to Catalyst Authentication claims is the fix, and until it exists every role gate in the product is advisory. Pre-existing and already flagged in [11](./11-feature-status.md); restating it here because open-source research on named individuals is the feature where it costs the most. |
| 🟠 | **Audit lines have no retention or export** | One structured JSON line per governed action to stdout, captured by Catalyst. There is no query path, no retention policy and no way to answer "show me every search this officer ran last month" without reading platform logs. For a purpose-bound surveillance-adjacent capability, that is the weakest part of the governance story. |
| 🟠 | **The daily cap resets on restart** | In memory, per officer, 40 runs. A guard-rail, not a control, and honest about it — but a restart clears it. |
| 🔵 | **`ADMIN_KEY` has a hard-coded default** | Pre-existing, already in [11](./11-feature-status.md). |
| 🔵 | **No abuse signal on the subject side** | Nothing notices that the same officer researched forty different people in a week within the cap, or that a subject has been researched repeatedly by different officers. Both are the patterns an audit would actually look for. |

---

## 5. WhatsApp channel

Live. Meta app, sender, permanent system-user token, webhook subscription, Catalyst job
pool, Stratus photo bucket and the daily alert cron are all provisioned, and turns have
been exercised against a real handset in all three languages.

| | Item | Notes |
|---|---|---|
| 🟠 | **Free-form only, by choice** | Templates are refused at the transport (`WA_ALLOW_TEMPLATES=false`), so anything outside Meta's 24-hour service window is deferred rather than sent, and the dedupe key is deliberately left unclaimed so the warning is not silently retired. `ksp_early_warning_v2` is approved and unused, which pre-pays the review wait if this changes. |
| 🟠 | **`WA_SELF_ROLE=true` on this deployment** | Officers pick their own access context during setup. It is a demo relaxation of the channel's central trust boundary — role belongs to the roster, never to a message — and it is off by default in the code. Role changes are audited. |
| 🟠 | **Grounding verifies identifiers, not names** | A fabricated person name passes. Observed variant: asked about a source in a research report, the model invented an expansion for an acronym and attached it to a real citation, which reads as checked. The prompt now forbids it and the report is no longer truncated out of history, but the enforcement gap is real. |
| 🔵 | `PersonPhotos` gallery is empty, so facial comparison matches nothing until officers enrol photos. The crime dataset contains none. |
| 🔵 | **A run's in-memory registry is the weak link, not the channel** | See §1. |

Full detail: [15-whatsapp-field-bot.md](./15-whatsapp-field-bot.md).

---

## 6. Data and documentation

| | Item | Notes |
|---|---|---|
| 🔵 | **All data is synthetic** | Calibrated against real NCRB aggregates, but no real case reaches the research engine's anchors. Attribution quality against real records is therefore unproven. |
| 🔵 | **`13-file-reference.md` lags in places** | It now lists the research and WhatsApp trees, but the per-file detail for `lib/wa/*` lives only in [15](./15-whatsapp-field-bot.md). |
| 🔵 | **`POST /chat/:sessionId/pdf` is still a 501 stub** | Pre-existing; the client exports locally and the stub is unused. |

---

## Shortest path to a working demo

Everything is deployed. Open *Open Sources*, research a real event with a purpose, and
export the PDF; or message the field bot and ask it to search the open internet for an
organisation and then question it about one of the sources it cites.

Everything else is on this list.
