"""What a static fetch is worth, per publisher.

Some publishers serve a JavaScript shell. A static fetch returns 200 OK and no article
text, and that costs one of the 48 reads a standard run gets. It is not theoretical: in
live testing three MSN urls carried exactly the story we were looking for and all three
came back "could not be read: no article text found".

The technique is Firecrawl's per-hostname verdict — it asks a service whether a cheap
client will do for a host before spending a browser on it. See
documentation/18-engine-techniques.md for what was studied and what was not taken. Ours is
the same idea with none of the infrastructure: an in-process tally of whether a static
fetch has ever produced readable text for a registrable domain.

It earns its place twice over even though we do not yet run a browser:

  1. THE BUDGET. A domain that has failed repeatedly and never succeeded is pushed down the
     fetch order, so the reads go to pages we can actually read. This is the whole benefit
     available today and it costs a dictionary.

  2. THE EXPLANATION. "could not be read: no article text found" tells an officer nothing
     they can act on. "this publisher serves a page our reader cannot open; the link works
     in a browser" tells them to click it. Same failure, one is useful.

Deliberately in memory and deliberately not persisted. It is a heuristic that improves
within a session and resets with the process, which is honest for a single always-on
instance — and a wrong verdict that survived a restart would be worse than no verdict,
because a publisher that changes its template would stay condemned.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .net import host_of, registrable

#: Consecutive unreadable fetches, with no readable one ever, before a domain is called
#: render-only. Three because two is within the range of ordinary bad luck — a paywall
#: interstitial, a redirect to a consent page, one genuinely empty article — and being
#: wrong here deprioritises a publisher that might have been fine.
NEEDS_RENDER_AFTER = 3


@dataclass
class DomainVerdict:
    readable: int = 0
    unreadable: int = 0
    streak: int = 0          # consecutive unreadable, reset by any success

    @property
    def needs_render(self) -> bool:
        return self.readable == 0 and self.streak >= NEEDS_RENDER_AFTER

    @property
    def label(self) -> str:
        if self.needs_render:
            return "render_only"
        if self.readable and self.unreadable:
            return "mixed"
        if self.readable:
            return "static_ok"
        return "unknown"


@dataclass
class Verdicts:
    """Per-domain tally. One instance per process; see the module docstring."""

    by_domain: dict[str, DomainVerdict] = field(default_factory=dict)

    @staticmethod
    def _key(url: str) -> str:
        return registrable(host_of(url)) or ""

    def record(self, url: str, *, readable: bool) -> None:
        key = self._key(url)
        if not key:
            return
        v = self.by_domain.setdefault(key, DomainVerdict())
        if readable:
            v.readable += 1
            v.streak = 0
        else:
            v.unreadable += 1
            v.streak += 1

    def needs_render(self, url: str) -> bool:
        v = self.by_domain.get(self._key(url))
        return bool(v and v.needs_render)

    def label(self, url: str) -> str:
        v = self.by_domain.get(self._key(url))
        return v.label if v else "unknown"

    def summary(self) -> dict[str, str]:
        """Domains we have an opinion about, for the run report and /health."""
        return {d: v.label for d, v in sorted(self.by_domain.items())
                if v.label != "unknown"}


#: Process-wide, because the useful thing about this tally is that it accumulates across
#: runs: the second run of the day already knows which publishers not to spend reads on.
verdicts = Verdicts()

#: Publishers known to serve an app shell, seeded so the first run benefits too. Kept
#: short and only for cases observed directly in testing — a guess here costs a publisher
#: its place in the fetch order, so the list is evidence, not suspicion.
for _seed in ("msn.com",):
    verdicts.by_domain[_seed] = DomainVerdict(unreadable=NEEDS_RENDER_AFTER,
                                              streak=NEEDS_RENDER_AFTER)


def render_notice(url: str) -> str:
    """The officer-facing explanation for an unreadable page on a render-only domain."""
    return ("this publisher serves a page our reader cannot open (it needs a browser); "
            "the link itself works")
