"""Adversarial checks for the reasoning core: planning, clustering, attribution.

These are the tests that matter. The retrieval half either works or visibly fails;
this half can be confidently, silently wrong, and the two ways it goes wrong are the
namesake and the syndicated wire. Both are fixtures here.

    python -m app.selftest_reason
"""

from __future__ import annotations

import sys

from .attribute import admissible, apply, score
from .cluster import cluster, hamming, independence, simhash
from .models import Anchors, Document, Story, Tier
from .plan import name_variants, neutralise, plan_queries

_fails = 0


def check(label: str, cond: bool, detail: str = "") -> None:
    global _fails
    print(f"{'ok  ' if cond else 'FAIL'} {label}" + (f"  [{detail}]" if detail else ""))
    if not cond:
        _fails += 1


def doc(url: str, text: str, *, title: str = "", tier: Tier = Tier.NEWS,
        outlet: str = "", published: str = "2026-03-04") -> Document:
    d = Document(url=url, final_url=url, title=title, text=text, tier=tier,
                 published=published, status=200)
    d.outlet = outlet or url.split("/")[2]
    return d


# ── planning ────────────────────────────────────────────────────────────────────

def test_planning() -> None:
    print("\n— name variants —")
    v = name_variants("Suresh Kumar")
    lower = [x.lower() for x in v]
    check("generates the joined form", "sureshkumar" in lower, str(v))
    check("generates the initial form", "S Kumar" in v, str(v))
    check("bounded", len(v) <= 5, str(len(v)))
    check("strips honorifics", name_variants("Dr. Suresh Kumar")[0] == "Suresh Kumar",
          str(name_variants("Dr. Suresh Kumar")[:1]))
    kn = name_variants("ಸುರೇಶ್ ಕುಮಾರ್")
    check("a Kannada-script name is used verbatim, not romanised",
          kn == ["ಸುರೇಶ್ ಕುಮಾರ್"], str(kn))

    print("\n— query neutrality —")
    check("loaded words stripped from a subject",
          neutralise("Zorvyn investment fraud scam") == "Zorvyn investment",
          neutralise("Zorvyn investment fraud scam"))

    print("\n— query plan —")
    anchors = Anchors(names=["Suresh Kumar"], district="Mysuru", station="Devaraja",
                      age=34, crime_numbers=["OCR1234/2026"], associates=["Ramesh Gowda"])
    qs, gd = plan_queries(subject="Suresh Kumar", kind="person", anchors=anchors,
                          max_queries=14)
    texts = [q.text for q in qs]
    check("the case number leads the plan", "OCR1234/2026" in texts[0], texts[0])
    check("an associate query exists",
          any("Ramesh Gowda" in t for t in texts), str(texts[:6]))
    check("a neutral bare-name query is always present",
          any(t == '"Suresh Kumar"' for t in texts), str(texts))
    check("no query asserts guilt", not any("scam" in t.lower() or "fraud" in t.lower()
                                            for t in texts), str(texts))
    check("gdelt gets one broad plan, not many", gd.must == ["Suresh Kumar"] and len(gd.any_of) > 3,
          f"must={gd.must} any_of={len(gd.any_of)}")
    check("respects the query cap", len(qs) <= 14, str(len(qs)))

    ident, _ = plan_queries(subject="quickrich@okaxis", kind="identifier",
                            anchors=Anchors(), max_queries=8)
    check("an identifier is quoted", ident[0].text == '"quickrich@okaxis"', ident[0].text)


# ── clustering ──────────────────────────────────────────────────────────────────

WIRE = ("Police in Mysuru on Tuesday arrested a 34-year-old man in connection with an "
        "alleged online investment fraud, officers said. The accused, identified as "
        "Suresh Kumar, is said to have collected deposits from at least twelve people "
        "in the city over eight months. A case has been registered at Devaraja police "
        "station. Investigators said the amount involved is being assessed.")


def test_clustering() -> None:
    print("\n— syndication —")
    # The same wire, republished with a different headline and an outlet sign-off:
    # the shape of the failure this exists to prevent.
    docs = [
        doc("https://a.example/1", WIRE, title="Man held in Mysuru fraud case", outlet="a.example"),
        doc("https://b.example/1", WIRE + " (With inputs from agencies)",
            title="Mysuru: one arrested in investment fraud", outlet="b.example"),
        doc("https://c.example/1", "PTI  " + WIRE, title="One held over deposits",
            outlet="c.example"),
        # Genuinely separate reporting on the same event, in its own words.
        doc("https://d.example/1",
            "A businessman from Mysuru has been taken into custody after several "
            "residents complained that money handed over for a promised return was "
            "never repaid, according to a statement issued by district police on "
            "Wednesday. The complainants told reporters they had each paid amounts "
            "between twenty and eighty thousand rupees.",
            title="District police act on deposit complaints", outlet="d.example"),
    ]
    stories = cluster(docs)
    check("three syndicated copies collapse into one story", len(stories) == 2,
          f"{len(stories)} stories: {[len(s.documents) for s in stories]}")
    biggest = max(stories, key=lambda s: len(s.documents))
    check("the wire cluster holds all three copies", len(biggest.documents) == 3,
          str(len(biggest.documents)))
    check("independent reporting stays a separate story",
          any(len(s.documents) == 1 for s in stories))
    ind = independence(stories)
    check("outlet counting is per story", ind[biggest.id] == 3, str(ind))

    print("\n— fingerprinting —")
    check("identical text, identical fingerprint", simhash(WIRE) == simhash(WIRE))
    check("a small edit stays close",
          hamming(simhash(WIRE), simhash(WIRE + " Officers said.")) <= 6,
          str(hamming(simhash(WIRE), simhash(WIRE + " Officers said."))))
    other = ("The state cabinet approved a new irrigation project for the northern "
             "districts on Thursday, allocating funds over three financial years.")
    check("unrelated text is far away", hamming(simhash(WIRE), simhash(other)) > 12,
          str(hamming(simhash(WIRE), simhash(other))))
    check("empty input does not crash", isinstance(simhash(""), int))


# ── attribution: the namesake problem ───────────────────────────────────────────

def test_attribution() -> None:
    strong = Anchors(names=["Suresh Kumar"], district="Mysuru", station="Devaraja",
                     age=34, crime_numbers=["OCR1234/2026"], associates=["Ramesh Gowda"])
    weak = Anchors(names=["Suresh Kumar"])

    print("\n— attribution with strong anchors —")
    ours = Story(id="S1", documents=[doc(
        "https://a.example/1",
        WIRE + " The FIR, numbered OCR1234/2026, also names Ramesh Gowda.",
        title="Suresh Kumar held in Mysuru fraud case", tier=Tier.NEWS)])
    band, reasons, matched = score(ours, strong, subject="Suresh Kumar")
    check("case number + associate + station = confirmed", band == "confirmed", band)
    check("reasons are auditable, not a score",
          any("OCR1234/2026" in r for r in reasons), str(reasons))
    check("matched anchors reported", {"crime_number", "associate", "station"} <= set(matched),
          str(matched))

    print("\n— the namesake —")
    namesake = Story(id="S2", documents=[doc(
        "https://b.example/2",
        "Suresh Kumar, a botanist at a Patna research institute, has published a new "
        "survey of wetland flora in Bihar. The study, three years in preparation, "
        "documents forty species not previously recorded in the region.",
        title="Suresh Kumar publishes wetland survey", tier=Tier.NEWS)])
    band, reasons, _ = score(namesake, strong, subject="Suresh Kumar")
    check("a different person is identified as such", band == "different_person", band)
    check("and the reason says why",
          any("botanist" in r or "Patna" in r for r in reasons), str(reasons))

    print("\n— confidence is capped by what we hold —")
    band, reasons, _ = score(ours, weak, subject="Suresh Kumar")
    check("a bare name cannot produce a confirmation", band == "possible", band)
    check("and the officer is told what would change that",
          any("beyond a name" in r for r in reasons), str(reasons))

    print("\n— truncated republication is still syndication —")
    full = doc("https://e.example/1", WIRE, title="Man held in Mysuru fraud case",
               outlet="e.example")
    cut = doc("https://f.example/1", WIRE[:int(len(WIRE) * 0.6)],
              title="Mysuru arrest", outlet="f.example")
    st = cluster([full, cut])
    check("a 60% cut of the same wire does not count as a second confirmation",
          len(st) == 1, f"{len(st)} stories")

    print("\n— name absent —")
    unrelated = Story(id="S3", documents=[doc(
        "https://c.example/3", "The cabinet approved an irrigation project on Thursday.",
        title="Irrigation project approved", tier=Tier.NEWS)])
    band, reasons, _ = score(unrelated, strong, subject="Suresh Kumar")
    check("no name means unrelated", band == "unrelated", band)

    print("\n— age contradiction counts against —")
    wrong_age = Story(id="S4", documents=[doc(
        "https://d.example/4",
        "Suresh Kumar, a 61-year-old resident of Mysuru, was felicitated at a civic "
        "function on Sunday for four decades of service.",
        title="Suresh Kumar felicitated in Mysuru", tier=Tier.NEWS)])
    band, reasons, _ = score(wrong_age, strong, subject="Suresh Kumar")
    check("a mismatched age does not reach confirmed",
          band in {"possible", "probable"}, band)
    check("and it is stated", any("does not match" in r for r in reasons), str(reasons))

    print("\n— ordering and admission —")
    stories = apply([namesake, ours, unrelated], strong, subject="Suresh Kumar")
    check("best attribution first", stories[0].id == "S1", stories[0].id)
    ok, why = admissible(stories[0], independent_outlets=1)
    check("a tier-2 confirmed story is admissible", ok, why)
    ok2, why2 = admissible(namesake, independent_outlets=5)
    check("a different-person story is never admissible", not ok2, why2)
    low = Story(id="S5", documents=[doc("https://blog.example/x", WIRE, tier=Tier.UNKNOWN)])
    low.attribution = "probable"
    ok3, why3 = admissible(low, independent_outlets=1)
    check("an uncorroborated unknown blog is not admissible", not ok3, why3)
    ok4, _ = admissible(low, independent_outlets=2)
    check("two independent outlets admit it", ok4)


if __name__ == "__main__":
    test_planning()
    test_clustering()
    test_attribution()
    print(f"\n{'all reasoning checks passed' if not _fails else str(_fails) + ' CHECK(S) FAILED'}")
    sys.exit(1 if _fails else 0)
