# 18 — Techniques studied, and what we took

The research engine was built from first principles. Three mature projects solve adjacent
problems far better than we do in places, so their repositories were read in detail and
their **techniques** written down here, then implemented independently against our own
stack.

## The rule this file exists to enforce

Copyright protects expression, not ideas or techniques. Reading a repository, writing down
how it solves a problem, and implementing that approach in a different language and
architecture is legitimate. Transcribing its structure and logic function-by-function into
Python and calling it a rewrite is not.

So: **read for technique, record the technique here, implement from this document.** No
file in `research/` is a translation of a file in any of these projects, and none of their
code is vendored.

That matters commercially as well as legally. Firecrawl's engine and SearXNG are both
**AGPL-3.0**, whose §13 obliges anyone offering a modified version over a network to offer
its source to that service's users. Everything we ship is permissive — verified inside our
own image: trafilatura Apache-2.0, lxml BSD-3, httpx BSD-3, pypdf BSD, FastAPI and pydantic
MIT, uvicorn BSD-3 — and that position is worth keeping for a police deployment. Adopting
either codebase would change what this repository legally is, and that is a decision for
KSP's legal team, not a `git clone`.

| Studied | Licence | What we took | What we did not |
|---|---|---|---|
| [Firecrawl](https://github.com/firecrawl/firecrawl) | AGPL-3.0 (SDKs MIT) | per-host "will a cheap fetch work" verdict | any code; their Node/Redis/worker/proxy infrastructure; **the headless-browser engine — probed and rejected, see §3** |
| [SearXNG](https://github.com/searxng/searxng) | AGPL-3.0 | weighted reciprocal-rank fusion across sources; typed failure classes driving per-source suspension; duplicate merging that keeps the best fields | any code; its scraped-SERP discovery model |
| Perplexity | closed | published/standard retrieval technique only — see below | nothing else exists to take |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | **MIT** | connect-time SSRF posture: judge resolved addresses not input literals, an always-blocked metadata floor, IPv4-mapped and CGNAT handling; never retry a 429; re-validate on every read path | its browser subsystem, its provider plugin layer, its content store — see §7 |

---

## 1. Rank fusion across sources — from SearXNG

**The technique.** SearXNG scores a merged result as
`weight = Π(source weights) × |positions|`, then `score = Σ(weight / position)` over every
position that result appeared at. A result three sources ranked highly outscores one that a
single source ranked first, and a trusted source's opinion counts for more.
(`searx/results.py`, `calculate_score`.) Duplicates are merged rather than dropped: engines
are unioned, positions appended, and the longest title and description win, because some
sources return an empty title.

**Why we needed it.** Our discovery returns 120–130 candidates and we can only read 48. We
were choosing those 48 with `_prefilter` — does a subject word appear in the title, else is
the title blank, else is it a known mismatch — plus tier and recency. Nothing in that used
the strongest signal available: **that several independent tiers surfaced the same URL, and
how highly each ranked it.** We were computing it and throwing it away, keeping the first
occurrence of a duplicate and discarding the rest.

**What we implemented.** `research/app/fuse.py`. Each source carries a weight reflecting how
much its ranking is worth to a police researcher — a court's own search above a wire index,
a wire index above a metasearch engine — and a hit's fused score is the weighted reciprocal
rank summed across every tier that returned it, multiplied by how many tiers those were.
Merging keeps the longest title, the earliest publication date and the union of `via`.

**What we deliberately did not take.** Their second pass regroups results by category and
template for display. That is presentation logic for a search page; our consumer is an
attribution pipeline and a table.

## 2. Typed failures and per-source suspension — from SearXNG

**The technique.** SearXNG raises a distinct exception per failure class —
`SearxEngineCaptchaException`, `SearxEngineTooManyRequestsException`,
`SearxEngineAccessDeniedException` — each carrying its own `suspended_time`, so a CAPTCHA
sidelines a source for hours while a timeout does not. Suspension state and per-source error
rates are then surfaced to the operator.

**Why we needed it.** We had one cooldown constant, `_COOLDOWN_S = 180`, applied to every
failure of every source. So a source that had refused us for a day was retried every three
minutes, burning the run's deadline, while a source that had merely been slow once was
sidelined for the same three minutes as one that had banned us.

**What we implemented — and this row previously overstated it.** Only the distinction that
was actually costing us anything: **empty is not a failure.** A narrow query legitimately
matches nothing, and reporting that as a broken source is how a working tier comes to look
broken — and worse, makes a genuinely broken source indistinguishable from a quiet one. So
`onsite_one` returns `None` for a failed endpoint and `[]` for "this publisher has nothing",
and only the first reaches `sources_failed`. `bing_news` already made the same distinction.

The per-class suspension window is **not** implemented: `sources.py` still has one
`_COOLDOWN_S = 180` applied to every failure of every source, and an earlier version of this
file claimed otherwise. The one case with real evidence behind it is GDELT, whose penalty
window outlasts a run — but we have not measured how long it actually is, and inventing a
number per failure class for three sources would be taxonomy for its own sake. Moved to
[17-remaining-work.md](./17-remaining-work.md), where an unimplemented idea belongs.

## 3. The engine waterfall and the per-host verdict — from Firecrawl

**The technique.** Firecrawl declares each scraping engine with the features it supports
(`fetch`, `tlsclient`, `playwright`, `pdf`, `docx`, …), builds a fallback list sorted by
which engines meet the request's feature requirements, and walks it until one succeeds. Two
refinements sit on top: operators can pin a domain to an engine (`FORCED_ENGINE_DOMAINS`,
`{"linkedin.com": "playwright"}`), and an experimental service returns a per-hostname
verdict — `TlsClientOk` / `ChromeCdpRequired` / `Uncertain` — so a cheap fetch is skipped
entirely for hosts known to need a browser.

**Why we need it.** Our fetch path is one engine. When a page is a JavaScript shell we get
200 OK, no article text, and a wasted read out of a budget of 48. That is not theoretical:
in the Baghpat test, three MSN URLs carried the correct story and all three came back
"could not be read: no article text found".

**What we implemented now.** The verdict half, because it is cheap and useful before any
browser exists: `research/app/verdict.py` remembers, per registrable domain, whether a
static fetch has ever yielded readable article text. A domain with a run of failures and no
successes is marked `needs_render`, which does two things immediately — it deprioritises
those URLs so the fetch budget goes to pages we can actually read, and it labels them in the
officer's table as *"this publisher requires a browser we do not run"* rather than the
uninformative "no article text found".

**What we did NOT implement, having measured it.** The render engine. This section used to
end by describing a Playwright container as obviously-next work. It was probed properly
before being built, and the case collapsed. The probe: a `python:3.12-slim` image with
`chromium-headless-shell`, run against the exact pages that fail.

| Finding | Measurement |
|---|---|
| The image is four times the service | 1.38 GB against the research engine's 333 MB. It runs at a 384 MB memory limit; launch is 0.08 s and a page costs ~6.3 s with images, media, fonts and stylesheets blocked. So it *works* — that was never the question. |
| **MSN, the entire justification, is not fixed by a browser** | `msn.com` renders HTTP 200 with the page title of an unrelated Polish article and `innerText` of 25 characters: `"More for You"`. Identical with a real Chrome user-agent, nothing blocked, and an 8-second wait. Firecrawl's verdict service pins `msn.com` to a browser; for these URLs a browser does not help either. |
| **LiveLaw is a permission problem, not a rendering problem** | The one endpoint a browser genuinely would have unlocked — 0 article links static, 9 rendered. Then we read its `robots.txt`: `Disallow: /search`, `/search?*`, `/*?q=`, `/xhr/`. LiveLaw has closed its search to automated clients. Rendering it anyway would be a deliberate violation, so the adapter was removed instead. |
| Article extraction never needed it | Across live runs, 48 of 48 fetched pages now yield article text. The static reader is not the bottleneck. |
| The remaining gaps had an API | Search pages that really were JavaScript-only: six of them run **Quintype**, whose own `/api/v1/advanced-search` returns canonical URL, headline and publication timestamp as JSON in ~0.5 s. Better data than a rendered page, at 1/2800th of the image size. See §5. |

`verdict.py` stays, and its docstring is honest about why: it earns its place on budget
ordering and on the officer-facing explanation, neither of which needs a browser. What it
does *not* do any more is imply that a browser is coming.

Revisit this only against a tier that surfaces app-shell pages we are permitted to read and
that expose no API. That is a real condition, not a formality — nothing we currently query
meets it.

## 4. Auditing our own adapters — the method, and what it found

Not borrowed from anyone. It is here because it found more recall than any technique above,
and because the method is reusable whenever an adapter is added.

**The method.** Query every on-site adapter with three *unrelated* subjects and compare the
link sets. A search endpoint that returns substantially the same links for
"Bengaluru cyber fraud arrest", "Vipul Singh Khooni encounter Baghpat" and
"Mysuru land grabbing case chargesheet" is not searching — it is handing us its front page
with HTTP 200. That failure is invisible in normal operation: the adapter reports success,
the links are real articles, and they are simply about nothing you asked for.

**What it found.** Five of twelve adapters were not searching.

| Adapter | Verdict |
|---|---|
| `thehindu` | JS shell. 154 KB of front page, results fetched client-side from an endpoint the served HTML does not reference. Three unrelated queries, same links. **Removed.** |
| `udayavani` | Next.js; results exist only inside an RSC payload, with no `<a href>` to read. **Removed.** |
| `vijaykarnataka` | Returned its section index (`/articlelist/*.cms`). **Removed.** |
| `livelaw` | Refused by `robots.txt`. **Removed.** |
| `indianexpress` | Does server-render results — but behind its own front-page promos in the markup. **Kept, and the extractor fixed.** |

Between them they were injecting up to 80 guaranteed-irrelevant candidates into a run that
can read 48 pages, while reporting themselves as working sources.

**The two fixes.**

1. **Rank search-page links by query-term overlap, not by DOM position**
   (`_links_from_search_html`). A newsroom puts its promos in the markup first and its
   results after them, so "take the first five article-shaped links" returned five promos.
   Ranking, not filtering: a source whose result titles share no word with the query —
   Indian Kanoon returns case citations — keeps every result it found.
2. **Use Quintype's search API where it exists** (`kind: "quintype"`, six adapters). Returns
   the canonical URL, the publisher's headline and `last-published-at`. The date is the real
   prize: an on-site hit used to arrive undated, so it could not be placed on the timeline
   or ranked against fresher coverage. `robots.txt` is honoured for the API too — it is the
   publisher's own endpoint serving their own site, not a dataset published for third
   parties.

**Measured effect**, standard mode, same subject, GDELT rate-limited in both cases:

| | Before | After |
|---|---|---|
| Wall clock | 38.4 s | **22.9 s** |
| Candidates | 123–128 | 130 |
| Pages read | 48 | 48 |
| Readable | ~28 stories, several unreadable | **48 of 48** |
| Correct source | ranked #1, `probable` | ranked #1, `probable` |

**The cost, stated plainly.** Quintype's `advanced-search` ORs the query terms and an
exact-phrase query returns zero results, so a search for "Vipul Singh" also returns Manmohan
Singh. About two-thirds of a run's stories grade `unrelated`. That is consistent with the
brief — recall over precision, every link shown with its band and its reasons — and global
title-match ranking keeps the real matches at the head of the read order. It is still the
strongest argument for the cross-encoder reranker in §5.

## 5. Retrieval technique — from the published literature, not from Perplexity

Perplexity is closed source; there is no code to study and its moat is not code. It is a
continuously-crawled index, rerankers trained on real relevance judgments, and frontier
models. None of those is forkable.

What is available is the standard published technique its class of product is built on, and
two pieces are worth adopting here:

- **Cross-encoder reranking. Now implemented — see §5 below.** Score `(query, candidate)`
  pairs with a cross-encoder rather than ordering by lexical overlap.
- **Chunk-level rather than document-level attribution.** We score up to 60,000 characters
  of a story as one blob. Attributing the specific passage that mentions the subject would
  sharpen both the band and the claim spans.

Chunk-level attribution remains on the remaining-work list. Reranking did not wait for the
labelled set, because its effect turned out to be visible without one: it changed which
sources the summary rests on, on the first subject tried.

## 5. Cross-encoder reranking — implemented

**The decision it makes.** Discovery returns 130-140 candidates; a standard run reads 48.
Reading is what earns an attribution band, so this is the highest-leverage choice in the
pipeline, and it was being made lexically.

**Why lexical could not work.** "Vipul Singh" and "Manmohan Singh" share the query word.
Nothing in title-overlap, tier, recency or rank fusion separates them — fusion knows what
several sources thought was relevant to the *query*, not who the document is *about*. The
search APIs make it worse rather than better: Quintype ORs the terms and has no
exact-phrase mode, so noise arrives by design.

**What we use.** Cohere Rerank v4.0 Pro on Azure AI Foundry. Scored on the five documents
that broke the lexical path:

| Document | Score |
|---|---|
| the real encounter report | **0.907** |
| an unrelated Baghpat shootout detail | 0.379 |
| "Khooni Monday" — a box-office column | 0.127 |
| Justice Vipul Pancholi — a different person | 0.081 |
| Manmohan Singh's funeral | 0.059 |

**Two things that cost real time, recorded so they do not again.**

1. The working route is `{endpoint}/providers/cohere/v2/rerank`. The older
   `/models/v1/rerank` route answers **HTTP 500 for every request body** against a v4
   deployment — identical response for six different schemas — which reads as a payload
   problem and is not one. A model name the catalog knows but has no deployment answers
   `unavailable_model`; one it does not know answers `unknown_model`. That distinction is
   how the deployment was found at all.
2. A candidate with no headline and no snippet gives the model nothing to judge, and it
   still returns a number. Left in, fourteen untitled Indian Kanoon results scored high
   enough to consume a third of the read budget and every one graded `unrelated`. They are
   now held out and given the median score, so they compete on the tier and lexical rank
   we do actually have. The underlying cause was also fixed: those results were untitled
   because the search page links each judgment twice and the furniture link came first.

**Why not GLM-4.7-Flash, which we already run?** A fair question — the engine already pays
for that model to extract claims and write the summary, and using it here would remove a
dependency on an Azure resource this project does not own. So it was measured rather than
argued about: listwise scoring (the RankGPT approach — hand the model a numbered list, ask
for a relevance score per item), four batches of 35, against the same 132 candidates and the
same query.

| | Cohere Rerank v4.0 Pro | GLM-4.7-Flash listwise |
|---|---|---|
| Wall clock | **1.9 s** | 8.8 s |
| Model calls | **1** | 4 of the run's budget of 12 |
| Known-noise items inside the top 20 | **0** | 4 |
| Correct source | #1 | #1 |
| Top-20 agreement between the two | 6 / 20 | |

Both find the right report. The difference is everything else they admit: GLM put "Khooni
Monday" (a box-office column), "Be Khooni in English" (a dictionary entry) and "Khooni
Darwaza" (a Delhi monument) inside the top twenty, and scored an untitled Indian Kanoon
result — no text at all — into fifth place. Those are exactly the reads the reranker exists
to stop wasting. It is also 4.6× slower and spends a third of the run's model budget on a
task that is not generation.

So a cross-encoder, because that is what a cross-encoder is for. The right mitigation for
the ownership risk is for KSP to own the Cohere deployment, not to substitute a weaker
ranker — and if the resource ever disappears, the lexical fallback below is what shipped for
months and still works.

**What the lexical pass still does.** It is the fallback when reranking is unavailable, the
tiebreak between equal scores, and the ordering of what the model gets shown. One rule
outranks the model: a publisher we have learned we cannot read statically still goes last,
because the model scores a headline and cannot predict whether the page will open.

**Measured.** 140 of 140 candidates scored, 48 of 48 pages readable. The officer's summary
went from resting on one source to two independent ones, gaining the subject's village and
his gang affiliation — both of which were in the candidate pool before and never got read.

## 6. Why the general web needs a key, and everything else does not

Recorded because it is the one place this engine pays for access, and that deserves a
justification rather than a config entry.

Every other tier is keyless and public. For general web search — the tier that reaches
forums, complaint boards, blogs and stray PDFs — every keyless route was tested and each
one fails on its own terms:

| Route | Why not |
|---|---|
| Google, Bing web search | `robots.txt` disallows `/search`. Bing's **news** search is a different path with no rule, which is exactly why the feed tier exists. |
| DuckDuckGo | `duckduckgo.com/robots.txt` disallows `/html` and `/lite`. The identical endpoints on `html.duckduckgo.com` ship an empty `robots.txt`; using that loophole against the operator's evident intent is not the standard we applied to Mojeek or Google News. Moot anyway — it answered HTTP 202 to one request and 0 links to the other, so it is blocked for datacenters. |
| Reddit | `robots.txt` is `Disallow: /`; the search API answers 403. |
| Mojeek | `robots.txt` disallows `/search`. Kept behind a flag for a licensed API. |
| Marginalia | Free key, given out on request. Adapter written, unkeyed. |
| SearXNG | Has no index of its own. It scrapes the engines above, which CAPTCHA datacenter ranges — self-hosting relocates the failure rather than fixing it. |
| Gemini's Google Search grounding | Would have worked — Google runs the search and the grounding metadata carries the source URLs, which is all we need. The available key is dead (HTTP 401 on every auth style). A live one reopens this route. |
| **Asking the LLM we already run** | Tested, and it is the most dangerous option on this list. Catalyst's QuickML route rejects a `tools` parameter outright (HTTP 400 `PATTERN_NOT_MATCHED`) — it is a model server, not an agent runtime, so there is no index to attach. Asked for sources regardless, GLM-4.7-Flash returned six citations and **all six 404'd**: it had taken one invented slug and pasted it onto six real newsroom domains. Confident, plausible, entirely fictional. For a police tool that is the worst failure mode available, because it looks exactly like coverage. |

The last row is the reason the model in this engine never supplies a URL. It only ever
summarises text we fetched ourselves, with every claim verified against the stored page.

So the choice was a paid index or no general web at all, and `available()` reports `web:
false` rather than letting a press-only run look like an internet-wide one.

**It is now on**, via Firecrawl `/v2/search`. On the first live query it returned Hindustan
Times, a district news site, X, Instagram, YouTube, a small English local, Bhaskar's
English edition — and a court record (`VIPUL SINGH Vs State`) that no news tier held.

**And switching it on made the engine worse before it made it better.** Worth recording,
because "add a tier, get better coverage" is the intuition and it was wrong:

| | Before the tier | Tier on, unconstrained | After the two fixes |
|---|---|---|---|
| Readable pages | 48 of 48 | **34 of 48** | 45 of 48 |
| Kannada sources read | 12 | **1** | 9 |
| Sources the summary rests on | 2 | **1** | 2 |
| Confident false identifications | 0 | **1** | 0 |

Three distinct failures from one change:

1. **Social and video pages burn reads.** An Instagram reel or a YouTube watch page has no
   article body, so the read returns nothing. They now sort behind everything else in the
   fetch order, next to publishers we have learned we cannot read. They stay in the
   candidate list and in the officer's table — the link is worth having — they just are
   not paid for out of the reading budget first.
2. **Crowding.** At 20 results per query the tier contributed 99 of 228 candidates and
   pushed Kannada on-site results out of the budget entirely. Ten per query: its job is to
   reach places nothing else can, and the top ten do that.
3. **A social profile reached `probable`.** A YouTube channel page titled "From Gaon to
   Ghar Ghar: My journey of social impact" was graded `probable` for a subject who had been
   shot dead by the UP STF — a different Vipul Singh, whose own channel repeats his name
   because it is his. This is the failure mode that motivated §9.

The general lesson: a tier that returns a different KIND of document cannot be added on
the same terms as one that returns the same kind. The budget and the scorer both had
assumptions in them that only news pages satisfied.

---

## 7. Hermes Agent — what it actually is, and what we took

Read because it was described as having a large crawling engine. **It has no crawler.**
Worth recording precisely, because the expectation is a natural one.

Its fetching is delegated to paid vendors (Firecrawl by default, then Tavily, Exa,
Parallel). Its browser automation shells out to an external Node CLI — there is no
Playwright import in the Python at all. Its own hosted service, `managed_tool_gateway.py`,
resolves to `firecrawl-gateway.nousresearch.com`: a billing and auth proxy in front of
Firecrawl for their subscribers, not an index. Of eight search providers exactly one is
keyless, and it works by scraping DuckDuckGo through a community package. Their SearXNG
and DuckDuckGo "skills" are a 22-line and a 28-line bash script.

Verified rather than assumed, by grep across the whole subsystem: **zero** occurrences of
`robots`, `crawl-delay`, `page.route`, `abort(`, `networkidle`, `domcontentloaded` or
`resource_type`. No robots handling, no rate limiting, no per-host concurrency, no
backoff, no 429 handling, no resource blocking, no wait strategy, no article extraction,
no PDF. The 8,088 lines of browser code are roughly 600 on resolving five backends, 500 on
one alternative engine's fallback, 450 on orphan-process reaping, 700 on SSRF guards. Real
browser driving is a few hundred lines.

Two findings from it are load-bearing for this engine.

**It reinforces the render-tier rejection from a new direction.** A well-funded agent
framework took browser automation seriously across five backends and still has no resource
blocking and no wait strategy, because for interactive control neither matters. Its browser
produces an accessibility tree for clicking things, not article text. Their bot-detection
posture is also ours, reached independently: match a handful of substrings in the page title
(`captcha`, `just a moment`, `cloudflare`), report it, and accept that some sites are
unavoidable. No CAPTCHA solving, no fingerprint patching in their own code.

**Its SSRF work is better than ours was, in three specific ways** — all now fixed in
`net.py`, all now tested:

| Their technique | What it fixed here |
|---|---|
| Validate the ADDRESSES DNS RESOLVES TO, never the input literal | We already did this. It is why obfuscated forms like `2130706433` and `0177.0.0.1` were never a hole. |
| Explicitly enumerate `::ffff:` duplicates AND unwrap `ipv4_mapped` | Real gap. Python treats `::ffff:169.254.169.254` as a distinct object from the bare IPv4, so neither `is_private` nor our metadata set matched it — the cloud metadata endpoint was reachable by spelling it differently. |
| Block RFC 6598 CGNAT `100.64.0.0/10` explicitly | Real gap. Python reports that range as neither private nor global, so every `is_private` check missed it, and it is where Tailscale, WireGuard and carrier NAT live. |
| A metadata floor evaluated before any config toggle | Adopted, and widened: ECS task metadata at `169.254.170.2` hands out task IAM credentials, plus the Azure wire server and AWS IPv6 metadata. `metadata.google.internal` is refused on the NAME before DNS, because resolving it first means trusting the resolver to agree with us. |

**And their 429 discipline, which fixed a bug of ours.** Their `_http.py` raises on a 429
immediately and never retries, with the reasoning stated: asking again when the upstream
says you are over quota only wastes time. Ours guessed a flat 180-second cooldown, so each
run re-asked GDELT while the previous penalty was still open and earned a longer one —
which is why GDELT was reported as failed in every run of a whole testing session. Now
`Retry-After` is parsed (seconds or HTTP-date, clamped), the window is recorded per host and
outlives the run, and it is checked before every request and on every redirect hop.

**What we did not take, and why.** Their provider plugin layer duplicates its selection
logic in two files with divergent preference orders and a `plugin.yaml` capability field
that nothing parses. Their default extract path is sequential — five URLs at a 60-second
timeout each, verified on `main`. Their search schema has no date field at all, so
publication dates from Brave, Tavily and Exa are discarded; copying that would have broken
our timeline. They have no runtime fallback between providers, which with nine tiers would
be fatal for us. And their content store has no TTL, size cap or eviction, which we cannot
have because we persist nothing.

**A source list we investigated and rejected.** Their `osint-investigation` skill ships 16
stdlib-only keyless fetchers, and three looked directly applicable to financial-crime work:
OFAC SDN, ICIJ Offshore Leaks, OpenCorporates. Reading the endpoints killed all three for a
real-time engine. ICIJ is a 69.7 MB bulk ZIP. OFAC is three bulk CSVs behind expiring
signed S3 redirects, not a query API. OpenCorporates needs a token, with HTML scraping as
the alternative. All three want a periodic download and a persistent index, which is the
one thing this engine deliberately does not have. Worth revisiting only if the no-datastore
constraint ever changes.

The lesson from reading it twice over: what looks like an engine is often an integration,
and the endpoint is the only thing that tells you which. Two recommendations in this study
were reversed by fetching the endpoint rather than reading the file list.

## 8. Following leads — deep mode's second round

`Budget.max_rounds` was 2 for `deep`, documented as "follows leads discovered in round 1",
and referenced by nothing outside test fixtures. `deep` was `standard` with a bigger fetch
budget. What it does now, and the three constraints that are enforced in code rather than
trusted to the prompt — each because of something a live run did:

- **Anchored.** A lead must name the subject. The documents we read also name the
  investigating officer, the victim, and whoever was quoted; a follow-up on any of them
  spends the remaining budget researching the wrong person.
- **Additive.** A lead must contribute a term we did not already hold. The first live deep
  run returned six leads and every one was a rephrasing of the original query
  ("…Baghpat encounter details", "…police encounter details Baghpat"). They cost 110 extra
  fetches and produced no new attributable source. A round that only rephrases is worse than
  no round, because it looks like work.
- **Budgeted.** Round one takes 70% of `max_fetch` in a multi-round mode. This is why
  `max_rounds` could never have worked: round one read all 120 pages and left round two with
  zero. 70 rather than 50 because round one is what finds the leads, so it must still be a
  full-strength search on its own.

Round two skips GDELT — its penalty window outlives the run and round one has already spent
what this run can afford. Everything after discovery is unchanged: new documents join the
same clustering and grading, and everything is re-graded together, because a second-round
report may be the third outlet on a first-round story and corroboration is counted per story.

After the fixes: 72 s, 241 candidates against 133, 119 of 120 pages readable, Kannada
sources 18 → 28, and the leads were *Sushil Moonch gang*, *Bhabhisa village Shamli*,
*UP STF Meerut*, *50,000 reward*.

## 9. Measuring whether the answer is right

Not a technique from anywhere. It is here because it is the only part of this engine that
checks the thing the engine is actually for, and because two of the entries above were
written on the strength of eyeballing live runs — which is exactly the habit this replaces.

**The distinction.** Every other suite asks *does the code do what it says*. This asks *is
the answer right*. A pipeline can be perfectly wired and confidently identify the wrong
person, and only the second question catches that.

**`app/eval_attribution.py`.** Seventeen documents across four subjects. Every one is a
document this engine actually retrieved during live testing, kept with its real title and a
faithful excerpt, labelled by hand. The namesake traps are the ones that fooled earlier
versions — that is why they are in there, and none of them were softened.

Three rates, two of them hard gates at zero:

| Rate | Meaning | Gate |
|---|---|---|
| **false confirm** | somebody else's document graded `probable` or better | 0, hard |
| **wrongly dismissed** | our document graded `unrelated` or `different_person` | 0, hard |
| **confident recall** | our document graded `probable` or better | 50%, soft |

The asymmetry is deliberate and it is the whole design. A false confirm is *asserted* to
an officer. A dismissal makes a real source *vanish* from the reasoning. Those are gated
at zero. Confident recall is reported and floored loosely, because a report that says
"Vipul, alias Khooni" and never the full name genuinely is weaker evidence — grading it
`possible` is the correct answer, and it still reaches the officer's table with its
reasons. A high recall floor would tune the engine towards over-confidence, which is the
one thing it exists not to do.

**It earned its place immediately by finding two false confirms**, both reproduced from
live runs, both now fixed and both permanently guarded:

- A story made only of social, forum and unvouched pages could reach `probable`. A profile
  page carries a name repeatedly *because it belongs to the account holder*, so the
  multi-name signal that makes a news report convincing fires just as hard on a namesake's
  own account. Now capped at `possible` unless a newsroom or authoritative document appears
  somewhere in the cluster — then the identification rests on the report and the profile
  merely corroborates.
- In the topic scorer, the keystone term alone could carry a confident band. "Sushil Moonch
  gang" graded *"Supreme Court cancels Olympian Sushil Kumar's bail"* as `probable`:
  keystone in the headline, four points plus two, nothing else needed. A multi-word subject
  now requires more than its rarest single word — the same rule the person scorer already
  applied to names.

**Current: 0 of 11 false confirms, 0 of 6 dismissals, 4 of 5 confident.** The hardest case
in the set passes — a namesake sharing both the name *and* the district, where only the
station and the crime number can carry the refusal.

**What it is not.** Seventeen documents is a regression harness, not a field validation. It
cannot give the false-confirm rate on the real distribution of KSP casework, because that
distribution is not in it. Growing it with real case files — especially same-district
namesakes — is the highest-value work left, and only KSP can do it. Every case added is
permanent.

## What none of them do, and why we still exist

Worth stating plainly, because it is the reason this engine is not just a worse Firecrawl.
None of the three will tell an officer whether a document is about **their** Suresh Kumar.
That requires anchors from the case file, a confidence band with a stated reason, a ceiling
on what a bare name may conclude, span verification against the stored page text, and
governance in front of the pipeline. Those are in
[16-research-engine.md](./16-research-engine.md), they are the product, and no amount of
crawler quality substitutes for them.
