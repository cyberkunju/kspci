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
| [Firecrawl](https://github.com/firecrawl/firecrawl) | AGPL-3.0 (SDKs MIT) | engine waterfall with capability flags; per-host "will a cheap fetch work" verdict; per-domain engine pinning | any code; their Node/Redis/worker/proxy infrastructure |
| [SearXNG](https://github.com/searxng/searxng) | AGPL-3.0 | weighted reciprocal-rank fusion across sources; typed failure classes driving per-source suspension; duplicate merging that keeps the best fields | any code; its scraped-SERP discovery model |
| Perplexity | closed | published/standard retrieval technique only — see below | nothing else exists to take |

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

**What we implemented.** A `Failure` classification in `research/app/sources.py` with a
per-class suspension window, recorded per source and reported in `sources_failed` with the
reason and the remaining window. The distinction that matters for us: **rate-limited**
(back off long — GDELT's penalty window outlasts a run), **blocked** (back off much longer,
retrying is what earns a permanent ban), **transport** (back off briefly; it was probably
us), and **empty** (not a failure at all — a narrow query legitimately matches nothing, and
reporting that as a broken source is how a working tier comes to look broken).

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

**What is still to come.** The render engine itself: one Playwright container, navigate,
wait for network idle, return HTML into the trafilatura we already run. Apache-2.0 all the
way through, and a few hundred lines — we fetch 48 URLs per run, not 48,000, so none of
Firecrawl's queueing, worker pool or proxy tiering is warranted. Tracked in
[17-remaining-work.md](./17-remaining-work.md).

## 4. Retrieval technique — from the published literature, not from Perplexity

Perplexity is closed source; there is no code to study and its moat is not code. It is a
continuously-crawled index, rerankers trained on real relevance judgments, and frontier
models. None of those is forkable.

What is available is the standard published technique its class of product is built on, and
two pieces are worth adopting here:

- **Cross-encoder reranking.** Score `(query, passage)` pairs with a small reranker rather
  than ordering by lexical overlap. This is the correct long-term fix for choosing which 48
  of 128 candidates to read; rank fusion above is the cheap approximation that needs no
  model and no GPU.
- **Chunk-level rather than document-level attribution.** We score up to 60,000 characters
  of a story as one blob. Attributing the specific passage that mentions the subject would
  sharpen both the band and the claim spans.

Both are on the remaining-work list rather than implemented, and honestly so: neither can be
shown to help until there is a labelled evaluation set to measure against.

---

## What none of them do, and why we still exist

Worth stating plainly, because it is the reason this engine is not just a worse Firecrawl.
None of the three will tell an officer whether a document is about **their** Suresh Kumar.
That requires anchors from the case file, a confidence band with a stated reason, a ceiling
on what a bare name may conclude, span verification against the stored page text, and
governance in front of the pipeline. Those are in
[16-research-engine.md](./16-research-engine.md), they are the product, and no amount of
crawler quality substitutes for them.
