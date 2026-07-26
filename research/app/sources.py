"""Discovery adapters — where results come from.

Grouped by access pattern rather than by vendor, because the pattern is what
determines how each one fails:

  * DATASETS — GDELT, Wikipedia, Wikidata, the Wayback CDX. Published for machines,
    no key, no quota, and reliable from a datacenter. This is the backbone.
  * ONSITE — authoritative publishers and newsrooms queried through their own
    search. For a court or a newsroom this is simply the correct method, and it
    reaches Kannada coverage that no English-first index surfaces.
  * METASEARCH — SearXNG, Mojeek, Marginalia. Breadth for the long tail,
    deliberately last and deliberately optional.

Every adapter returns `list[Hit]` and swallows its own failures. A dead source
contributes nothing and is reported in the run's `sources_failed`; it never takes
the run down. That is not defensive habit — with nine sources, something is always
having a bad day.

A note on why Google is absent. SearXNG has no index of its own; it scrapes Google,
Bing and friends, and those CAPTCHA or block datacenter ranges — SearXNG's own docs
ship a page about answering CAPTCHAs by hand. Building the engine's discovery on
that would work in development and degrade badly in production, so the reliable
tiers carry the weight and metasearch is opportunistic.
"""

from __future__ import annotations

import asyncio
import re
from urllib.parse import quote_plus, urljoin

from lxml import html as lxml_html

from .config import settings
from .models import Hit, Tier
from .net import Fetcher, RateLimiter, canonical_url, host_of, registrable
from .tiers import ONSITE, tier_for

# GDELT is generous but slow; ten seconds is not enough and a truncated call looks
# exactly like an empty result set.
GDELT_TIMEOUT_S = 30

# GDELT asks for one request every five seconds. Exceeding it returns HTTP 429 with a
# plain-text notice, which parses as "no coverage" unless you check — so the spacing
# is enforced here, with headroom.
#
# This shapes how GDELT is used: not fourteen narrow queries, but one or two rich
# ones asking for many records. That is the better way to query it anyway.
_gdelt_limit = RateLimiter(5.5)

#: Why each source last failed, for the run report. Module-level on purpose: a rate
#: limit is a property of our IP, not of one run, so a cooldown discovered by one run
#: must be visible to the next. Diagnostic only — nothing branches on it except the
#: cooldown check below.
STATUS: dict[str, str] = {}

#: Wall-clock instants before which a source should not be called again. GDELT
#: enforces its limit with a penalty window that outlasts a single run, and hammering
#: it while banned wastes the run's deadline to no purpose.
_COOLDOWN: dict[str, float] = {}
_COOLDOWN_S = 180.0


def _cooling(name: str) -> bool:
    import time as _t
    until = _COOLDOWN.get(name, 0.0)
    if until and _t.monotonic() < until:
        return True
    return False


def _cool(name: str, reason: str) -> None:
    import time as _t
    _COOLDOWN[name] = _t.monotonic() + _COOLDOWN_S
    STATUS[name] = reason


# ── datasets ────────────────────────────────────────────────────────────────────

def gdelt_query(must: list[str], any_of: list[str] | None = None) -> str:
    """Build a query GDELT will actually accept.

    GDELT treats spaces as AND and needs explicit quoting for phrases, so an
    intuitive query like `"Bengaluru" (cyber fraud OR cheating case)` silently parses
    as nonsense and returns zero articles — indistinguishable from "no coverage
    exists". Every multi-word term is quoted here so that failure cannot happen.
    """
    def term(t: str) -> str:
        t = " ".join(str(t or "").split())
        if not t:
            return ""
        t = t.replace('"', "")
        return f'"{t}"' if " " in t else t

    parts = [term(m) for m in must if term(m)]
    group = [term(a) for a in (any_of or []) if term(a)]
    if group:
        parts.append("(" + " OR ".join(group) + ")" if len(group) > 1 else group[0])
    return " ".join(parts)


async def gdelt(f: Fetcher, query: str, *, limit: int = 40, timespan: str = "3months",
                country: str = "", start: str = "", end: str = "") -> list[Hit]:
    """GDELT DOC 2.0 — worldwide news, indexed and translated, free and keyless.

    The single most valuable discovery source in this engine. It indexes far more
    outlets than any on-site search reaches, including regional and non-English
    press, and it needs no credential — which is exactly what "no external provider"
    demands.

    Language is read from GDELT's own per-article field rather than guessed, and
    articles are NOT filtered to India: a subject with overseas coverage is still the
    subject, and the officer decides what is relevant.

    One documented limit governs how it is used: the DOC API searches a **rolling
    three-month window**, and `timespan` can only narrow that — a larger value is
    silently clamped. So GDELT is a recency tier, not an archive tier, and a run whose
    case predates the window says so rather than presenting the gap as an absence of
    coverage. See `plan.gdelt_window`.
    """
    if not query.strip():
        return []
    if _cooling("gdelt"):
        return []
    url = ("https://api.gdeltproject.org/api/v2/doc/doc"
           f"?query={quote_plus(query)}&mode=ArtList&format=json"
           f"&maxrecords={min(max(limit, 1), 250)}&sort=DateDesc")
    # An absolute window and a relative one are mutually exclusive in GDELT's API;
    # sending both makes it ignore one, and which one is not documented.
    if start:
        url += f"&startdatetime={start}" + (f"&enddatetime={end}" if end else "")
    else:
        url += f"&timespan={timespan}"
    if country:
        url += f"&sourcecountry={quote_plus(country)}"

    await _gdelt_limit.acquire()
    r = await f.get(url, respect_robots=False, timeout_s=GDELT_TIMEOUT_S,
                    accept="application/json", max_bytes=8 * 1024 * 1024)
    if r["status"] == 429:
        _cool("gdelt", "rate limited (one request per 5s; penalty window active)")
        return []
    if r["error"] or r["status"] != 200:
        _cool("gdelt", r["error"] or f"http {r['status']}")
        return []

    body = r["content"]
    # A throttled or malformed request answers with prose, not JSON — and sometimes
    # with HTTP 200. Reading that as an empty result set is exactly how a working
    # source comes to look like "no coverage exists", which is the most dangerous
    # wrong answer a research engine can give.
    if not body.lstrip().startswith(b"{"):
        _cool("gdelt", "non-JSON response (throttled or query rejected)")
        return []
    import json
    try:
        data = json.loads(body.decode("utf-8", "replace"))
    except ValueError:
        STATUS["gdelt"] = "unparseable JSON"
        return []
    if not isinstance(data, dict):
        return []
    STATUS.pop("gdelt", None)
    out: list[Hit] = []
    for a in data.get("articles") or []:
        u = canonical_url(a.get("url") or "")
        if not u:
            continue
        seen = str(a.get("seendate") or "")
        # GDELT stamps as YYYYMMDDTHHMMSSZ; keep only the date part.
        published = f"{seen[0:4]}-{seen[4:6]}-{seen[6:8]}" if len(seen) >= 8 else ""
        out.append(Hit(
            url=u, title=(a.get("title") or "").strip(), published=published,
            via="gdelt", tier=tier_for(u), query=query,
            language={"Kannada": "kn", "Hindi": "hi", "English": "en"}.get(
                str(a.get("language") or ""), str(a.get("language") or "").lower()[:2]),
            extra={"domain": a.get("domain") or "", "country": a.get("sourcecountry") or ""},
        ))
    return out


async def wikipedia(f: Fetcher, query: str, *, limit: int = 5, lang: str = "en") -> list[Hit]:
    """Wikipedia search. Encyclopaedic context, and useful for ruling people IN or OUT."""
    if not query.strip():
        return []
    url = (f"https://{lang}.wikipedia.org/w/api.php?action=query&list=search"
           f"&srsearch={quote_plus(query)}&format=json&srlimit={min(limit, 20)}")
    data = await f.get_json(url)
    results = (((data or {}).get("query") or {}).get("search") or []) if isinstance(data, dict) else []
    out: list[Hit] = []
    for r in results:
        title = str(r.get("title") or "")
        if not title:
            continue
        u = f"https://{lang}.wikipedia.org/wiki/{quote_plus(title.replace(' ', '_'))}"
        snippet = re.sub(r"<[^>]+>", "", str(r.get("snippet") or ""))
        out.append(Hit(url=canonical_url(u), title=title, snippet=snippet,
                       via=f"wikipedia:{lang}", tier=Tier.REFERENCE, query=query, language=lang))
    return out


async def wikidata_candidates(f: Fetcher, name: str, *, limit: int = 7) -> list[dict]:
    """Named entities that share this name.

    Not a discovery source — an identity source. If several real people share the
    subject's name, that is the namesake problem quantified, and the attribution
    stage is told about it so it can refuse to award confidence that the evidence
    cannot support.
    """
    if not name.strip():
        return []
    url = ("https://www.wikidata.org/w/api.php?action=wbsearchentities"
           f"&search={quote_plus(name)}&language=en&uselang=en&format=json&limit={min(limit, 20)}")
    data = await f.get_json(url)
    return [
        {"id": e.get("id"), "label": e.get("label"), "description": e.get("description") or ""}
        for e in ((data or {}).get("search") or []) if isinstance(data, dict) and e.get("id")
    ]


async def wayback(f: Fetcher, url: str) -> dict | None:
    """The closest archived copy of a URL.

    Two jobs. It recovers a page that has since been taken down — which for a news
    report about an arrest happens more often than you would like — and its earliest
    capture is independent evidence of when a page existed, which matters when a site
    claims to have covered something earlier than it did.
    """
    target = canonical_url(url)
    if not target:
        return None
    api = ("https://archive.org/wayback/available?url=" + quote_plus(target))
    data = await f.get_json(api)
    snap = (((data or {}).get("archived_snapshots") or {}).get("closest") or {}) \
        if isinstance(data, dict) else {}
    if not snap.get("available") or not snap.get("url"):
        return None
    return {"url": snap["url"], "timestamp": snap.get("timestamp", "")}


# ── onsite ──────────────────────────────────────────────────────────────────────

# Search-result pages are mostly navigation. These are the paths that are never an
# article, and skipping them is the difference between ten real hits and sixty links
# to category pages.
_NON_ARTICLE = re.compile(
    r"/(?:tag|tags|topic|topics|category|categories|author|authors|about|contact|privacy"
    r"|terms|subscribe|login|signin|register|search|page|sitemap|rss|feed|amp|epaper"
    r"|advertise|newsletter|comment|share)(?:/|$|\?)", re.I)

_HAS_ID = re.compile(r"/\d{5,}|/\d{4}/\d{2}/|article\d{5,}|/doc/\d+")

# A headline slug has many words. Requiring three or more hyphens is what separates
# "man-held-in-mysuru-cheating-case-1234" from the section pages that otherwise slip
# through every other filter — "all-high-courts" looks exactly like an article to a
# depth-and-slug rule, and each one costs a wasted fetch.
_HEADLINE_SLUG = re.compile(r"/(?:[^/]*[-\u2010]){5,}[^/]*$")

# Anchor text that is furniture, not a headline. Search pages are full of it.
_NAV_TEXT = re.compile(
    r"^(?:full document|read more|more|next|previous|home|view all|all .{0,30}|"
    r"login|sign ?in|subscribe|share|comments?|latest|top stories|advertisement)$", re.I)


def _looks_like_article(url: str, same_site: str) -> bool:
    """Heuristic: is this link a document rather than a navigation page?

    Honestly heuristic. It requires the link to be on the searched site, to not match
    a known navigation path, and to carry either a long slug or a numeric id — the two
    shapes essentially every CMS gives an article. Per-site templates change and this
    will occasionally miss or over-collect; a miss costs one source's hits for one
    run, which the run reports, and a false positive is discarded later when
    extraction finds no article text.
    """
    host = host_of(url)
    if not host or registrable(host) != same_site:
        return False
    path = url[len(f"https://{host}"):] if url.startswith("https://") else url
    if _NON_ARTICLE.search(path):
        return False
    # A numeric id is decisive; otherwise demand a headline-shaped slug.
    return bool(_HAS_ID.search(path) or _HEADLINE_SLUG.search(path))


def _search_terms(query: str) -> list[str]:
    """The words worth matching a headline against. Short words match everything."""
    return [w for w in re.findall(r"\w{4,}", (query or "").lower())]


def _links_from_search_html(body: bytes, base_url: str, *, link_contains: str = "",
                            limit: int = 12, terms: list[str] | None = None) -> list[tuple[str, str]]:
    """Pull the article links out of a search-results page, best first.

    Ordering by query-term overlap rather than by DOM position is what makes this work,
    and it was a measured fix rather than a refinement. A newsroom's search page carries
    its own furniture — today's front page, most-read promos, an awards microsite — and
    those markup blocks come FIRST. Taking the first five article-shaped links therefore
    returned five promos and none of the results: probed against thehindu.com and
    indianexpress.com, both returned byte-identical link sets for two unrelated queries,
    which is what a query-independent front page looks like. Their actual results were in
    the same document all along, further down.

    So every article-shaped link is collected and then ranked by how many query words
    appear in its anchor text or its slug. Ranking, not filtering: a source whose result
    headlines share no word with the query (indiankanoon returns case titles, not
    headlines) keeps its own order and loses nothing.
    """
    try:
        tree = lxml_html.fromstring(body)
    except Exception:
        return []
    same_site = registrable(host_of(base_url))
    needles = terms or []
    seen: set[str] = set()
    # (score, dom_index, url, title). Bounded so a 600 KB results page cannot make this
    # the expensive part of a run.
    scored: list[tuple[int, int, str, str]] = []
    for a in tree.xpath("//a[@href]")[:1200]:
        href = (a.get("href") or "").strip()
        if not href or href.startswith(("#", "mailto:", "javascript:", "tel:")):
            continue
        absolute = canonical_url(urljoin(base_url, href))
        if not absolute or absolute in seen:
            continue
        if link_contains:
            if link_contains not in absolute:
                continue
        elif not _looks_like_article(absolute, same_site):
            continue
        title = " ".join((a.text_content() or "").split())[:200]
        # A furniture label is worse than no title: the real one is read from the page
        # itself at extraction, and a wrong one here would show in the officer's list.
        if _NAV_TEXT.match(title):
            title = ""
        seen.add(absolute)
        haystack = f"{title.lower()} {absolute.lower()}"
        score = sum(1 for n in needles if n in haystack)
        scored.append((score, len(scored), absolute, title))
        if len(scored) >= limit * 8:
            break
    scored.sort(key=lambda row: (-row[0], row[1]))
    return [(u, t) for _, _, u, t in scored[:limit]]


def _quintype_hits(spec: dict, body: bytes, query: str, *, limit: int) -> list[Hit] | None:
    """Read a Quintype `/api/v1/advanced-search` response.

    Six of the outlets in the registry run Quintype, and its search API answers with the
    three things link-scraping could never give us: the canonical article url, the
    publisher's own headline, and `last-published-at` as an epoch. The date is the reason
    this is worth a separate adapter — an on-site hit used to arrive undated, so it could
    not be placed on the timeline and could not be ranked against fresher coverage.

    Returns None when the body is not a Quintype search response at all, so the caller
    can distinguish "this endpoint is broken" from "this publisher has nothing".
    """
    import json

    try:
        data = json.loads(body.decode("utf-8", "replace"))
    except ValueError:
        return None
    if not isinstance(data, dict) or "items" not in data:
        return None

    out: list[Hit] = []
    seen: set[str] = set()
    for it in (data.get("items") or []):
        if not isinstance(it, dict):
            continue
        u = canonical_url(str(it.get("url") or ""))
        if not u or u in seen:
            continue
        seen.add(u)
        published = ""
        ts = it.get("last-published-at") or it.get("published-at")
        if isinstance(ts, (int, float)) and ts > 0:
            from datetime import datetime, timezone
            try:
                published = datetime.fromtimestamp(ts / 1000, timezone.utc).date().isoformat()
            except (OSError, OverflowError, ValueError):
                published = ""
        out.append(Hit(
            url=u, title=" ".join(str(it.get("headline") or "").split())[:200],
            published=published, via=f"onsite:{spec['name']}",
            tier=spec.get("tier", Tier.UNKNOWN), query=query,
            language=spec.get("lang", "")))
        if len(out) >= limit:
            break
    return out


async def onsite_one(f: Fetcher, spec: dict, query: str, *, limit: int = 8) -> list[Hit] | None:
    """One publisher's own search. None means the endpoint failed; [] means no match.

    The distinction is not pedantry. `onsite()` reports failures to the officer, and a
    narrow query that legitimately matches nothing at one outlet used to be reported as
    that outlet being unreachable — which makes a working registry look broken and, worse,
    makes a genuinely broken source indistinguishable from a quiet one.
    """
    url = spec["url"].replace("{q}", quote_plus(query)).replace("{n}", str(max(limit, 1)))
    quintype = spec.get("kind") == "quintype"
    # robots is honoured for the API too. It is the publisher's own endpoint serving their
    # own site, not a machine-readable dataset published for third parties, so the polite
    # default applies and a future `Disallow: /api/` takes effect without a code change.
    r = await f.get(url, respect_robots=True, timeout_s=settings.search_timeout_s,
                    accept="application/json" if quintype else None)
    if r["error"] or r["status"] != 200 or not r["content"]:
        return None
    if quintype:
        return _quintype_hits(spec, r["content"], query, limit=limit)
    pairs = _links_from_search_html(r["content"], r["final_url"] or url,
                                   link_contains=spec.get("link_contains", ""), limit=limit,
                                   terms=_search_terms(query))
    # An HTML search page that yields no article-shaped link is indistinguishable from a
    # template change, so it stays a failure — unlike the API, it cannot say "no results".
    return [
        Hit(url=u, title=t, via=f"onsite:{spec['name']}", tier=spec.get("tier", Tier.UNKNOWN),
            query=query, language=spec.get("lang", ""))
        for u, t in pairs
    ] or None


async def onsite(f: Fetcher, query: str, *, limit_per_site: int = 6,
                 languages: tuple[str, ...] = ("en", "kn"),
                 only: tuple[str, ...] = ()) -> tuple[list[Hit], list[str]]:
    """Query authoritative publishers through their own search, concurrently."""
    specs = [s for s in ONSITE
             if (not only or s["name"] in only) and s.get("lang", "en") in languages]
    if not specs:
        return [], []
    results = await asyncio.gather(
        *[onsite_one(f, s, query, limit=limit_per_site) for s in specs],
        return_exceptions=True)
    hits: list[Hit] = []
    failed: list[str] = []
    for spec, res in zip(specs, results):
        if isinstance(res, BaseException) or res is None:
            failed.append(f"onsite:{spec['name']}")
            continue
        hits.extend(res)
    return hits, failed


# ── metasearch ──────────────────────────────────────────────────────────────────

async def searxng(f: Fetcher, query: str, *, limit: int = 15, language: str = "en-IN") -> list[Hit]:
    """Self-hosted SearXNG, if one is configured. Best-effort by design."""
    base = settings.searxng_url.rstrip("/")
    if not base or not query.strip():
        return []
    url = (f"{base}/search?q={quote_plus(query)}&format=json"
           f"&safesearch=0&language={quote_plus(language)}")
    data = await f.get_json(url)
    results = (data or {}).get("results") or [] if isinstance(data, dict) else []
    out: list[Hit] = []
    for r in results[:limit]:
        u = canonical_url(r.get("url") or "")
        if not u:
            continue
        out.append(Hit(url=u, title=(r.get("title") or "").strip(),
                       snippet=(r.get("content") or "")[:400],
                       published=str(r.get("publishedDate") or "")[:10],
                       via="searxng", tier=tier_for(u), query=query))
    return out


async def mojeek(f: Fetcher, query: str, *, limit: int = 12) -> list[Hit]:
    """Mojeek — an independent crawler and index, read through its result page.

    Included because it is one of very few web-scale indexes that is neither Google
    nor Bing, which makes it genuinely additive rather than a fourth view of the same
    ranking. Volume is kept low and robots is honoured; if it declines, we lose one
    source and say so.
    """
    if not settings.mojeek_enabled or not query.strip():
        return []
    url = f"https://www.mojeek.com/search?q={quote_plus(query)}"
    r = await f.get(url, respect_robots=True, timeout_s=settings.search_timeout_s)
    if r["error"] or r["status"] != 200:
        return []
    try:
        tree = lxml_html.fromstring(r["content"])
    except Exception:
        return []
    out: list[Hit] = []
    seen: set[str] = set()
    for a in tree.xpath("//a[@href]"):
        href = (a.get("href") or "").strip()
        if not href.startswith("http") or "mojeek.com" in href:
            continue
        u = canonical_url(href)
        if not u or u in seen:
            continue
        title = " ".join((a.text_content() or "").split())[:200]
        if len(title) < 12:
            continue
        seen.add(u)
        out.append(Hit(url=u, title=title, via="mojeek", tier=tier_for(u), query=query))
        if len(out) >= limit:
            break
    return out


#: Bing's news RSS output. The single highest-recall tier in this engine, and the one
#: that fixes its worst blind spot: the on-site registry is Karnataka plus national
#: English plus Kannada, so a Uttar Pradesh case covered by Hindi outlets was invisible.
#: This reaches it, in whatever language it was published.
#:
#: Four properties make it usable where a metasearch engine is not:
#:   * no key, no quota registration;
#:   * it answers from a datacenter IP — verified from AWS, HTTP 200, no CAPTCHA;
#:   * the item link embeds the PUBLISHER's url as a query parameter, so there is no
#:     redirect to follow and no consent wall to negotiate;
#:   * `pubDate` is the publisher's, not the crawl date.
#:
#: On robots: bing.com/robots.txt disallows `/search`, which does not match
#: `/news/search`, and there is no `/news` rule. Google News RSS was rejected for
#: exactly the opposite reason — `Disallow: /` with an allow-list that excludes `/rss` —
#: and it also hides the publisher url behind an unresolvable redirect.
BING_NEWS_URL = "https://www.bing.com/news/search?q={q}&format=RSS&mkt=en-IN&count=30"


def _bing_publisher_url(link: str) -> str:
    """Pull the publisher's url out of Bing's click-tracking wrapper."""
    from urllib.parse import parse_qs, unquote, urlparse

    link = (link or "").replace("&amp;", "&")
    if "apiclick.aspx" not in link:
        return canonical_url(link)
    qs = parse_qs(urlparse(link).query)
    target = (qs.get("url") or [""])[0]
    return canonical_url(unquote(target)) if target else ""


def _rss_items(body: bytes) -> list[dict]:
    """Parse an RSS channel into plain dicts. Tolerant by design.

    Feeds arrive with declared encodings that are wrong, stray ampersands and
    occasionally a truncated tail. `recover` keeps whatever parsed rather than losing
    thirty results to one malformed entity.
    """
    from lxml import etree

    try:
        root = etree.fromstring(body, parser=etree.XMLParser(recover=True, huge_tree=False))
    except Exception:
        return []
    if root is None:
        return []
    out: list[dict] = []
    for item in root.iter("item"):
        row: dict[str, str] = {}
        for child in item:
            tag = etree.QName(child).localname if child.tag is not etree.Comment else ""
            if tag and child.text:
                row.setdefault(tag, child.text.strip())
        if row:
            out.append(row)
    return out


def _rss_date(raw: str) -> str:
    """RFC-822 pubDate to YYYY-MM-DD. Empty when unparseable rather than guessed."""
    from email.utils import parsedate_to_datetime

    try:
        return parsedate_to_datetime(raw).date().isoformat()
    except Exception:
        return ""


async def bing_news(f: Fetcher, query: str, *, limit: int = 30) -> list[Hit]:
    """Bing News RSS. Keyless, multilingual, publisher urls included."""
    if not query.strip():
        return []
    url = BING_NEWS_URL.replace("{q}", quote_plus(query))
    r = await f.get(url, respect_robots=True, timeout_s=settings.search_timeout_s,
                    accept="application/rss+xml, application/xml, text/xml")
    if r["error"] or r["status"] != 200 or not r["content"]:
        _cool("bingnews", r["error"] or f"http {r['status']}")
        return []
    items = _rss_items(r["content"])
    # A narrow query legitimately matches nothing, and reporting that as a source
    # failure is how a working tier comes to look broken in the run report. Only a body
    # that is not a feed at all is a failure.
    if not items and b"<rss" not in r["content"][:400].lower():
        _cool("bingnews", "response was not an RSS feed")
        return []
    STATUS.pop("bingnews", None)
    out: list[Hit] = []
    seen: set[str] = set()
    for it in items[:limit]:
        u = _bing_publisher_url(it.get("link", ""))
        if not u or u in seen:
            continue
        seen.add(u)
        out.append(Hit(
            url=u, title=" ".join((it.get("title") or "").split())[:200],
            snippet=re.sub(r"<[^>]+>", "", it.get("description") or "")[:400],
            published=_rss_date(it.get("pubDate", "")),
            via="bingnews", tier=tier_for(u), query=query))
    return out


async def marginalia(f: Fetcher, query: str, *, limit: int = 10) -> list[Hit]:
    """Marginalia — an independent index that favours non-commercial pages.

    Needs a key, which its maintainer hands out freely. Skipped silently when unset.
    """
    key = settings.marginalia_key
    if not key or not query.strip():
        return []
    url = f"https://api.search.marginalia.nu/{quote_plus(key)}/search/{quote_plus(query)}"
    data = await f.get_json(url)
    results = (data or {}).get("results") or [] if isinstance(data, dict) else []
    out: list[Hit] = []
    for r in results[:limit]:
        u = canonical_url(r.get("url") or "")
        if not u:
            continue
        out.append(Hit(url=u, title=(r.get("title") or "").strip(),
                       snippet=(r.get("description") or "")[:400],
                       via="marginalia", tier=tier_for(u), query=query))
    return out


def available() -> dict[str, bool]:
    """What this deployment can actually reach. Surfaced in the run report.

    An engine that quietly loses a tier is an engine whose answers quietly get worse,
    so coverage is stated rather than assumed.
    """
    return {
        "gdelt": True,
        "bingnews": True,
        "wikipedia": True,
        "wikidata": True,
        "wayback": True,
        "onsite": bool(ONSITE),
        "searxng": bool(settings.searxng_url),
        "mojeek": settings.mojeek_enabled,
        "marginalia": bool(settings.marginalia_key),
    }
