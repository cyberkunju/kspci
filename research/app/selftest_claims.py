"""Checks for the claim contract: span verification, protected attributes, admission.

Run with no model configured — that is the point. Every check here is deterministic
logic that stands between a fluent model and an officer's case file, so none of it may
depend on a model being reachable to work.

    python -m app.selftest_claims
"""

from __future__ import annotations

import sys

from .attribute import confidence_note
from .claims import (_language_rule, _write_now, admitted, marker_map, protected,
                     verify_span)
from .cluster import cluster
from .models import Claim, Document, Story, Tier

_fails = 0


def check(label: str, cond: bool, detail: str = "") -> None:
    global _fails
    print(f"{'ok  ' if cond else 'FAIL'} {label}" + (f"  [{detail}]" if detail else ""))
    if not cond:
        _fails += 1


DOC_TEXT = (
    "Police in Mysuru on Tuesday arrested a 34-year-old man in connection with an "
    "alleged online investment fraud, officers said. The accused, identified as Suresh "
    "Kumar, is said to have collected deposits from at least twelve people in the city "
    "over eight months. A case has been registered at Devaraja police station under "
    "sections 318 and 319 of the Bharatiya Nyaya Sanhita."
)


def main() -> None:
    print("\n— span verification —")
    check("a genuine quote verifies",
          verify_span("collected deposits from at least twelve people in the city", DOC_TEXT))
    check("a quote with straightened punctuation still verifies",
          verify_span("A case has been registered at Devaraja police station — under sections",
                      DOC_TEXT))
    check("a quote with collapsed line breaks verifies",
          verify_span("arrested a 34-year-old man\n  in connection with an alleged", DOC_TEXT))
    check("a FABRICATED quote is rejected",
          not verify_span("the accused confessed to defrauding investors of two crore rupees",
                          DOC_TEXT),
          "this is the failure the whole contract exists to catch")
    check("a plausible-but-absent detail is rejected",
          not verify_span("police said the total amount involved was fifty lakh rupees", DOC_TEXT))
    check("a short fragment cannot verify a claim",
          not verify_span("officers said", DOC_TEXT),
          "five words appear in any report; six or more is evidence of quotation")
    check("an empty span is rejected", not verify_span("", DOC_TEXT))
    check("a span from a different document is rejected",
          not verify_span("the cabinet approved the irrigation project on Thursday", DOC_TEXT))

    print("\n— protected attributes —")
    for phrase in ["the accused belongs to a Scheduled Caste",
                   "a Lingayat businessman from the district",
                   "the man, a Muslim trader, was questioned",
                   "the BJP MLA denied the allegation"]:
        check(f"excluded: {phrase[:40]}", protected(phrase))
    for phrase in ["the accused was produced before a magistrate",
                   "a case was registered under section 318",
                   "the complainant reported a loss of forty thousand rupees"]:
        check(f"not flagged: {phrase[:40]}", not protected(phrase))

    # Half of what this engine reads is Kannada or Hindi, and claims are quoted in the
    # language they were published in. An English-only guard was screening none of them.
    for phrase in ["ಆರೋಪಿಯ ಜಾತಿಯನ್ನು ವರದಿ ಉಲ್ಲೇಖಿಸಿದೆ",
                   "ಆರೋಪಿ ಬಿಜೆಪಿ ಕಾರ್ಯಕರ್ತ ಎಂದು ಹೇಳಲಾಗಿದೆ",
                   "अभियुक्त की जाति का उल्लेख किया गया",
                   "आरोपी एक मुस्लिम व्यापारी है"]:
        check(f"excluded in script: {phrase[:28]}", protected(phrase))
    for phrase in ["ಮೈಸೂರಿನಲ್ಲಿ ಒಬ್ಬ ವ್ಯಕ್ತಿ ಬಂಧನ",
                   "धर्मस्थल में एक व्यक्ति गिरफ्तार हुआ",
                   "ಪ್ರಕರಣ ದೇವರಾಜ ಠಾಣೆಯಲ್ಲಿ ದಾಖಲಾಗಿದೆ"]:
        check(f"not flagged in script: {phrase[:28]}", not protected(phrase))

    # A cited publisher's name is not a claim about anybody. The Hindu is one of the
    # largest sources in the registry, and "The Hindu reported the arrest" used to have
    # the entire summary discarded.
    check("a cited outlet's name is not a protected attribute",
          not protected("The Hindu reported the arrest of the accused.", ["thehindu.com"]))
    check("nor when the outlet arrives as its own name",
          not protected("The Hindu reported it.", ["The Hindu"]))
    check("but the word still fails when it is about a person",
          protected("The Hindu says a Muslim man was named.", ["thehindu.com"]))
    check("and the exemption needs the outlet to have been cited",
          protected("A Hindu trader was questioned.", ["ndtv.com"]))

    print("\n— summary language —")
    check("Kannada is instructed explicitly", "KANNADA" in _language_rule("kn"))
    check("Hindi is instructed explicitly", "HINDI" in _language_rule("hi"))
    check("names and numbers are protected from translation",
          "transliterate" in _language_rule("kn"))
    check("English adds no instruction", _language_rule("en") == "")
    check("an unknown code falls back to English rather than failing",
          _language_rule("xx") == "" and _language_rule("") == "")
    # The system prompt alone did not hold: a live Kannada run came back in English until
    # the closing instruction named the language too.
    check("the closing instruction repeats the language",
          _write_now("kn").endswith("in Kannada."), _write_now("kn"))
    check("and says nothing extra for English",
          _write_now("en").strip() == "Write the summary now.", _write_now("en"))

    print("\n— admission —")

    def story(sid: str, tier: Tier, outlets: list[str], band: str) -> Story:
        docs = [Document(url=f"https://{o}/x", final_url=f"https://{o}/x", text=DOC_TEXT,
                         title="t", tier=tier, status=200) for o in outlets]
        for d, o in zip(docs, outlets):
            d.outlet = o
        s = Story(id=sid, documents=docs)
        s.attribution = band  # type: ignore[assignment]
        return s

    confirmed_news = story("A", Tier.NEWS, ["thehindu.com"], "confirmed")
    possible_news = story("B", Tier.NEWS, ["thehindu.com"], "possible")
    namesake = story("C", Tier.NEWS, ["thehindu.com"], "different_person")
    lone_blog = story("D", Tier.UNKNOWN, ["someblog.example"], "probable")
    two_blogs = story("E", Tier.UNKNOWN, ["a.example", "b.example"], "probable")

    unrelated = story("F", Tier.NEWS, ["thehindu.com"], "unrelated")
    keep, refused = admitted([confirmed_news, possible_news, namesake, lone_blog,
                              two_blogs, unrelated])
    ids = {s.id for s in keep}
    check("a confirmed newsroom story is summarised", "A" in ids, str(ids))

    # The posture: anything that COULD be the subject is summarised, and its confidence
    # travels into the prose. Refusing to summarise a weak match produced an empty
    # summary on a subject the engine had actually read material about, which is the
    # least useful answer available to a tool whose user cross-checks everything.
    check("a POSSIBLE story is summarised, with its uncertainty carried",
          "B" in ids, str(ids))
    check("and its confidence note says so",
          "POSSIBLY" in confidence_note(possible_news, independent_outlets=1),
          confidence_note(possible_news, independent_outlets=1))
    check("a lone unknown blog is summarised as uncorroborated",
          "D" in ids and "uncorroborated" in confidence_note(lone_blog, independent_outlets=1),
          confidence_note(lone_blog, independent_outlets=1))
    check("corroboration is stated when it exists",
          "2 independent outlets" in confidence_note(two_blogs, independent_outlets=2),
          confidence_note(two_blogs, independent_outlets=2))
    check("two independent unknown outlets are summarised", "E" in ids, str(ids))

    # What is still refused is only what is positively about somebody else. Summarising
    # that as though it were the subject is not caution, it is error.
    check("a namesake story is never summarised",
          "C" not in ids and "C" in refused, refused.get("C", ""))
    check("an unrelated story is never summarised",
          "F" not in ids and "F" in refused, refused.get("F", ""))
    check("every refusal carries a reason",
          all(bool(v) for v in refused.values()), str(refused))

    print("\n— markers —")
    claims = [
        Claim(text="a", span="x", story_id="A", document_url="u"),
        Claim(text="b", span="y", story_id="E", document_url="u"),
        Claim(text="c", span="z", story_id="A", document_url="u"),
        Claim(text="withheld", span="w", story_id="D", document_url="u",
              excluded="withheld: unverified"),
    ]
    m = marker_map(claims)
    check("markers number the admitted stories in order",
          m == {"A": "S1", "E": "S2"}, str(m))
    check("an excluded claim's story gets no marker", "D" not in m, str(m))

    print("\n— a whole document set, end to end without a model —")
    docs = [Document(url="https://thehindu.com/a", final_url="https://thehindu.com/a",
                     text=DOC_TEXT, title="Man held in Mysuru", tier=Tier.NEWS, status=200),
            Document(url="https://webindia123.com/a", final_url="https://webindia123.com/a",
                     text="PTI " + DOC_TEXT, title="One held", tier=Tier.AGGREGATOR, status=200)]
    for d in docs:
        d.outlet = d.url.split("/")[2]
    stories = cluster(docs)
    check("syndicated pair is one story with two outlets",
          len(stories) == 1 and len(stories[0].outlets) == 2,
          f"{len(stories)} stories, outlets={stories[0].outlets if stories else []}")
    check("the authoritative outlet leads the cluster",
          stories[0].lead.outlet == "thehindu.com", stories[0].lead.outlet)


if __name__ == "__main__":
    main()
    print(f"\n{'all claim checks passed' if not _fails else str(_fails) + ' CHECK(S) FAILED'}")
    sys.exit(1 if _fails else 0)
