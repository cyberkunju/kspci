# 17 — Remaining work

An honest list of what is not finished, as of the `research` branch head. Ordered by what
blocks value, not by effort.

Legend: 🔴 blocks the feature being usable · 🟠 real gap worth closing · 🔵 optional or
watch-only · 👤 needs a human decision or an account action

---

## 1. Wiring the research engine into the product

The engine is deployed and verified live. The **product cannot reach it yet**, because
the deployed API function predates the routes.

| | Item | Notes |
|---|---|---|
| 🔴👤 | **Add `RESEARCH_SERVICE_URL` and `RESEARCH_INTERNAL_KEY` to the API function** | URL is `https://research-50044266480.development.catalystappsail.in`; the key is on the AppSail service (Console → AppSail → research → Configurations) and saved locally at `~/.ksp-research-internal-key`. Deliberately not done for you: adding env vars to a live function is a read-merge-write against a working production app, and getting the merge wrong wipes the rest. |
| 🔴👤 | **Deploy the function code** | The deployed function is built from `main` and has no `/research*` routes at all. Deploying this branch also publishes the WhatsApp channel — its routes fail closed without `WA_*` set, so it is functionally inert, but it is still a wider change than the research feature alone. |
| 🔴 | **Build and deploy the client** | The *Open Sources* panel exists but is not in the hosted bundle. `cd client && npm ci && npm run build`, then `catalyst deploy --only client`. |
| 🟠👤 | **Set `RESEARCH_CALLBACK_URL`** | Only needed for WhatsApp. Both research modes take 90–300 s, so the channel starts a run and the engine POSTs the finished report back to `/research/callback`. It defaults to `WA_PROCESS_URL`'s host + `/research/callback`, so a deployment that already has the WhatsApp channel configured needs nothing — but nothing is delivered if neither is set. |
| 🟠👤 | **Decide the branch story** | `research` is based on `whatsapp`, which is based on `main`. Merging `research` into `main` therefore lands both features. If you want them separately, `whatsapp` has to merge first. |
| 🔵 | Add `research` to the WhatsApp copy lint | `scripts/lint-wa-copy.mjs` does not yet check the `open_source_research` tool's officer-facing strings for a Kannada counterpart. |

---

## 2. The research engine

Nothing here is broken. These are the places where it is thinner than it looks.

| | Item | Notes |
|---|---|---|
| 🟠 | **`deep` mode has never been run against live sources** | 300 s / 120 fetches / two rounds, and now one of only two modes an officer can pick. The budget exists and the code path is exercised only by the offline suite; cost and behaviour under it are unmeasured. This is the largest untested surface in the feature. |
| 🟠 | **WhatsApp delivery has never run against Meta** | The callback path, the formatting, the dedupe and the service-window refusal are unit-tested, and the engine's side is verified live. The last hop — an actual message arriving on a handset — needs the Meta provisioning in §5. |
| 🔵 | **The render tier was investigated and rejected** | This row previously said the render tier was justified and unbuilt. It was measured and the justification did not survive: MSN is not fixed by a browser, LiveLaw's search is closed by robots.txt rather than by JavaScript, and the remaining JS-only search pages were six Quintype sites whose own JSON API is better than a rendered page. A 1.38 GB Chromium image would have bought nothing. Full findings in [18](./18-engine-techniques.md). Revisit only if a tier appears that surfaces app-shell pages we are permitted to read and that have no API. |
| 🟠 | **Cross-encoder reranking** | Rank fusion is the cheap approximation — it knows what several sources thought was relevant to the *query*, not what is about the *subject*. A small `bge`-class reranker scoring `(query, passage)` pairs is the real fix for choosing which 48 of 128 candidates to read. Unmeasurable until the labelled set below exists. |
| 🟠 | **Chunk-level attribution** | Up to 60,000 characters of a story are scored as one blob. Attributing the specific passage that names the subject would sharpen both the band and the claim spans. |
| 🔵 | **The failing on-site adapters were diagnosed and fixed** | Was: three adapters failed every run and nobody had looked. Diagnosed by querying each with three unrelated subjects and comparing the link sets. Four were returning the same front page every time — `thehindu`, `indianexpress` (partly), `udayavani`, `vijaykarnataka` — and `livelaw` was refused by its own `robots.txt`. Five removed, six switched to Quintype's JSON API, and link extraction now ranks by query-term overlap instead of DOM position. A standard run went from 38.4 s to 22.9 s with 48 of 48 pages readable. What remains: `onsite:indiankanoon` still returns nothing for some subjects, which is genuine — it holds judgments, not news. |
| 🟠 | **Quintype's search is fuzzy and we cannot tighten it** | `advanced-search` ORs the query terms; an exact-phrase query returns zero. So a search for "Vipul Singh" also returns Manmohan Singh, and roughly two-thirds of a run's stories grade `unrelated`. That is the documented preference — recall over precision, every link shown with its band — and global title-match ranking in `_prefilter` keeps the real matches at the top of the read order. It still costs reads. A cross-encoder reranker (next row) is the honest fix, not a per-site filter. |
| 🟠 | **Attribution thresholds are tuned on a handful of subjects** | The bands separate cleanly on the cases tested (13 confirmed / 15 unrelated on a real Bengaluru case, with reasons). That is evidence, not validation. A labelled set of thirty subjects — including deliberate namesakes — would tell you the false-confirm rate, which is the number that actually matters. |
| 🟠 | **GDELT rate-limits our IP** | One request per five seconds with a penalty window that outlasts a run; the adapter spaces, detects and cools down, and reports the loss. During heavy testing it contributed nothing to several runs. If GDELT breadth matters, ask its maintainer for a larger quota rather than engineering around it. |
| 🔵 | **Three discovery tiers are off** | 5 of 8 live. SearXNG needs a self-hosted instance (`SEARXNG_URL`); Marginalia needs a key its maintainer gives out freely (`MARGINALIA_KEY`); Mojeek stays off because its `robots.txt` disallows `/search`. Each is breadth for the long tail, not load-bearing. |
| 🔵 | **No Kannada-script transliteration of Latin names** | A deliberate ceiling, documented in `plan.py`: doing it badly produces queries that match nothing while looking like coverage was checked. The visible consequence is that a Kannada report which never spells the subject's name in a form we hold is graded `unrelated`. Closing it properly needs a phonetic model. |
| 🔵 | **Single-instance assumption** | Runs and the per-officer daily cap live in memory. With more than one AppSail instance a poll can land on the wrong one; the API returns a clear 404 rather than an empty result, but the feature degrades. A second instance needs a shared store first. |
| 🔵 | **The SSE stream is only auth-tested** | `GET /research/{id}/stream` is verified to refuse an unauthenticated caller. Its event sequence is not covered by a test, and the desk UI polls instead of streaming, so nothing in the product exercises it today. |

---

## 3. Deployment and platform

| | Item | Notes |
|---|---|---|
| 🟠 | **The image upload host is unreachable from this build host** | `catalyst deploy` PUTs the container image to `cr-<env>-<project>.zohostratus.in`; TCP 443 to that address is filtered on this ISP path while the Catalyst API itself is fine. Worked around with an SSH SOCKS tunnel plus a local CONNECT bridge (see [16](./16-research-engine.md)). A build host with clean egress removes the workaround entirely. |
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

## 5. WhatsApp channel (pre-existing, unchanged by this work)

Built and tested — 79 unit checks plus a smoke run — but never exercised against Meta.

| | Item |
|---|---|
| 🔴👤 | Meta app, phone number, permanent system-user token, webhook subscription |
| 🔴👤 | `ksp_early_warning` template submitted and approved (required outside the 24-hour window) |
| 🟠👤 | Catalyst job pool created and `WA_JOBPOOL` / `WA_PROCESS_URL` set, otherwise turns process inline |
| 🟠👤 | Officer roster seeded via `POST /admin/officers` — a number absent from it receives nothing, by design |
| 🔵 | `PersonPhotos` gallery is empty, so facial comparison matches nothing until officers enrol photos. The crime dataset contains none. |

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

1. Build and deploy the client.
2. Add the two `RESEARCH_*` variables to the function and deploy the function.
3. Open *Open Sources*, research a real event with a purpose, export the PDF.

Everything after that is on this list.
