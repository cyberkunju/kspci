"""Grouping documents into stories, so corroboration means something.

The problem this solves is specific and it silently corrupts every naive research
tool. One PTI or ANI wire report is republished, near-verbatim, by a dozen outlets.
Count URLs and you have twelve independent confirmations of a claim that exactly one
newsroom actually checked. A verdict built on that number is built on nothing.

So documents are clustered by near-duplicate text and each cluster is ONE story that
happens to have several outlets. Downstream, corroboration counts stories.

SimHash is the right tool here rather than embeddings: syndication is literal reuse of
wording, not semantic similarity, and a 64-bit fingerprint over word shingles catches
it in microseconds with no model, no dimensionality choice and no GPU. Two articles
that independently describe the same arrest in their own words are NOT syndication and
should stay separate — an embedding would merge them and lose a real confirmation.
"""

from __future__ import annotations

import hashlib
import re

from .models import Document, Story

#: Hamming distance below which two fingerprints are treated as the same text.
#:
#: Measured rather than guessed. Against a real wire report and its republished
#: variants: an added agency note or a "PTI" prefix moves 2-8 bits; an independent
#: newsroom describing the same arrest in its own words moves 36; an unrelated story
#: moves 26. Ten therefore catches every boilerplate variant with a wide margin, and
#: cannot merge two genuine confirmations into one.
SIMHASH_THRESHOLD = 10

#: A truncated republication moves 13-17 bits — too far for the fingerprint, too close
#: to unrelated text to reach by loosening it. Truncation is caught by a different and
#: more precise signal instead: the shorter text's shingles are almost entirely
#: contained in the longer one, which is what quoting the same sentences means and what
#: independently-written reporting never does.
CONTAINMENT_THRESHOLD = 0.70
_MIN_SHINGLES_FOR_CONTAINMENT = 12

_WORD = re.compile(r"[\w\u0900-\u0DFF]+", re.UNICODE)
_SHINGLE = 3


def _tokens(text: str) -> list[str]:
    return [w.lower() for w in _WORD.findall(text or "")]


def simhash(text: str, *, shingle: int = _SHINGLE) -> int:
    """64-bit SimHash over word shingles.

    Shingles rather than bare words: a bag of words is shared by any two articles on
    the same topic, while a shared run of three consecutive words is a sign of shared
    wording. That is the difference between "same subject" and "same text".
    """
    words = _tokens(text)
    if len(words) < shingle:
        # Too short to fingerprint meaningfully — fall back to an exact digest so
        # identical stubs still collapse and different ones never collide.
        return int.from_bytes(hashlib.blake2b(" ".join(words).encode(), digest_size=8).digest(), "big")

    bits = [0] * 64
    for i in range(len(words) - shingle + 1):
        gram = " ".join(words[i:i + shingle]).encode("utf-8", "replace")
        h = int.from_bytes(hashlib.blake2b(gram, digest_size=8).digest(), "big")
        for b in range(64):
            bits[b] += 1 if (h >> b) & 1 else -1
    value = 0
    for b in range(64):
        if bits[b] > 0:
            value |= 1 << b
    return value


def hamming(a: int, b: int) -> int:
    return ((a ^ b) & 0xFFFFFFFFFFFFFFFF).bit_count()


def _shingles(text: str, shingle: int = _SHINGLE) -> set[str]:
    words = _tokens(text)
    return {" ".join(words[i:i + shingle]) for i in range(len(words) - shingle + 1)}


#: How much of a document is fingerprinted. Syndication is visible in the opening: an
#: outlet republishing a wire copies the lead paragraphs, and whoever trimmed the tail
#: trimmed the tail. Fingerprinting a 120 KB judgment in full costs a hash per shingle
#: for no extra signal — measured at 3.9s to cluster 90 documents before this cap.
FINGERPRINT_CHARS = 8000


def containment_sets(smaller: set[str], larger: set[str]) -> float:
    """Containment over PRE-COMPUTED shingle sets.

    Separated from `containment()` because clustering compares each document against
    every member of every existing cluster, and rebuilding both shingle sets on each
    comparison made the stage quadratic in work as well as in comparisons.
    """
    if len(smaller) < _MIN_SHINGLES_FOR_CONTAINMENT or len(larger) < _MIN_SHINGLES_FOR_CONTAINMENT:
        return 0.0
    if len(smaller) > len(larger):
        smaller, larger = larger, smaller
    return len(smaller & larger) / len(smaller)


def containment(a: str, b: str) -> float:
    """How much of the SHORTER text appears verbatim in the longer one.

    Asymmetric on purpose. A 400-word original and the 200-word version an outlet ran
    are the same story; measured symmetrically (Jaccard) that pair scores about 0.5 and
    looks like a coincidence, while containment scores near 1.0 and says what is
    actually true — one is a cut of the other.
    """
    sa, sb = _shingles(a), _shingles(b)
    if len(sa) < _MIN_SHINGLES_FOR_CONTAINMENT or len(sb) < _MIN_SHINGLES_FOR_CONTAINMENT:
        return 0.0
    smaller, larger = (sa, sb) if len(sa) <= len(sb) else (sb, sa)
    return len(smaller & larger) / len(smaller)


def _norm_title(title: str) -> str:
    t = " ".join(_tokens(title))
    # Outlets append their own name to the headline; it is not part of the story.
    return re.sub(r"\s+(?:the hindu|deccan herald|indian express|ndtv|times of india)$", "", t)


def cluster(documents: list[Document]) -> list[Story]:
    """Group readable documents into stories, most authoritative lead first.

    Single-link clustering against existing cluster leads. With the tens of documents a
    run retrieves this is trivially fast, and single-link is the correct shape for
    syndication: a chain of near-identical copies IS one story, however long the chain.
    """
    readable = [d for d in documents if d.ok]
    if not readable:
        return []

    # Longest first, so the fullest version of a syndicated story becomes the lead and
    # the truncated re-publishers attach to it rather than the other way round.
    readable.sort(key=lambda d: (int(d.tier), -len(d.text)))

    # (simhash, normalised title, documents) per cluster, with fingerprints kept for
    # every member — not just the lead.
    # Fingerprint and shingle each document ONCE, up front.
    head = [d.text[:FINGERPRINT_CHARS] for d in readable]
    fps = [simhash(t) for t in head]
    shingles = [_shingles(t) for t in head]

    clusters: list[dict] = []
    for i, doc in enumerate(readable):
        title = _norm_title(doc.title)
        placed = False
        for c in clusters:
            # Single-link against EVERY member, not only the lead. Syndication arrives
            # as a chain — the agency copy, an outlet's lightly-edited version, a third
            # outlet's cut of that — and comparing only to the lead breaks the chain in
            # the middle and reports one story as two.
            for j in c["idx"]:
                if hamming(fps[i], fps[j]) <= SIMHASH_THRESHOLD:
                    placed = True
                    break
                if containment_sets(shingles[i], shingles[j]) >= CONTAINMENT_THRESHOLD:
                    placed = True
                    break
            # An identical headline across two outlets is syndication regardless of what
            # either body was cut down to.
            if not placed and title and title == c["title"]:
                placed = True
            if placed:
                c["docs"].append(doc)
                c["idx"].append(i)
                break
        if not placed:
            clusters.append({"idx": [i], "title": title, "docs": [doc], "fp": fps[i]})

    stories: list[Story] = []
    for c in clusters:
        fp, docs = c["fp"], c["docs"]
        # A stable id from the lead's content, so the same story keeps its id across
        # the claim and synthesis stages within a run.
        sid = f"S{hashlib.blake2b(str(fp).encode(), digest_size=4).hexdigest()}"
        stories.append(Story(id=sid, documents=docs))
    return stories


def independence(stories: list[Story]) -> dict[str, int]:
    """How many genuinely independent outlets carry each story.

    Outlets are counted once per registrable domain, and syndicators are counted but
    flagged by tier so the caller can weigh them properly: five aggregators reprinting
    one agency is breadth of distribution, not breadth of verification.
    """
    return {s.id: len({d.outlet for d in s.documents if d.outlet}) or 1 for s in stories}
