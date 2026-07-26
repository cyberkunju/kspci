"""Checks for rank fusion and the per-publisher fetch verdict.

Both decide which of ~128 discovered links become the 48 the run actually reads, so a
defect here is invisible: the run completes, returns sources, and simply never looked at
the right page. That is the most expensive kind of bug this engine can have.

Run: python -m app.selftest_fuse
"""

from __future__ import annotations

import sys

from .fuse import fuse, source_weight
from .models import Hit, Tier
from .verdict import NEEDS_RENDER_AFTER, Verdicts

FAILS: list[str] = []


def check(label: str, cond: bool, detail: str = "") -> None:
    print(f"{'ok  ' if cond else 'FAIL'} {label}" + (f"  [{detail}]" if detail else ""))
    if not cond:
        FAILS.append(label)


def head(title: str) -> None:
    print(f"\n— {title} —")


def hit(url: str, via: str, *, title: str = "", published: str = "",
        tier: Tier = Tier.UNKNOWN, snippet: str = "", language: str = "") -> Hit:
    return Hit(url=url, via=via, title=title, published=published, tier=tier,
               snippet=snippet, language=language)


def test_weights() -> None:
    head("source weights grade the finder, not the publisher")
    check("a publisher's own search outranks a news feed",
          source_weight("onsite:thehindu") > source_weight("bingnews"))
    check("a news feed outranks a metasearch engine",
          source_weight("bingnews") > source_weight("searxng"))
    check("an onsite label inherits the onsite weight",
          source_weight("onsite:anything") == source_weight("onsite"))
    check("an unknown source is not trusted more than a known weak one",
          source_weight("something-new") <= source_weight("searxng"))


def test_agreement_wins() -> None:
    head("agreement between tiers beats one source's first place")
    # A: ranked 3rd, 2nd and 4th by three different tiers.
    # B: ranked 1st by one tier and found by nobody else.
    legs = [
        [hit("https://x.test/p1", "bingnews"), hit("https://x.test/p2", "bingnews"),
         hit("https://a.test/story", "bingnews")],
        [hit("https://y.test/q1", "gdelt"), hit("https://a.test/story", "gdelt")],
        [hit("https://b.test/only", "onsite:thehindu"),
         hit("https://z.test/r", "onsite:thehindu"), hit("https://w.test/s", "onsite:thehindu"),
         hit("https://a.test/story", "onsite:thehindu")],
    ]
    order = [h.url for h in fuse(legs)]
    check("the link three tiers found leads", order[0] == "https://a.test/story", order[0])
    check("a single source's first place still ranks well",
          order.index("https://b.test/only") <= 2, str(order[:3]))
    check("every url survives ordering", len(order) == 7, str(len(order)))
    check("nothing is duplicated", len(set(order)) == len(order))


def test_position_matters() -> None:
    head("within one source, position still counts")
    legs = [[hit("https://x.test/first", "gdelt"), hit("https://x.test/tenth", "gdelt")]]
    order = [h.url for h in fuse(legs)]
    check("first beats second", order == ["https://x.test/first", "https://x.test/tenth"],
          str(order))


def test_merge_fields() -> None:
    head("duplicates are merged field by field, not first-wins")
    legs = [
        # A news feed: real date, no title.
        [hit("https://a.test/s", "bingnews", title="", published="2026-07-25")],
        # A newsroom's own search: full title, no date, better tier.
        [hit("https://a.test/s", "onsite:thehindu",
             title="Man held in Mysuru cheating case", tier=Tier.NEWS, language="en")],
        # A later, less precise date from a third tier.
        [hit("https://a.test/s", "gdelt", published="2026-07-28", snippet="longer snippet here")],
    ]
    out = fuse(legs)
    check("one hit remains", len(out) == 1, str(len(out)))
    h = out[0]
    check("the real title is kept", h.title == "Man held in Mysuru cheating case", h.title)
    # A wire index reports when IT saw the page, at or after publication, so the earliest
    # date across sources is closest to the truth.
    check("the earliest date is kept", h.published == "2026-07-25", h.published)
    check("the best tier is kept", h.tier == Tier.NEWS, str(h.tier))
    check("the language is picked up", h.language == "en", h.language)
    check("the longest snippet is kept", h.snippet == "longer snippet here", h.snippet)
    check("every finder is recorded", set(h.via.split(",")) ==
          {"bingnews", "onsite:thehindu", "gdelt"}, h.via)
    check("and counted", h.extra.get("found_by") == 3, str(h.extra.get("found_by")))


def test_empty_and_degenerate() -> None:
    head("degenerate input does not raise")
    check("no legs", fuse([]) == [])
    check("empty legs", fuse([[], []]) == [])
    check("a hit with no url is dropped rather than scored",
          fuse([[hit("", "gdelt")]]) == [])


def test_verdict() -> None:
    head("the per-publisher fetch verdict")
    v = Verdicts()
    url = "https://shell.test/article/one"

    check("an unknown publisher is not condemned", not v.needs_render(url))
    for i in range(NEEDS_RENDER_AFTER - 1):
        v.record(f"https://shell.test/a{i}", readable=False)
    check("a short run of failures is still not enough", not v.needs_render(url),
          v.label(url))
    v.record("https://shell.test/a9", readable=False)
    check("a sustained run with no success is", v.needs_render(url), v.label(url))
    check("and it is labelled for the report", v.label(url) == "render_only", v.label(url))

    # One success is decisive: a publisher that CAN be read statically is never
    # deprioritised, however many of its pages happened to be empty.
    v.record("https://shell.test/good", readable=True)
    check("a single success clears the verdict", not v.needs_render(url), v.label(url))
    check("and the mixed case is named", v.label(url) == "mixed", v.label(url))

    check("verdicts are per registrable domain, not per url",
          v.label("https://shell.test/completely/other") == "mixed")
    check("an unrelated domain is unaffected",
          v.label("https://other.test/x") == "unknown")
    check("the summary omits unknowns", "other.test" not in v.summary(),
          str(v.summary()))


def test_seeded_verdict() -> None:
    head("the seeded publisher list")
    from .verdict import verdicts as live
    # Observed directly in live testing: three MSN urls carried the correct story and all
    # three returned no article text.
    check("msn is seeded as render-only",
          live.needs_render("https://www.msn.com/en-in/news/india/whatever"),
          live.label("https://www.msn.com/en-in/news/india/whatever"))
    check("a normal newsroom is not", not live.needs_render("https://www.thehindu.com/x"))


if __name__ == "__main__":
    test_weights()
    test_agreement_wins()
    test_position_matters()
    test_merge_fields()
    test_empty_and_degenerate()
    test_verdict()
    test_seeded_verdict()
    print("\n" + ("all fusion and verdict checks passed" if not FAILS
                  else f"{len(FAILS)} FAILED: {FAILS}"))
    sys.exit(1 if FAILS else 0)
