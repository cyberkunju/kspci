"""The shapes that flow through the pipeline.

Deliberately plain dataclasses rather than an ORM or a document schema: nothing
here is persisted. A run exists in memory for as long as an officer is looking at
it, which is the whole point of a real-time engine — there is no corpus to keep
consistent and no migration to write.

The one non-obvious design choice is that a `Claim` carries the exact `span` it
came from, not just the document id. A citation that points at a URL is a promise;
a citation that points at a quoted span is checkable, and the pipeline checks it.
"""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass, field
from enum import IntEnum
from typing import Any, Literal


class Tier(IntEnum):
    """Source authority, low number = higher authority.

    Tiering is an accuracy mechanism, not decoration: a general web search
    systematically under-ranks the judgments, gazettes and police releases that a
    police researcher most needs, and over-ranks aggregators that merely repeat
    them. Corroboration and admission rules read this.
    """

    OFFICIAL = 1     # courts, gazettes, regulators, police releases
    NEWS = 2         # established newsrooms
    AGGREGATOR = 3   # syndicators, sector/trade press, regional re-publishers
    REFERENCE = 3    # encyclopaedic — factual but not primary
    COMMUNITY = 4    # forums, Q&A, complaint boards
    SOCIAL = 5       # public accounts only; off unless enabled
    UNKNOWN = 4


#: How confident we are that a document is about OUR subject and not a namesake.
#: This is the single most important value the engine produces. `different_person`
#: is a first-class, useful answer — it tells the officer we looked and it was not
#: them, which is not the same as finding nothing.
Attribution = Literal["confirmed", "probable", "possible", "different_person", "unrelated"]

ATTRIBUTION_RANK: dict[str, int] = {
    "confirmed": 4, "probable": 3, "possible": 2, "unrelated": 1, "different_person": 0,
}


@dataclass
class Anchors:
    """What we already know about the subject, used to decide identity.

    These come from KSP2's own records (or from the officer's own words) and are the
    only defence against the namesake problem. Without anchors this engine cannot
    honestly claim a document is about anybody in particular, and it says so.
    """

    names: list[str] = field(default_factory=list)      # incl. transliterations/aliases
    district: str = ""
    state: str = ""
    station: str = ""
    age: int | None = None
    crime_numbers: list[str] = field(default_factory=list)
    sections: list[str] = field(default_factory=list)
    associates: list[str] = field(default_factory=list)  # co-accused, known links
    organisations: list[str] = field(default_factory=list)
    date_from: str = ""
    date_to: str = ""

    def strength(self) -> int:
        """How discriminating this anchor set is.

        A bare name is worth almost nothing (millions of matches); a name plus a
        district plus an FIR number is nearly unique. The pipeline uses this to cap
        the best attribution band it is willing to award — you cannot reach
        `confirmed` on evidence that could not possibly distinguish two people.
        """
        score = 0
        if self.crime_numbers:
            score += 4
        if self.associates:
            score += 2
        if self.organisations:
            score += 2
        if self.district:
            score += 2
        if self.station:
            score += 1
        if self.age:
            score += 1
        if self.sections:
            score += 1
        if len(self.names) > 1:
            # An alias is a genuinely discriminating fact, worth about as much as
            # knowing the district. Scoring it at 1 held a report that named both the
            # legal name AND the alias down to `possible`, because the ceiling this
            # function sets was computed as though we knew almost nothing.
            score += 3
        return score


@dataclass
class Hit:
    """A discovery result, before we have looked at the page."""

    url: str
    title: str = ""
    snippet: str = ""
    published: str = ""
    via: str = ""              # which adapter found it
    tier: Tier = Tier.UNKNOWN
    query: str = ""            # which query surfaced it
    language: str = ""
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class Document:
    """A retrieved and extracted page."""

    url: str
    final_url: str = ""
    title: str = ""
    text: str = ""
    published: str = ""
    author: str = ""
    outlet: str = ""
    language: str = ""
    tier: Tier = Tier.UNKNOWN
    status: int = 0
    bytes: int = 0
    sha256: str = ""
    fetched_at: float = field(default_factory=time.time)
    via: list[str] = field(default_factory=list)
    error: str = ""
    injection_flags: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return bool(self.text) and not self.error

    def fingerprint(self) -> str:
        return hashlib.sha256((self.text or self.url).encode("utf-8", "replace")).hexdigest()


@dataclass
class Story:
    """One story, possibly published by many outlets.

    Syndication is why this type exists. A single wire report republished by twelve
    outlets is one fact carried twelve times, not twelve independent confirmations,
    and counting URLs instead of stories is how one unverified claim becomes
    "widely reported".
    """

    id: str
    documents: list[Document]
    attribution: Attribution = "possible"
    attribution_reasons: list[str] = field(default_factory=list)
    matched_anchors: list[str] = field(default_factory=list)
    #: The raw evidence score behind the band. Kept so stories can be ordered WITHIN a
    #: band by how much actually matched. Ordering by source authority alone put a
    #: tier-1 court record that shared only a name above the one report that named both
    #: the subject and his alias — and the summary reads from the top of the list.
    score: int = 0

    @property
    def lead(self) -> Document:
        """The most authoritative, then earliest, document in the cluster."""
        return sorted(self.documents, key=lambda d: (int(d.tier), d.published or "9999"))[0]

    @property
    def tier(self) -> Tier:
        return min((d.tier for d in self.documents), default=Tier.UNKNOWN)

    @property
    def outlets(self) -> list[str]:
        return sorted({d.outlet for d in self.documents if d.outlet})


@dataclass
class Claim:
    """One atomic factual assertion, tied to the text it came from."""

    text: str
    span: str                  # verbatim quote from the document
    story_id: str
    document_url: str
    tier: Tier = Tier.UNKNOWN
    date: str = ""
    verified: bool = False     # span was re-found in the stored document text
    excluded: str = ""         # non-empty = why it was withheld


@dataclass
class Finding:
    """A story as presented to the officer, with everything needed to judge it."""

    url: str
    title: str
    outlet: str
    published: str
    tier: int
    attribution: Attribution
    why: list[str]
    outlets: list[str]
    language: str
    snippet: str
    via: list[str]
    #: Which anchors this source actually matched, and how many independent outlets
    #: carried the same story. Both are shown in the officer's table: "confirmed" earned
    #: on an FIR number and a co-accused deserves different trust from "confirmed"
    #: earned on a name and a district, and the table should let them see which.
    matched: list[str] = field(default_factory=list)
    outlet_count: int = 1
    error: str = ""
    #: The citation marker this source carries in the summary — "S1", "S2" — or "" when
    #: the summary does not rest on it.
    #:
    #: Without this the whole citation contract stops at the engine boundary. The summary
    #: promises that every sentence names its source, and then every consumer showed the
    #: officer "[S6]" beside a source list that resolved it to nothing. On WhatsApp it was
    #: worse than useless: the list is numbered 1..6 in a different order, so an officer
    #: reading "[S6]" and asking about "the sixth source" was asking about two different
    #: documents at once.
    marker: str = ""
