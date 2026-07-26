"""Merging what several sources returned into one ranked list.

The problem this solves is a budget problem. Discovery returns 120 to 130 candidates and
the fetch budget reads 48 of them, so the ordering of that list decides what the run
actually sees. Everything after retrieval — clustering, attribution, claims — can only
work on pages that were read.

The old ordering used a single weak signal: does a subject word appear in the title. It
also threw away the strongest signal available. When the same URL came back from GDELT and
from a court's own search and from a news feed, we kept the first occurrence and discarded
the rest, so *three independent tiers agreed on this link* was computed and then binned.

WEIGHTED RECIPROCAL-RANK FUSION fixes that, and the technique is SearXNG's — see
documentation/18-engine-techniques.md for what was studied and what was not taken. A hit's
score rises with how highly each source ranked it, with how many sources ranked it at all,
and with how much a police researcher should care about the source that did the ranking.

Two properties matter as much as the ranking:

  * MERGING, NOT DROPPING. Duplicates are combined — the longest title wins because some
    sources return none, the earliest date wins because a wire index reports when it saw a
    page rather than when it was published, and `via` becomes the union so the officer's
    table can show that four tiers found this one.

  * NOTHING IS DISCARDED. This is ordering, not filtering. A hit that scores last is still
    in the list, still fetched if the budget reaches it, and still shown if it is not.
    Relevance is attribution's decision, and attribution needs the full text.
"""

from __future__ import annotations

from dataclasses import dataclass

from .models import Hit, Tier

#: How much each source's opinion of rank is worth. Not source *authority* — that is
#: `Tier`, and it grades the publisher rather than the finder. This grades the FINDER: a
#: court's own search knows its own judgments, so its ordering is meaningful; a news feed
#: ranks by recency and popularity, which is weaker evidence about relevance; a metasearch
#: engine is ranking somebody else's ranking.
SOURCE_WEIGHT: dict[str, float] = {
    "onsite": 1.6,       # a publisher's own index of its own archive
    "gdelt": 1.2,        # a purpose-built news index, but ranked by date
    "bingnews": 1.0,     # broad and multilingual, ranked by recency and popularity
    # A general web index ranked by its own relevance model rather than by date. Rated
    # just under a purpose-built news index and above metasearch: its ordering is a real
    # relevance judgment, but it is optimising for a general searcher, not an investigator,
    # and it is the one tier that returns forums and blogs where quality varies wildly.
    "web": 1.1,
    "wikipedia": 0.9,    # authoritative but rarely the coverage we are after
    "searxng": 0.7,      # ranking a ranking
    "marginalia": 0.7,
    "mojeek": 0.7,
}

#: Below this many characters a title tells us nothing, so a longer one always wins even
#: if it arrived second.
_MIN_TITLE = 8


def source_weight(via: str) -> float:
    """Weight for a `via` label. `onsite:thehindu` inherits the `onsite` weight."""
    key = (via or "").split(":", 1)[0].strip().lower()
    return SOURCE_WEIGHT.get(key, 0.6)


@dataclass
class Fused:
    """One URL, everything that found it, and what that adds up to."""

    hit: Hit
    score: float
    sources: int


def fuse(ranked: list[list[Hit]]) -> list[Hit]:
    """Merge per-source ranked lists into one ordered list.

    `ranked` is one list per source leg, each already in that source's own order — the
    order IS the signal, so callers must not pre-sort or shuffle.
    """
    merged: dict[str, Hit] = {}
    scores: dict[str, float] = {}
    positions: dict[str, list[tuple[float, int]]] = {}

    for leg in ranked:
        for index, hit in enumerate(leg, start=1):
            url = hit.url
            if not url:
                continue
            weight = source_weight(hit.via)
            positions.setdefault(url, []).append((weight, index))
            existing = merged.get(url)
            if existing is None:
                merged[url] = hit
            else:
                _absorb(existing, hit)

    for url, seen in positions.items():
        # Σ(weight / position), then multiplied by how many sources contributed. Agreement
        # between independent tiers is the point: one source ranking a link first is a
        # guess, three sources ranking it in their top ten is corroboration about
        # relevance, and it is available for free before a single page is fetched.
        base = sum(w / pos for w, pos in seen)
        scores[url] = base * len(seen)

    order = sorted(merged.values(), key=lambda h: -scores.get(h.url, 0.0))
    for hit in order:
        hit.extra["fused_score"] = round(scores.get(hit.url, 0.0), 4)
        hit.extra["found_by"] = len(positions.get(hit.url, []))
    return order


def _absorb(into: Hit, other: Hit) -> None:
    """Fold a duplicate into the hit we are keeping.

    Field-by-field rather than first-wins, because sources are good at different things:
    Bing News carries a real publication date and sometimes no title, on-site search
    carries a title and no date at all.
    """
    if len(other.title or "") > max(len(into.title or ""), _MIN_TITLE - 1):
        into.title = other.title
    if len(other.snippet or "") > len(into.snippet or ""):
        into.snippet = other.snippet
    # Earliest wins: a wire index reports when IT saw the page, which is at or after
    # publication, so the earliest date across sources is the closest to the truth.
    if other.published and (not into.published or other.published < into.published):
        into.published = other.published
    if other.language and not into.language:
        into.language = other.language
    if int(other.tier) < int(into.tier):
        into.tier = other.tier
    # `via` becomes a comma-joined union so the officer's table can show every tier that
    # found this link, and `_findings` can count them.
    vias = [v for v in (into.via or "").split(",") if v]
    for v in (other.via or "").split(","):
        if v and v not in vias:
            vias.append(v)
    into.via = ",".join(vias)
    if into.tier == Tier.UNKNOWN and other.tier != Tier.UNKNOWN:
        into.tier = other.tier
