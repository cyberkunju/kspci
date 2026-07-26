"""The run: plan, discover, fetch, cluster, attribute, claim, summarise.

Two properties govern the whole file.

THE DEADLINE IS REAL. Every stage checks it and the run returns what it has when the
budget expires, labelled partial, with the stages it never reached named. A research
tool that hangs is worse than one that says "here are 31 sources, I ran out of time
before reading the last 12" — the officer can act on the second and can only wait on
the first.

DEGRADATION IS THE NORMAL CASE, NOT THE ERROR PATH. Nine sources means something is
always having a bad day, and the model may be unreachable. Each stage is written so its
absence costs precisely one capability: no model means no summary but a full attributed
source list; no GDELT means less breadth, named in the report. Nothing cascades.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Awaitable, Callable

from . import claims as claims_mod
from . import attribute, cluster, llm, rerank, sources
from .config import Budget, settings
from .extract import extract
from .governance import DISCLAIMER
from .models import ATTRIBUTION_RANK, Anchors, Document, Finding, Hit, Story, Tier
from .net import Fetcher, canonical_url, host_of, registrable
from .fuse import fuse
from .plan import GdeltPlan, Query, plan_queries, resolve_names
from .verdict import render_notice, verdicts
from .tiers import tier_for

Progress = Callable[[str, str, dict], Awaitable[None] | None]


@dataclass
class RunResult:
    subject: str
    kind: str
    mode: str
    partial: bool = False
    stages: list[str] = field(default_factory=list)
    summary: str = ""
    #: "findings" when the summary rests on cited claims about the subject, "no_match"
    #: when nothing could be attributed and the text describes what was found instead.
    #: The UI must not present the second as though it were the first.
    summary_kind: str = "findings"
    #: What OUR OWN records say about this subject, supplied by the caller from the KSP
    #: Data Store. Carried through and shown, because a report that quietly blends
    #: internal records with open-source material is unusable as either — and because a
    #: subject we hold nothing on is itself worth stating.
    records: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    findings: list[Finding] = field(default_factory=list)
    claims: list[dict] = field(default_factory=list)
    timeline: list[dict] = field(default_factory=list)
    counts: dict = field(default_factory=dict)
    queries: list[dict] = field(default_factory=list)
    sources_used: dict = field(default_factory=dict)
    sources_failed: list[str] = field(default_factory=list)
    namesakes: list[dict] = field(default_factory=list)
    disclaimer: str = DISCLAIMER
    elapsed_s: float = 0.0


class Deadline:
    def __init__(self, seconds: float) -> None:
        self.start = time.monotonic()
        self.limit = float(seconds)

    @property
    def remaining(self) -> float:
        return max(0.0, self.limit - (time.monotonic() - self.start))

    @property
    def expired(self) -> bool:
        return self.remaining <= 0.05

    def slice(self, want: float) -> float:
        """Never let one stage ask for more time than the run has left."""
        return max(0.5, min(float(want), self.remaining))


async def _emit(progress: Progress | None, stage: str, message: str, **data) -> None:
    if progress is None:
        return
    try:
        r = progress(stage, message, data)
        if asyncio.iscoroutine(r):
            await r
    except Exception:  # noqa: BLE001 — progress reporting must never break a run
        pass


# ── discovery ───────────────────────────────────────────────────────────────────

async def _discover(f: Fetcher, queries: list[Query], gdelt_plan: GdeltPlan,
                    budget: Budget, dl: Deadline,
                    progress: Progress | None) -> tuple[list[Hit], list[str], dict, list[str]]:
    """Run every query against its routes, concurrently, and merge.

    GDELT is handled apart from the rest because it is rate-limited to one call every
    five seconds: it gets one rich query rather than a share of the narrow ones. That
    is also simply the better way to use it — one call can return 250 records.
    """
    hits: list[Hit] = []
    failed: list[str] = []
    used: dict[str, int] = {}
    # Structural gaps in coverage, as opposed to sources that failed. A tier that cannot
    # reach the period is not a failure — it is a limit, and the officer needs to know
    # the difference before reading a thin result as an absence.
    notes: list[str] = [gdelt_plan.out_of_range] if gdelt_plan.out_of_range else []

    async def gdelt_leg() -> list[Hit]:
        """The bare subject first, then anchored and alias variants.

        Sequential on purpose: GDELT's own rate limiter serialises these anyway, and the
        BARE query must go first so that if the budget runs out we have spent the call
        that cannot filter anything out. Sending only the anchored query was a real
        recall bug — `any_of` is ANDed, so an unanchored subject got "must contain one of
        five event words" and lost the one article GDELT held.
        """
        queries = [sources.gdelt_query(gdelt_plan.must)]
        if gdelt_plan.any_of:
            queries.append(sources.gdelt_query(gdelt_plan.must, gdelt_plan.any_of))
        for a in gdelt_plan.aliases:
            queries.append(sources.gdelt_query([a]))

        out: list[Hit] = []
        for q in queries:
            if dl.remaining < 8:
                break
            got = await sources.gdelt(f, q, limit=min(budget.max_hits, 250),
                                      timespan=gdelt_plan.timespan,
                                      start=gdelt_plan.start, end=gdelt_plan.end)
            out.extend(got)
            if "gdelt" in sources.STATUS:
                break  # rate-limited or refused; further legs would only burn the clock
        if not out and "gdelt" in sources.STATUS:
            failed.append(f"gdelt ({sources.STATUS['gdelt']})")
        return out

    async def news_leg(text: str) -> list[Hit]:
        got = await sources.bing_news_all(f, text)
        if not got and "bingnews" in sources.STATUS:
            note = f"bingnews ({sources.STATUS['bingnews']})"
            if note not in failed:
                failed.append(note)
        return got

    async def web_leg(text: str) -> list[Hit]:
        got = await sources.web_search(f, text)
        if not got and "web" in sources.STATUS:
            note = f"web ({sources.STATUS['web']})"
            if note not in failed:
                failed.append(note)
        return got

    async def onsite_leg(text: str) -> list[Hit]:
        got, fails = await sources.onsite(f, text, limit_per_site=5)
        # A site that fails for four queries failed once, as far as the officer is
        # concerned. Repeating it four times in the report buries the other failures.
        for name in fails:
            if name not in failed:
                failed.append(name)
        return got

    legs: list[Awaitable[list[Hit]]] = []
    # Order matters from here on: each leg's own ranking is the signal rank fusion reads,
    # so legs are kept as separate ordered lists rather than concatenated.
    if "gdelt" in {r for q in queries for r in q.routes} or True:
        legs.append(gdelt_leg())

    # On-site search is the most reliable tier, so it gets the strongest queries. It is
    # also the slowest per call (eleven sites), so it is capped rather than run for
    # every spelling variant.
    for q in queries[:4]:
        if "onsite" in q.routes:
            legs.append(onsite_leg(q.text.replace('"', "")))

    # The news-feed tier carries the breadth: it reaches outlets in languages and
    # regions the on-site registry does not cover at all. Given the strongest queries,
    # because it is one cheap request each.
    for q in queries[:5]:
        legs.append(news_leg(q.text))
    # The general web, when a key is configured. Given the strongest queries and its own
    # leg so rank fusion can see where a forum thread placed against the news tiers. This
    # is the only tier that reaches discussion boards, blogs and complaint sites, so it is
    # not treated as long-tail breadth like metasearch below.
    if settings.serper_key:
        for q in queries[:5]:
            legs.append(web_leg(q.text.replace('"', "")))

    for q in queries[:budget.max_queries]:
        if "searxng" in q.routes and settings.searxng_url:
            legs.append(sources.searxng(f, q.text))
        if "marginalia" in q.routes and settings.marginalia_key:
            legs.append(sources.marginalia(f, q.text))
        if "wikipedia" in q.routes:
            legs.append(sources.wikipedia(f, q.text.replace('"', "")))

    # Hindi and Kannada Wikipedia for the two strongest queries only. Cheap, and it is the
    # one reference tier that can confirm or rule out a person whose notability exists only
    # in a vernacular encyclopaedia — which for regional political and criminal figures is
    # common. Capped at two queries because it is context, not coverage.
    for q in queries[:2]:
        for lang in ("hi", "kn"):
            legs.append(sources.wikipedia(f, q.text.replace('"', ""), limit=3, lang=lang))

    await _emit(progress, "discover", f"querying {len(legs)} source legs", legs=len(legs))
    try:
        results = await asyncio.wait_for(
            asyncio.gather(*legs, return_exceptions=True),
            timeout=dl.slice(dl.remaining * 0.55))
    except asyncio.TimeoutError:
        failed.append("discovery timed out before every source answered")
        results = []

    # Canonicalise before fusing, so the same article from three tiers is one URL and
    # therefore one fused hit with three contributing sources.
    ordered_legs: list[list[Hit]] = []
    for res in results:
        if isinstance(res, BaseException) or not res:
            continue
        leg: list[Hit] = []
        for h in res:
            used[h.via] = used.get(h.via, 0) + 1
            u = canonical_url(h.url)
            if not u:
                continue
            h.url = u
            if h.tier == Tier.UNKNOWN:
                h.tier = tier_for(u)
            leg.append(h)
        if leg:
            ordered_legs.append(leg)

    # A source that contributed hits is not a failed source, however many of the run's
    # individual queries came back empty for it. On-site search is run once per query, so
    # one narrow phrasing returning nothing used to put the source in `sources_failed` —
    # and a report reading "onsite:theprint failed" while ThePrint supplied the very
    # article the summary rests on is worse than saying nothing at all.
    contributed = {name for name, n in used.items() if n}
    failed = [f for f in failed if f.split(" (")[0] not in contributed]

    # Weighted reciprocal-rank fusion, rather than keeping whichever copy arrived first.
    # Agreement between independent tiers is the strongest relevance signal available
    # before a single page is fetched, and it used to be computed and thrown away.
    hits = fuse(ordered_legs)
    return hits[:budget.max_hits], failed, used, notes


def _prefilter(hits: list[Hit], terms: list[str]) -> list[Hit]:
    """Order hits by apparent relevance before spending the fetch budget.

    This exists because of how site search actually behaves: asked for something it has
    no match for, a newsroom's search page returns its LATEST articles rather than
    nothing. Fetch in discovery order and thirty reads get spent on today's front page
    while a genuine match sits unread at position forty.

    Four signals, in order of how much they are worth:

      1. A subject term in the TITLE. Still the strongest single cue about this specific
         subject, which is why it stays first — rank fusion knows what several sources
         thought was relevant to the query, not who the document is about.
      2. A subject term in the snippet.
      3. Whether we can read this publisher at all. A domain that has failed repeatedly
         and never once yielded article text goes last regardless: spending a read on a
         page we know renders empty is spending it on nothing. See verdict.py.
      4. The fused score — how many sources found it and how highly they ranked it.

    Nothing is discarded. This is ordering, not filtering; a title is weak evidence and
    the decision about relevance belongs to attribution, which has the full text.
    """
    needles = [t for t in terms if len(t) >= 4]

    def rank(h: Hit) -> tuple:  # noqa: F811 — local sort key, see _rank_candidates
        title = (h.title or "").lower()
        snippet = (h.snippet or "").lower()
        if needles and any(n.lower() in title for n in needles):
            relevance = 0          # best
        elif needles and any(n.lower() in snippet for n in needles):
            relevance = 1
        elif not title:
            relevance = 2          # unknown beats known-mismatch
        else:
            relevance = 3
        unreadable = 1 if verdicts.needs_render(h.url) else 0
        fused = float(h.extra.get("fused_score") or 0.0)
        return (relevance, unreadable, -fused, int(h.tier), h.published or "")

    return sorted(hits, key=rank)


def _rerank_query(subject: str, anchors: Anchors, question: str) -> str:
    """One sentence describing what we are looking for, for the cross-encoder.

    Deliberately richer than the search queries. A search engine needs terms that match
    documents; a cross-encoder needs to know WHO the subject is, because that is what
    lets it score a namesake low. So the aliases and the place go in, and so does the
    officer's own question when they asked one — it carries intent that the subject line
    does not.
    """
    parts = [subject]
    parts += [n for n in anchors.names if n and n.lower() != subject.lower()]
    place = ", ".join(x for x in (anchors.district, anchors.state) if x)
    if place:
        parts.append(f"in {place}")
    text = " ".join(parts)
    q = " ".join((question or "").split())
    return f"{text}. {q}"[:1000] if q else text[:1000]


async def _rank_candidates(hits: list[Hit], terms: list[str], *, subject: str,
                           anchors: Anchors, question: str, dl: Deadline,
                           progress: Progress | None) -> tuple[list[Hit], str]:
    """Decide the read order: lexical first, then a cross-encoder over the top of it.

    The lexical pass still runs and still matters. It is the fallback when reranking is
    unavailable, it breaks ties between candidates the model scores equally, and it puts
    the candidates the model sees in a sensible order in case the list has to be
    truncated. What the model changes is the decision that lexical ordering gets wrong:
    whether a document is about THIS person.

    One rule survives the model: a publisher we have learned we cannot read statically
    still goes last, however relevant the model thinks it is. A read spent on a page that
    renders empty is a read spent on nothing, and the model is scoring a headline, not
    predicting whether we can open the page.
    """
    ordered = _prefilter(hits, terms)
    if not rerank.available() or len(ordered) < 2 or dl.remaining < 6:
        return ordered, ""

    subset = ordered[:rerank.MAX_DOCUMENTS]
    docs = [rerank.document_text(h.title, h.snippet,
                                 registrable(host_of(h.url)), h.published)
            for h in subset]
    # A candidate with no headline and no snippet gives the cross-encoder nothing to judge,
    # and it will still return a number — an arbitrary one. Left in, fourteen untitled
    # court results scored high enough to consume a third of the read budget and all
    # graded unrelated. They are held out and given the median score instead, so they
    # compete on the tier and lexical rank we do have rather than on a guess.
    judgeable = [i for i, d in enumerate(docs) if len(d.strip(" .[]")) > 12]
    if not judgeable:
        return ordered, ""
    got = await rerank.scores(_rerank_query(subject, anchors, question),
                              [docs[i] for i in judgeable],
                              timeout_s=min(20.0, max(4.0, dl.remaining * 0.25)))
    if not got:
        return ordered, (f"candidate reranking was unavailable "
                         f"({rerank.LAST_ERROR.get('reason', 'no scores returned')}); "
                         "the read order is lexical")

    for i, s in zip(judgeable, got):
        subset[i].extra["rerank_score"] = round(s, 4)
    neutral = sorted(got)[len(got) // 2] if got else 0.0
    baseline = {id(h): i for i, h in enumerate(ordered)}

    def key(h: Hit) -> tuple:
        unreadable = 1 if verdicts.needs_render(h.url) else 0
        score = h.extra.get("rerank_score")
        return (unreadable, -float(neutral if score is None else score),
                baseline.get(id(h), 0))

    ranked = sorted(ordered, key=key)
    await _emit(progress, "rank", f"{len(got)} candidates scored by cross-encoder",
                scored=len(got))
    return ranked, ""


# ── retrieval ───────────────────────────────────────────────────────────────────

async def _retrieve(f: Fetcher, hits: list[Hit], budget: Budget, dl: Deadline,
                    progress: Progress | None) -> list[Document]:
    """Fetch and extract, bounded by concurrency and by the deadline."""
    targets = hits[:budget.max_fetch]
    sem = asyncio.Semaphore(budget.fetch_concurrency)
    done = 0
    total = len(targets)

    async def one(h: Hit) -> Document:
        nonlocal done
        async with sem:
            if dl.expired:
                return Document(url=h.url, tier=h.tier, via=[h.via],
                                error="skipped: run deadline reached")
            r = await f.get(h.url, timeout_s=int(dl.slice(settings.fetch_timeout_s)))
            # `via` is comma-joined after fusion — one hit can have been found by four
            # tiers — so it is split back into the list the report counts.
            doc = extract(url=h.url, final_url=r["final_url"], content=r["content"],
                          content_type=r["content_type"], tier=h.tier, status=r["status"],
                          via=[v for v in (h.via or "").split(",") if v], error=r["error"])
            if not doc.title and h.title:
                doc.title = h.title
            if not doc.published and h.published:
                doc.published = h.published
            if not doc.language and h.language:
                doc.language = h.language
            # Remember whether this publisher can be read statically at all. Only counted
            # when the fetch itself succeeded: a 404 or a timeout says nothing about
            # whether the page needs a browser.
            if r["status"] == 200 and not r["error"]:
                verdicts.record(doc.final_url or doc.url, readable=bool(doc.text))
                if not doc.text and verdicts.needs_render(doc.url):
                    doc.error = render_notice(doc.url)
            done += 1
            if done % 5 == 0 or done == total:
                await _emit(progress, "retrieve", f"read {done} of {total}",
                            done=done, total=total)
            return doc

    try:
        docs = await asyncio.wait_for(asyncio.gather(*[one(h) for h in targets]),
                                     timeout=dl.slice(dl.remaining * 0.8))
    except asyncio.TimeoutError:
        docs = []
    return [d for d in docs if isinstance(d, Document)]


# ── the run ─────────────────────────────────────────────────────────────────────

async def run(*, subject: str, kind: str, anchors: Anchors, budget: Budget,
              question: str = "", records: list[str] | None = None,
              progress: Progress | None = None) -> RunResult:
    dl = Deadline(budget.wall_s)
    records = [r for r in (records or []) if str(r).strip()][:20]
    out = RunResult(subject=subject, kind=kind, mode=budget.name, records=records)
    f = Fetcher()

    try:
        # 1. PLAN
        # Aliases are separated here, once, so the planner and the attribution stage are
        # looking for the same set of names. Doing it only in the planner meant the
        # scorer hunted for the literal string "Vipul Singh alias Khooni".
        resolved = resolve_names(subject, kind, anchors)
        if resolved:
            anchors.names = resolved

        queries, gdelt_plan = plan_queries(subject=subject, kind=kind, anchors=anchors,
                                           max_queries=budget.max_queries)
        out.queries = [{"text": q.text, "purpose": q.purpose, "pins": list(q.pins)}
                       for q in queries]
        out.stages.append("plan")
        await _emit(progress, "plan", f"{len(queries)} queries planned",
                    queries=len(queries))

        # Namesake count, in parallel with nothing else — it is one cheap call and it
        # caps what attribution is allowed to conclude.
        namesakes: list[dict] = []
        if kind == "person":
            namesakes = await sources.wikidata_candidates(f, subject)
            out.namesakes = namesakes

        # 2. DISCOVER
        hits, failed, used, notes = await _discover(f, queries, gdelt_plan, budget,
                                                    dl, progress)
        out.sources_used = used
        out.sources_failed = failed
        out.warnings.extend(notes)
        out.stages.append("discover")
        await _emit(progress, "discover", f"{len(hits)} candidate sources", hits=len(hits))
        if dl.expired:
            out.partial = True

        # 3. RETRIEVE — most plausibly relevant first, so a real match is never the
        # source that went unread because a site returned its front page.
        terms = [subject] + [w for w in subject.split() if len(w) >= 5] + anchors.names
        docs, reranked = [], 0
        if hits:
            ordered, rank_warning = await _rank_candidates(
                hits, terms, subject=subject, anchors=anchors, question=question,
                dl=dl, progress=progress)
            if rank_warning:
                out.warnings.append(rank_warning)
            reranked = sum(1 for h in ordered if h.extra.get("rerank_score") is not None)
            docs = await _retrieve(f, ordered, budget, dl, progress)
        out.stages.append("retrieve")
        readable = [d for d in docs if d.ok]
        await _emit(progress, "retrieve", f"{len(readable)} of {len(docs)} readable",
                    readable=len(readable), fetched=len(docs))

        # 4. CLUSTER
        stories = cluster.cluster(docs)
        out.stages.append("cluster")

        # 5. ATTRIBUTE
        stories = attribute.apply(stories, anchors, subject=subject,
                                  namesakes=len(namesakes), kind=kind)
        out.stages.append("attribute")
        await _emit(progress, "attribute", f"{len(stories)} stories graded",
                    stories=len(stories),
                    confirmed=sum(1 for s in stories if s.attribution == "confirmed"))

        # The source list is built now, BEFORE any model work. It is the part the
        # officer can act on, so it must exist even if everything after this fails.
        out.findings = _findings(stories, docs)
        out.counts = _counts(stories, docs, hits)
        out.counts["reranked"] = reranked

        # 6-7. CLAIMS AND SUMMARY — the optional half.
        admitted, refused = claims_mod.admitted(stories)
        # Only the SURPRISING refusals are warnings. On a typical run most stories are
        # simply not about the subject, and listing each one as "not summarised:
        # attribution is unrelated" produced fifteen lines of noise that buried the one
        # warning the officer needed — that GDELT was rate-limited and coverage was
        # therefore thinner than it looks. An unrelated story is already in the source
        # table with its band and its reasons; it needs no second mention.
        withheld_but_relevant = {
            sid: why for sid, why in refused.items() if "unrelated" not in why
        }
        for sid, why in list(withheld_but_relevant.items())[:6]:
            out.warnings.append(f"{sid} not summarised: {why}")
        if len(withheld_but_relevant) > 6:
            out.warnings.append(
                f"and {len(withheld_but_relevant) - 6} further stories were attributed to "
                "this subject but did not meet the bar for summarising")

        if not llm.available():
            out.warnings.append(
                "no model is configured, so there is no summary — every source below is "
                "still retrieved, graded and citable")
        elif not admitted:
            # Nothing could be tied to the subject. Say what WAS found and who it was
            # about, rather than returning an empty summary an officer cannot read the
            # meaning of.
            out.warnings.append(
                "no retrieved source could be attributed to this subject; the note below "
                "describes what was found instead")
            text, warns = await claims_mod.synthesise_coverage(
                stories, subject=subject, anchors=anchors, records=records,
                aliases=[n for n in anchors.names if n.lower() != subject.lower()])
            out.summary = text
            out.summary_kind = "no_match"
            out.warnings.extend(warns)
            out.stages.append("summary")
        elif dl.expired:
            out.partial = True
            out.warnings.append("deadline reached before the summary stage")
        else:
            # Summarise the strong matches when there are any, and fall back to the weak
            # ones only when there is nothing better. Admission is generous on purpose —
            # every retrieved source reaches the officer's table — but a summary that
            # mixes the report which named the subject and his alias together with three
            # columns that merely share a word is worse than either alone.
            strong = [s for s in admitted
                      if ATTRIBUTION_RANK[s.attribution] >= ATTRIBUTION_RANK["probable"]]
            picked = (strong or admitted)[:min(9, budget.llm_calls)]
            if strong and len(strong) < len(admitted):
                out.warnings.append(
                    f"the summary rests on the {len(strong)} source(s) attributed at "
                    f"'probable' or better; {len(admitted) - len(strong)} weaker match(es) "
                    "are listed below but not summarised")
            all_claims: list = []
            try:
                all_claims = await asyncio.wait_for(
                    claims_mod.extract_all(picked),
                    timeout=dl.slice(dl.remaining * 0.7))
            except asyncio.TimeoutError:
                out.warnings.append("claim extraction timed out; summary uses what arrived")
                out.partial = True
            out.stages.append("claims")

            withheld = [c for c in all_claims if c.excluded]
            for c in withheld[:6]:
                out.warnings.append(c.excluded)
            out.claims = [
                {"text": c.text, "story": c.story_id, "url": c.document_url,
                 "date": c.date, "tier": int(c.tier), "verified": c.verified,
                 "excluded": c.excluded, "span": c.span[:240]}
                for c in all_claims
            ]

            if not dl.expired:
                text, warns = await claims_mod.synthesise(
                    stories, all_claims, subject=subject, question=question,
                    records=records)
                out.summary = text
                out.warnings.extend(warns)
                out.stages.append("summary")

            out.timeline = _timeline(all_claims, stories)

        out.elapsed_s = round(time.monotonic() - dl.start, 2)
        if dl.expired:
            out.partial = True
        return out
    finally:
        await f.close()


# ── reporting ───────────────────────────────────────────────────────────────────

def _findings(stories: list[Story], docs: list[Document]) -> list[Finding]:
    """Every source, whether or not it was summarised.

    Failed fetches are included. A link the engine could not read is still a link the
    officer may want to open, and silently dropping it would misrepresent how much was
    actually found.
    """
    ind = cluster.independence(stories)
    out: list[Finding] = []
    for s in stories:
        d = s.lead
        out.append(Finding(
            url=d.final_url or d.url, title=d.title or d.url, outlet=d.outlet,
            published=d.published, tier=int(d.tier), attribution=s.attribution,
            why=s.attribution_reasons, outlets=s.outlets, language=d.language,
            snippet=(d.text or "")[:280],
            via=sorted({v for x in s.documents for v in x.via}),
            matched=list(s.matched_anchors), outlet_count=ind.get(s.id, 1)))
    for d in docs:
        if d.ok:
            continue
        # A link we could not read is still a link the officer may want to open, so it is
        # listed rather than dropped — and the reason distinguishes "this publisher needs a
        # browser we do not run" from "this page is gone", because only one of those is
        # worth clicking.
        out.append(Finding(
            url=d.final_url or d.url, title=d.title or d.url, outlet=d.outlet,
            published=d.published, tier=int(d.tier), attribution="unrelated",
            why=[f"could not be read: {d.error}"], outlets=[], language="",
            snippet="", via=d.via, error=d.error))
    return out


def _counts(stories: list[Story], docs: list[Document], hits: list[Hit]) -> dict:
    bands: dict[str, int] = {}
    for s in stories:
        bands[s.attribution] = bands.get(s.attribution, 0) + 1
    return {
        "candidates": len(hits),
        "fetched": len(docs),
        "readable": sum(1 for d in docs if d.ok),
        "unreadable": sum(1 for d in docs if not d.ok),
        "stories": len(stories),
        "by_attribution": bands,
        "kannada_sources": sum(1 for d in docs if d.language == "kn"),
        "official_sources": sum(1 for d in docs if int(d.tier) == 1),
    }


def _timeline(all_claims: list, stories: list[Story]) -> list[dict]:
    """Dated, verified claims in order.

    Ordering matters beyond tidiness: an acquittal in 2024 and an arrest in 2021 are
    both true, and presenting them undated and side by side is how a research file
    misleads without containing a single false statement.
    """
    rows = [
        {"date": c.date, "text": c.text, "story": c.story_id, "url": c.document_url}
        for c in all_claims if c.date and not c.excluded
    ]
    rows.sort(key=lambda r: r["date"])
    return rows
