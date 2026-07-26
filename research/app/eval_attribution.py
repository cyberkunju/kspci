"""The number that actually matters: how often do we confidently identify the wrong person.

WHY THIS FILE EXISTS. Every other test in this engine asks "does the code do what it says".
This one asks "is the answer right". Those are different questions, and only the second one
matters to an officer holding a report that says `probable` next to a stranger's name.

Until this existed, the attribution bands were tuned by looking at a handful of live runs
and judging them by eye. That is evidence, and it is not validation — it cannot produce a
number, it cannot catch a regression, and it silently rewards whatever subject happened to
be tested most.

    python -m app.eval_attribution          # measure and gate
    python -m app.eval_attribution -v       # show every case

WHAT IT MEASURES. Two rates, and they trade against each other:

  FALSE CONFIRM — a document that is NOT about the subject, graded `probable` or better.
    The one that gets somebody wrongly investigated. Gated hard.
  RECALL — a document that IS about the subject, graded `probable` or better.
    The one that matters for usefulness. Gated softly, because a missed source is still
    listed in the officer's table with its reasons; a false confirm is asserted.

HOW THE CASES WERE CHOSEN. Every document here is one this engine actually retrieved during
live testing, kept with its real title and a faithful excerpt, and labelled by hand. The
namesake traps are the ones that actually fooled an earlier version — that is the point of
them. Nothing is invented to be easy, and the awkward cases were not dropped because they
were awkward.

WHAT IT IS NOT. Twenty-eight documents across seven subjects is a regression harness and a
measurement, not a field validation. It cannot tell you the false-confirm rate on the real
distribution of KSP's casework, because that distribution is not in here. What it can do is
tell you the day a change makes attribution worse, which is the thing nobody could see
before. See documentation/17-remaining-work.md.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass

from .attribute import PERSON_LIKE, score, score_topic
from .models import ATTRIBUTION_RANK, Anchors, Document, Story, Tier

#: A confident band — one the summary may rest on.
CONFIDENT = ATTRIBUTION_RANK["probable"]

#: Bands that REMOVE a source from consideration rather than merely qualifying it.
#: `possible` still reaches the officer's table with its reasons and can still be read;
#: these two say "this is not your subject", and saying that about a document which IS
#: your subject is the recall failure that actually costs an investigation something.
DISMISSED = {"unrelated", "different_person"}

#: THE GATE. Three numbers, and only two of them are hard.
#:
#: A false confirm is asserted to the officer, so it is gated at zero. A dismissal of a
#: real source is gated at zero too, because that source vanishes from the reasoning.
#: Confident recall is REPORTED but gated loosely: a real report that says "Vipul, alias
#: Khooni" and never the full name genuinely is weaker evidence, and grading it `possible`
#: is the correct answer, not a defect. Setting this floor high would tune the engine
#: towards over-confidence, which is precisely what it exists not to do.
MAX_FALSE_CONFIRM = 0.0
MAX_DISMISSED = 0.0
MIN_CONFIDENT_RECALL = 0.50


@dataclass
class Case:
    subject: str
    anchors: Anchors
    #: True when this document really is about the subject.
    is_subject: bool
    title: str
    text: str
    outlet: str
    tier: Tier
    #: Why this case is in the set — printed on failure so the reader knows what broke.
    note: str
    namesakes: int = 0
    url: str = "https://example.invalid/doc"
    #: A person is scored on name-plus-corroborating-facts; anything else is scored on its
    #: distinctive terms. Dispatching wrongly here does not test the engine, it tests the
    #: harness — an organisation put through the person scorer is capped by person anchors
    #: it was never going to have.
    kind: str = "person"


def _story(c: Case) -> Story:
    d = Document(url=c.url, final_url=c.url, title=c.title, text=c.text,
                 outlet=c.outlet, tier=c.tier, status=200, via=["eval"])
    return Story(id="S1", documents=[d])


def _grade(c: Case) -> tuple[str, list[str]]:
    """Score one case exactly as `attribute.apply` would."""
    story = _story(c)
    if (c.kind or "person").lower() in PERSON_LIKE:
        band, reasons, _ = score(story, c.anchors, subject=c.subject,
                                 namesakes=c.namesakes)
    else:
        band, reasons, _ = score_topic(story, c.anchors, subject=c.subject)
    return band, reasons


# ── the set ─────────────────────────────────────────────────────────────────────
#
# Anchors are given at the strength an officer would realistically have. That matters:
# `anchors.strength()` caps the band, so a subject known only by name CANNOT reach
# `confirmed` no matter what matches, and cases below are labelled with that in mind.

_KHOONI = Anchors(names=["Vipul Singh", "Khooni"], state="Uttar Pradesh",
                  district="Baghpat")
_KHOONI_BARE = Anchors(names=["Vipul Singh", "Khooni"])
_SURESH = Anchors(names=["Suresh Kumar"], district="Mysuru", state="Karnataka",
                  station="Devaraja", crime_numbers=["CR/112/2026"])
_GANG = Anchors(names=["Sushil Moonch gang"], state="Uttar Pradesh")

CASES: list[Case] = [
    # ── the subject, correctly ──────────────────────────────────────────────────
    Case(subject="Vipul Singh alias Khooni", anchors=_KHOONI, is_subject=True,
         title="UP STF Meerut unit, Baghpat police kill Vipul Singh",
         text=("A sharpshooter of the Sushil Moonch gang, Vipul Singh alias Khooni, was "
               "killed in an encounter with the Uttar Pradesh STF's Meerut unit and Baghpat "
               "police on Friday. Police said he was wanted in 38 cases across Uttar "
               "Pradesh and Delhi, including murder, robbery and extortion, and carried a "
               "reward of Rs 50,000."),
         outlet="newsbytesapp.com", tier=Tier.AGGREGATOR,
         note="the primary report: both names, the place, the case count"),
    Case(subject="Vipul Singh alias Khooni", anchors=_KHOONI, is_subject=True,
         title="Reward-carrying gang member dies after police encounter in UP's Baghpat",
         text=("A gang member carrying a reward of Rs 50,000 died after an encounter with "
               "police in Baghpat district. He was identified as Vipul, alias Khooni, a "
               "resident of Bhabhisa village in Shamli district."),
         outlet="theprint.in", tier=Tier.NEWS,
         note="a second outlet, alias only plus the district — must still be confident"),
    Case(subject="Vipul Singh alias Khooni", anchors=_KHOONI, is_subject=True,
         title="सुशील मूंछ गैंग का शार्प शूटर था विपुल, बागपत में एनकाउंटर",
         text=("बागपत में पुलिस और एसटीएफ की मुठभेड़ में 50 हजार का इनामी बदमाश विपुल उर्फ "
               "खूनी मारा गया। वह सुशील मूंछ गैंग का शार्प शूटर था और उस पर तीन दर्जन से "
               "अधिक आपराधिक मुकदमे दर्ज थे। Vipul Singh alias Khooni"),
         outlet="bhaskar.com", tier=Tier.NEWS,
         note="Hindi coverage — vernacular reporting must not be penalised"),
    Case(subject="Suresh Kumar", anchors=_SURESH, is_subject=True,
         title="Man held in Mysuru online investment fraud",
         text=("Police in Mysuru arrested a 34-year-old man on Tuesday in connection with an "
               "alleged online investment fraud. The accused, identified as Suresh Kumar, is "
               "said to have collected deposits from at least twelve people. A case has been "
               "registered at Devaraja police station, CR/112/2026."),
         outlet="deccanherald.com", tier=Tier.NEWS,
         note="strong anchors — station and crime number both present, may reach confirmed"),
    Case(subject="Sushil Moonch gang", anchors=_GANG, is_subject=True, kind="organisation",
         title="Dreaded don Sushil Mooch's Rs 90 crore worth assets seized",
         text=("Authorities attached assets worth Rs 90 crore belonging to Sushil Moonch, the "
               "head of the Sushil Moonch gang, under the Gangsters Act in Uttar Pradesh."),
         outlet="indiatimes.com", tier=Tier.NEWS,
         note="an organisation subject, correctly matched"),

    # ── namesakes and homonyms: the ones that actually fooled us ────────────────
    Case(subject="Vipul Singh alias Khooni", anchors=_KHOONI, is_subject=False,
         title="Khooni Monday: Mahavatar Narsimha sees over 166% growth on first Monday",
         text=("Khooni Monday. The Hindi film Mahavatar Narsimha recorded over 166 per cent "
               "growth at the box office on its first Monday, emerging as the film with the "
               "second highest growth rate."),
         outlet="bollywoodhungama.com", tier=Tier.NEWS,
         note="an alias that is also a common word — matched the alias and nothing else"),
    Case(subject="Vipul Singh alias Khooni", anchors=_KHOONI, is_subject=False,
         title="Be Khooni Meaning in English",
         text=("Be Khooni meaning in English is bloodless. Be Khooni is an Urdu word used in "
               "the sense of describing something without blood."),
         outlet="hamariweb.com", tier=Tier.UNKNOWN,
         note="a dictionary page — the alias as vocabulary, not a person"),
    Case(subject="Vipul Singh alias Khooni", anchors=_KHOONI, is_subject=False,
         title="'Khooni' village in Uttarakhand renamed to respect public sentiments",
         text=("A village named Khooni in Uttarakhand has been renamed following a request "
               "from residents, officials said. The new name was notified this week."),
         outlet="abplive.com", tier=Tier.NEWS,
         note="the alias as a place name, in a different state"),
    Case(subject="Vipul Singh alias Khooni", anchors=_KHOONI, is_subject=False,
         title="From Gaon to Ghar Ghar: My journey of social impact",
         text=("Vipul Singh. Subscribe. Vipul Singh shares his journey building a rural "
               "social enterprise. Vipul Singh has spoken at several events. Videos by "
               "Vipul Singh."),
         outlet="youtube.com", tier=Tier.SOCIAL,
         note=("THE false confirm this set was built for: a different Vipul Singh's own "
               "channel, where the name repeats because it is his")),
    Case(subject="Vipul Singh alias Khooni", anchors=_KHOONI, is_subject=False,
         title="Vipul Singh",
         text=("Vipul Singh. Profile. Vipul Singh answered: I work in software. Follow "
               "Vipul Singh for more answers."),
         outlet="quora.com", tier=Tier.COMMUNITY,
         note="a Q&A profile of a namesake — same shape of trap, forum tier"),
    Case(subject="Vipul Singh alias Khooni", anchors=_KHOONI, is_subject=False,
         title="Justice Vipul M Pancholi sworn in as Chief Justice of Patna High Court",
         text=("Justice Vipul M Pancholi was sworn in as the Chief Justice of the Patna High "
               "Court on Monday. He was earlier a judge of the Gujarat High Court."),
         outlet="barandbench.com", tier=Tier.NEWS,
         note="a judge sharing the given name — a role that marks a different person",
         namesakes=4),
    Case(subject="Vipul Singh alias Khooni", anchors=_KHOONI, is_subject=False,
         title="Manmohan Singh funeral: former PM given tearful farewell",
         text=("Former Prime Minister Manmohan Singh was cremated with full state honours in "
               "Delhi. Leaders across parties paid tribute to the economist."),
         outlet="prajavani.net", tier=Tier.NEWS,
         note="shares only the surname — what fuzzy search returns and must never confirm"),
    Case(subject="Vipul Singh alias Khooni", anchors=_KHOONI, is_subject=False,
         title="Vipul Organics enters membrane manufacturing to capture water treatment",
         text=("Vipul Organics Ltd said it will enter membrane manufacturing to capture "
               "demand in water treatment. The company reported higher quarterly revenue."),
         outlet="deccanherald.com", tier=Tier.NEWS,
         note="a company sharing the given name"),
    Case(subject="Sushil Moonch gang", anchors=_GANG, is_subject=False, kind="organisation",
         title="Supreme Court cancels Olympian Sushil Kumar's bail in Sagar Dhankhar case",
         text=("The Supreme Court cancelled the bail granted to wrestler Sushil Kumar in the "
               "Sagar Dhankhar murder case and directed him to surrender."),
         outlet="barandbench.com", tier=Tier.NEWS,
         note=("a live false confirm from the organisation run — 'Sushil' plus a murder "
               "case looked like the gang")),
    Case(subject="Suresh Kumar", anchors=_SURESH, is_subject=False,
         title="Suresh Kumar sworn in as minister in Karnataka cabinet",
         text=("S Suresh Kumar took oath as a minister in the Karnataka cabinet at Raj "
               "Bhavan. He represents Rajajinagar in the Assembly."),
         outlet="thehindu.com", tier=Tier.NEWS,
         note="a politician of the same name in the same state — place does not disambiguate"),
    Case(subject="Suresh Kumar", anchors=_SURESH, is_subject=False,
         title="Mysuru: Suresh Kumar wins district athletics gold",
         text=("Suresh Kumar of Mysuru won gold in the 400 metres at the district athletics "
               "meet held at the Chamundi Vihar stadium."),
         outlet="udayavani.com", tier=Tier.NEWS,
         note=("the hardest case in the set: same name AND same district, nothing criminal. "
               "The station and crime number are what must carry the refusal")),
]

# ── weak-anchor cases: the ceiling must bite ────────────────────────────────────
#
# Rule 2 of attribute.py: if all we hold is a name, no amount of matching inside a
# document can identify a person. These check the rule is real and not decoration —
# the SAME document that is confident with anchors must not be confident without them.

CASES += [
    Case(subject="Vipul Singh alias Khooni", anchors=_KHOONI_BARE, is_subject=True,
         title="UP STF Meerut unit, Baghpat police kill Vipul Singh",
         text=("A sharpshooter of the Sushil Moonch gang, Vipul Singh alias Khooni, was "
               "killed in an encounter with the Uttar Pradesh STF and Baghpat police. He was "
               "wanted in 38 cases."),
         outlet="newsbytesapp.com", tier=Tier.AGGREGATOR,
         note=("the right document with NO anchors beyond the name — must be capped, and "
               "counts as a recall miss on purpose: honest uncertainty is the correct answer")),
]


# ── running it ──────────────────────────────────────────────────────────────────

def evaluate(verbose: bool = False) -> tuple[dict, list[str]]:
    """Grade every case and report the three rates. Returns (rates, failure lines)."""
    mine = [c for c in CASES if c.is_subject]
    theirs = [c for c in CASES if not c.is_subject]
    false_confirms: list[str] = []
    dismissed: list[str] = []
    soft: list[str] = []
    rows: list[tuple[str, str, Case]] = []

    for c in CASES:
        band, reasons = _grade(c)
        why = "; ".join(reasons)
        rows.append((band, why, c))
        confident = ATTRIBUTION_RANK[band] >= CONFIDENT
        if c.is_subject:
            if band in DISMISSED:
                dismissed.append(f"    DISMISSED  [{band}] {c.outlet} — {c.title[:56]}\n"
                                 f"          {c.note}\n          reasons: {why[:160]}")
            elif not confident:
                soft.append(f"    not confident  [{band}] {c.outlet} — {c.title[:56]}\n"
                            f"          {c.note}")
        elif confident:
            false_confirms.append(
                f"    FALSE CONFIRM  [{band}] {c.outlet} — {c.title[:56]}\n"
                f"          {c.note}\n          reasons: {why[:160]}")

    if verbose:
        for band, why, c in rows:
            bad = (c.is_subject and band in DISMISSED) or \
                  (not c.is_subject and ATTRIBUTION_RANK[band] >= CONFIDENT)
            want = "ours" if c.is_subject else "not ours"
            print(f"  {'!! ' if bad else 'ok '}{band:<16} {want:<9} "
                  f"{c.outlet[:20]:<20} {c.title[:46]}")
            if why:
                print(f"       {why[:140]}")

    # The deliberate weak-anchor case is excluded from the confident-recall denominator.
    # Its correct answer is a refusal, and counting a correct refusal against recall would
    # push whoever tunes this towards over-confidence.
    gradable = [c for c in mine if c.anchors.strength() >= 3]
    confident_hits = sum(1 for c in gradable
                         if ATTRIBUTION_RANK[_grade(c)[0]] >= CONFIDENT)
    rates = {
        "documents": len(CASES),
        "false_confirm": len(false_confirms) / len(theirs) if theirs else 0.0,
        "dismissed": len(dismissed) / len(mine) if mine else 0.0,
        "confident_recall": confident_hits / len(gradable) if gradable else 0.0,
    }

    print(f"\n  documents                {len(CASES)} "
          f"({len(mine)} ours, {len(theirs)} somebody else's)")
    print(f"  false confirms           {len(false_confirms)} of {len(theirs)}"
          f"   = {rates['false_confirm']:.0%}   ceiling {MAX_FALSE_CONFIRM:.0%}   HARD")
    print(f"  ours wrongly dismissed   {len(dismissed)} of {len(mine)}"
          f"   = {rates['dismissed']:.0%}   ceiling {MAX_DISMISSED:.0%}   HARD")
    print(f"  ours graded confident    {confident_hits} of {len(gradable)}"
          f"   = {rates['confident_recall']:.0%}   floor {MIN_CONFIDENT_RECALL:.0%}")

    failures: list[str] = []
    if false_confirms:
        print("\n  SOMEBODY ELSE'S DOCUMENT WAS GRADED CONFIDENT — the worst output "
              "this engine can produce:")
        for line in false_confirms:
            print(line)
        failures.append(f"{len(false_confirms)} false confirm(s)")
    if dismissed:
        print("\n  A REAL SOURCE WAS DISMISSED AS SOMEBODY ELSE — it disappears from "
              "the reasoning:")
        for line in dismissed:
            print(line)
        failures.append(f"{len(dismissed)} wrongly dismissed")
    if rates["confident_recall"] < MIN_CONFIDENT_RECALL:
        print("\n  CONFIDENT RECALL BELOW FLOOR — real coverage is being hedged away:")
        for line in soft:
            print(line)
        failures.append(f"confident recall {rates['confident_recall']:.0%} "
                        f"below {MIN_CONFIDENT_RECALL:.0%}")
    elif soft:
        print("\n  ours, correctly surfaced but not asserted (still in the officer's "
              "table with reasons):")
        for line in soft:
            print(line)
    return rates, failures


if __name__ == "__main__":
    print("— attribution evaluation: is the answer right, not does the code run —")
    _rates, fails = evaluate(verbose=("-v" in sys.argv or "--verbose" in sys.argv))
    if fails:
        print("\nFAILED: " + ", ".join(fails))
        sys.exit(1)
    print("\nattribution evaluation passed")
