"""Is this document about OUR subject, or about somebody with the same name?

This is the most consequential file in the engine. Everything else is plumbing that
finds pages; this decides what those pages mean. Get it wrong in the generous
direction and the engine manufactures a criminal history for an innocent namesake and
files it under a real person's name. That is not a degraded answer — it is the single
worst thing this software could do.

So the scoring is built around three rules.

RULE 1 — A NAME IS NOT EVIDENCE. Wikidata alone lists seven distinct notable people
called "Suresh Kumar". A name match earns a document the right to be *considered* and
nothing else.

RULE 2 — CONFIDENCE IS CAPPED BY WHAT COULD POSSIBLY DISTINGUISH. If all we hold is a
name, no amount of corroboration inside the document can make an identification, and
the band is capped accordingly. A tool that says "confirmed" on evidence incapable of
distinguishing two people is lying with a straight face.

RULE 3 — "DIFFERENT PERSON" IS A RESULT, NOT A FAILURE. Telling an officer we found
coverage and it was somebody else is genuinely useful, and materially different from
finding nothing.

The scorer is deterministic. An LLM may later *lower* a band or explain one, never
raise it — the same asymmetry a fraud helpline uses for safety, applied to identity.
"""

from __future__ import annotations

import re

from .models import ATTRIBUTION_RANK, Anchors, Attribution, Story
from .plan import name_variants, normalise_name

# Indian places that a document may pin a namesake to. Not exhaustive, and not meant
# to be: it exists so that "the Suresh Kumar in this article is in Patna" becomes a
# reason to doubt, not to be quietly ignored.
_OTHER_PLACES = {
    "mumbai", "delhi", "new delhi", "kolkata", "chennai", "hyderabad", "pune",
    "ahmedabad", "jaipur", "lucknow", "patna", "bhopal", "chandigarh", "kochi",
    "thiruvananthapuram", "coimbatore", "madurai", "visakhapatnam", "vijayawada",
    "nagpur", "indore", "surat", "kanpur", "guwahati", "bhubaneswar", "ranchi",
    "dehradun", "srinagar", "amritsar", "ludhiana", "noida", "gurugram", "gurgaon",
    "maharashtra", "gujarat", "rajasthan", "punjab", "haryana", "bihar", "odisha",
    "west bengal", "tamil nadu", "kerala", "telangana", "andhra pradesh",
    "uttar pradesh", "madhya pradesh", "assam", "jharkhand", "uttarakhand",
}

_KARNATAKA_HINTS = {
    "karnataka", "bengaluru", "bangalore", "mysuru", "mysore", "mangaluru",
    "mangalore", "hubballi", "hubli", "dharwad", "belagavi", "belgaum", "kalaburagi",
    "gulbarga", "ballari", "bellary", "davangere", "shivamogga", "shimoga", "tumakuru",
    "tumkur", "udupi", "hassan", "vijayapura", "bijapur", "raichur", "bidar",
    "chitradurga", "kolar", "mandya", "chikkamagaluru", "koppal", "haveri", "gadag",
    "bagalkote", "yadgir", "ramanagara", "chamarajanagar", "kodagu", "madikeri",
}

# "34-year-old", "aged 34", "34 years old" — the ways a report states an age.
_AGE_PATTERNS = (
    re.compile(r"\b(\d{1,3})[\s-]*year[\s-]*old\b", re.I),
    re.compile(r"\baged?\s+(\d{1,3})\b", re.I),
    re.compile(r"\b(\d{1,3})\s+years?\s+old\b", re.I),
)

#: Occupations and descriptors that Wikidata attaches to notable namesakes. When one
#: of these appears prominently and nothing of ours does, the document is probably
#: about that other person.
_NAMESAKE_HINT = re.compile(
    r"\b(botanist|researcher|professor|scientist|cricketer|footballer|actor|actress|"
    r"singer|musician|author|novelist|poet|painter|economist|historian|physician|"
    r"surgeon|astronomer|mathematician|engineer at|ceo of|founder of|mla|mp|minister)\b",
    re.I)


#: Karnataka places in Kannada script, keyed by their romanised form.
#:
#: Without this, a Kannada report about a Bengaluru incident is penalised for "not
#: mentioning Bengaluru" — it mentions ಬೆಂಗಳೂರು. Live testing graded genuine Kannada
#: Prabha coverage as `probable` rather than `confirmed` for exactly that reason, which
#: quietly demotes the local-language reporting that is often the best source there is.
_KN_PLACE: dict[str, tuple[str, ...]] = {
    "bengaluru": ("ಬೆಂಗಳೂರು", "ಬೆಂಗಳೂರಿನ"), "bangalore": ("ಬೆಂಗಳೂರು", "ಬೆಂಗಳೂರಿನ"),
    "mysuru": ("ಮೈಸೂರು", "ಮೈಸೂರಿನ"), "mysore": ("ಮೈಸೂರು", "ಮೈಸೂರಿನ"),
    "mangaluru": ("ಮಂಗಳೂರು", "ಮಂಗಳೂರಿನ"), "mangalore": ("ಮಂಗಳೂರು",),
    "hubballi": ("ಹುಬ್ಬಳ್ಳಿ",), "dharwad": ("ಧಾರವಾಡ",), "belagavi": ("ಬೆಳಗಾವಿ",),
    "kalaburagi": ("ಕಲಬುರಗಿ",), "ballari": ("ಬಳ್ಳಾರಿ",), "davangere": ("ದಾವಣಗೆರೆ",),
    "shivamogga": ("ಶಿವಮೊಗ್ಗ",), "tumakuru": ("ತುಮಕೂರು",), "udupi": ("ಉಡುಪಿ",),
    "hassan": ("ಹಾಸನ",), "vijayapura": ("ವಿಜಯಪುರ",), "raichur": ("ರಾಯಚೂರು",),
    "bidar": ("ಬೀದರ್",), "chitradurga": ("ಚಿತ್ರದುರ್ಗ",), "kolar": ("ಕೋಲಾರ",),
    "mandya": ("ಮಂಡ್ಯ",), "karnataka": ("ಕರ್ನಾಟಕ",),
}


def _place_forms(place: str) -> list[str]:
    """A place plus its Kannada-script forms, so local reporting is not penalised."""
    p = (place or "").strip()
    if not p:
        return []
    return [p, *_KN_PLACE.get(p.lower(), ())]


def _find_any(text: str, needles: list[str]) -> list[str]:
    """Whole-word, case-insensitive matches. Returns which needles were present."""
    low = text.lower()
    found = []
    for n in needles:
        n = str(n or "").strip()
        if len(n) < 3:
            continue
        if re.search(r"(?<!\w)" + re.escape(n.lower()) + r"(?!\w)", low):
            found.append(n)
    return found


def _name_present(text: str, title: str, anchors_names: list[str], subject: str) -> tuple[bool, bool]:
    """(present anywhere, present in the title).

    Title presence is weighted separately because a name in the headline is what the
    story is about, while a name in paragraph nineteen may be a passing mention of an
    investigating officer who happens to share it.
    """
    forms: list[str] = []
    for raw in [subject, *anchors_names]:
        forms.extend(name_variants(raw))
    # Also accept the surname alone inside the body: reports switch to it after first
    # mention. Not accepted as the ONLY evidence — see the scoring below.
    hit_body = bool(_find_any(text, forms))
    hit_title = bool(_find_any(title, forms))
    return hit_body, hit_title


def names_matched(text: str, title: str, names: list[str]) -> list[str]:
    """Which of the DISTINCT names we were given actually appear in this document.

    The count is the signal, and it is a strong one. A person handed to us as "Vipul
    Singh alias Khooni" gives two independent handles; a document carrying both is far
    more likely to be about them than one carrying either alone. On a live test, three
    Bollywood columns titled "Khooni Monday" matched the alias and scored exactly the
    same as the report that was actually about the subject — because matching one name
    and matching two were indistinguishable.

    Distinctness is checked on the name, not on its spelling variants, so "Vipul Singh"
    and "Vipulsingh" count once.
    """
    hay = (title or "") + "\n" + (text or "")
    out: list[str] = []
    for raw in names:
        raw = str(raw or "").strip()
        if not raw or raw in out:
            continue
        if _find_any(hay, name_variants(raw)):
            out.append(raw)
            continue
        # Fall back to every substantial token appearing somewhere, in any order.
        # Reporting drops a middle name, or writes "Vipul alias Khooni" and never the
        # full legal name, so requiring the exact phrase misses the document that is
        # most clearly about the subject. Two tokens minimum, four characters each, so
        # this cannot fire on a single common given name.
        tokens = [t for t in re.findall(r"\w{4,}", raw)]
        if len(tokens) >= 2 and all(_find_any(hay, [t]) for t in tokens):
            out.append(raw)
    return out


# Words that carry no discriminating power in a subject phrase. A topical subject is
# matched on its distinctive terms, and "market" or "case" are not distinctive.
_GENERIC_TERMS = {
    "case", "cases", "fire", "market", "police", "court", "incident", "accident",
    "attack", "fraud", "scam", "murder", "theft", "robbery", "assault", "protest",
    "riot", "blast", "crash", "raid", "arrest", "death", "deaths", "issue", "matter",
    "city", "town", "village", "district", "state", "road", "street", "area",
    "the", "and", "for", "with", "from", "into", "over", "near", "about",
}

_TOKEN = re.compile(r"[\w\u0900-\u0DFF]+", re.UNICODE)


def _subject_terms(subject: str, anchors: Anchors) -> tuple[str, list[str], list[str]]:
    """Split a topical subject into (keystone, other distinctive terms, supporting).

    "Bengaluru Kalasipalya market fire" with a Bengaluru district anchor becomes
    keystone "Kalasipalya", supporting ["Bengaluru", "market", "fire"].

    Two rules produce that, and both were learned from getting it wrong. A term that
    merely repeats an anchor is CONTEXT, not identity — otherwise every Bengaluru story
    matches a Bengaluru subject, and the engine grades a review of a Bengaluru
    restaurant as probable coverage of a market fire. And of what remains, the rarest
    term is the KEYSTONE and is required: it is the word that makes a document about this
    fire rather than any market fire.

    Length stands in for rarity. It is a crude proxy and a good one for this job —
    "Kalasipalya" is longer than "Bengaluru" is longer than "fire", which is the right
    order — and it needs no corpus, which this engine deliberately does not have.
    """
    words = [w for w in _TOKEN.findall(subject or "") if len(w) > 2]
    known_places = {p.lower() for p in (anchors.district, anchors.state, anchors.station)
                    if p} | _KARNATAKA_HINTS
    candidates = [
        w for w in words
        if len(w) >= 5 and w.lower() not in _GENERIC_TERMS and w.lower() not in known_places
    ]
    if not candidates:
        # A subject made entirely of places and generic words has no identity of its own;
        # the longest word is the best available proxy and confidence stays low.
        candidates = sorted(words, key=len, reverse=True)[:1]
    candidates.sort(key=len, reverse=True)
    keystone = candidates[0] if candidates else ""
    others = candidates[1:3]
    supporting = [w for w in words if w != keystone and w not in others]
    return keystone, others, supporting


def score_topic(story: Story, anchors: Anchors, *,
                subject: str) -> tuple[Attribution, list[str], list[str]]:
    """Grade a story about an EVENT, CRIME, ORGANISATION or TOPIC.

    A separate function because the person logic is exactly wrong here. A person is
    identified by an exact name plus corroborating facts; an event is identified by its
    distinctive terms appearing together with its place and time. Running an event
    through the name matcher requires the whole phrase to appear verbatim, which no
    newsroom ever writes, so everything grades `unrelated` — the engine reports "no
    coverage" about an event that was on every front page.
    """
    text = " ".join(d.text for d in story.documents)[:60_000]
    title = " ".join(d.title for d in story.documents)[:1000]
    haystack = f"{title} {text}"

    keystone, others, supporting = _subject_terms(subject, anchors)
    if not keystone or not _find_any(haystack, [keystone]):
        return "unrelated", [
            f"does not mention {keystone or 'the subject'}, the defining term of this "
            "subject"], []

    reasons: list[str] = [f"mentions {keystone}"]
    matched = ["subject_term"]
    points = 4

    hit_others = _find_any(haystack, others)
    if hit_others:
        points += 2 * min(len(hit_others), 2)
        matched.append("subject_detail")
        reasons.append("along with " + ", ".join(hit_others[:2]))

    hit_support = _find_any(haystack, supporting)
    if hit_support:
        points += min(len(hit_support), 2)
        reasons.append("in context of " + ", ".join(hit_support[:3]))
        matched.append("subject_context")

    in_title = bool(_find_any(title, [keystone]))
    if in_title:
        points += 2
        matched.append("headline")
        reasons.append("the subject is in the headline")

    if anchors.district and _find_any(haystack, _place_forms(anchors.district)):
        points += 2
        matched.append("district")
        reasons.append(f"places it in {anchors.district}")
    elif anchors.district:
        # A market fire in another city is a different market fire.
        points -= 2
        reasons.append(f"does not mention {anchors.district}")

    if anchors.crime_numbers and _find_any(haystack, anchors.crime_numbers):
        points += 5
        matched.append("crime_number")
        reasons.append("cites our case number")

    band: Attribution = "confirmed" if points >= 9 else (
        "probable" if points >= 5 else "possible")
    return band, reasons, sorted(set(matched))


def score(story: Story, anchors: Anchors, *, subject: str,
          namesakes: int = 0) -> tuple[Attribution, list[str], list[str]]:
    """Grade one story. Returns (band, human reasons, matched anchor names).

    The reasons are shown to the officer verbatim. That is deliberate: an
    identification the officer cannot audit is an identification they should not act
    on, and "matched the FIR number and the station" is checkable in a way that a
    confidence percentage never is.
    """
    doc = story.lead
    text = " ".join(d.text for d in story.documents)[:60_000]
    title = " ".join(d.title for d in story.documents)[:1000]

    reasons: list[str] = []
    matched: list[str] = []
    points = 0

    in_body, in_title = _name_present(text, title, anchors.names, subject)
    if not in_body and not in_title:
        return "unrelated", ["the subject's name does not appear in this document"], []

    matched.append("name")
    if in_title:
        points += 1
        reasons.append("the name appears in the headline")
    else:
        reasons.append("the name appears in the text")

    # Two of the caller's distinct names in one document — a legal name and an alias —
    # is the strongest identity evidence available when we hold no case anchors at all,
    # and it is what separates a report about the subject from a coincidental match on
    # the alias alone.
    present_names = names_matched(text, title, anchors.names)
    if len(present_names) >= 2:
        points += 4
        matched.append("alias")
        reasons.append("names both " + " and ".join(present_names[:2]))

    # ── discriminating anchors ──────────────────────────────────────────────────
    hits_cn = _find_any(text, anchors.crime_numbers)
    if hits_cn:
        points += 6
        matched.append("crime_number")
        reasons.append(f"cites our case number {hits_cn[0]}")

    hits_assoc = _find_any(text, anchors.associates)
    if hits_assoc:
        points += 3 * min(len(hits_assoc), 2)
        matched.append("associate")
        reasons.append("names a known associate: " + ", ".join(hits_assoc[:2]))

    hits_org = _find_any(text, anchors.organisations)
    if hits_org:
        points += 3
        matched.append("organisation")
        reasons.append(f"names the linked organisation {hits_org[0]}")

    if anchors.station and _find_any(text, [anchors.station]):
        points += 3
        matched.append("station")
        reasons.append(f"names {anchors.station} police station")

    if anchors.district and _find_any(text, _place_forms(anchors.district)):
        points += 2
        matched.append("district")
        reasons.append(f"places it in {anchors.district}")

    hits_sec = _find_any(text, anchors.sections)
    if hits_sec:
        points += 1
        matched.append("section")
        reasons.append("cites section " + ", ".join(hits_sec[:2]))

    if anchors.age:
        for rx in _AGE_PATTERNS:
            m = rx.search(text)
            if m:
                try:
                    stated = int(m.group(1))
                except ValueError:
                    continue
                # A window, because a report's age is as of publication and ours is as
                # of the record. Outside the window it is a point AGAINST the match.
                if abs(stated - anchors.age) <= 3:
                    points += 2
                    matched.append("age")
                    reasons.append(f"states an age of {stated}, consistent with {anchors.age}")
                else:
                    points -= 2
                    reasons.append(
                        f"states an age of {stated}, which does not match {anchors.age}")
                break

    # ── evidence against ────────────────────────────────────────────────────────
    # A place only CONTRADICTS if we hold a place to contradict. This used to assume
    # every subject was a Karnataka subject and penalised any document located
    # elsewhere — so a correct report about a wanted man in Baghpat, retrieved on a
    # search with no place anchor at all, was graded `different_person` for the crime of
    # being about Uttar Pradesh. You cannot contradict a claim you never made.
    ours_forms: set[str] = set()
    if anchors.district:
        ours_forms.update(_place_forms(anchors.district))
    if anchors.state:
        ours_forms.update(_place_forms(anchors.state))
        if anchors.state.strip().lower() == "karnataka":
            ours_forms.update(f for p in _KARNATAKA_HINTS for f in _place_forms(p))
    contradicted = False
    if ours_forms and "crime_number" not in matched:
        ours_lower = {f.lower() for f in ours_forms}
        elsewhere = [p for p in _find_any(text[:6000], sorted(_OTHER_PLACES))
                     if p.lower() not in ours_lower]
        # Kannada script included: a local report saying ಬೆಂಗಳೂರು is a Karnataka
        # connection, and reading it as absent would push genuine local coverage toward
        # "different person".
        ours_present = bool(_find_any(text[:6000], sorted(ours_forms)))
        if elsewhere and not ours_present:
            contradicted = True
            points -= 3
            where = anchors.district or anchors.state
            reasons.append(
                f"located in {elsewhere[0].title()} with no {where} connection mentioned")

    namesake_role = _NAMESAKE_HINT.search(title) or _NAMESAKE_HINT.search(text[:1500])
    if namesake_role and len(matched) == 1:
        contradicted = True
        reasons.append(
            f"describes a {namesake_role.group(0).lower()}, which matches a different "
            "person of the same name")

    # ── band, capped by what our anchors could possibly distinguish ─────────────
    strength = anchors.strength()
    band: Attribution
    if contradicted and points <= 1:
        band = "different_person"
    elif points >= 8:
        band = "confirmed"
    elif points >= 4:
        band = "probable"
    else:
        band = "possible"

    # RULE 2, stated even when it did not bite. An officer reading a `possible` needs to
    # know WHICH problem they are looking at: a document that weakly matches a
    # well-identified subject, or a document that matches perfectly well but against a
    # subject we hold nothing distinguishing about. Those call for opposite next steps —
    # discard the source, or go and find an anchor — so the difference is spelled out.
    if strength < 3 and band != "unrelated":
        reasons.append(
            "we hold nothing about this subject beyond a name, so no source can be "
            "matched to them with confidence — an FIR number, a station or an "
            "associate would change that")

    # With weak anchors nothing inside a document can identify a person, so the ceiling
    # comes down regardless of how much matched.
    if band in {"confirmed", "probable"}:
        ceiling: Attribution = "confirmed" if strength >= 6 else (
            "probable" if strength >= 3 else "possible")
        if ATTRIBUTION_RANK[band] > ATTRIBUTION_RANK[ceiling]:
            band = ceiling
            reasons.append(
                "capped: the facts we hold about this subject could not distinguish "
                "two people of the same name")

    # A great many namesakes is itself a reason for caution when nothing but the name
    # matched.
    if namesakes >= 3 and len(matched) == 1 and band != "different_person":
        band = "possible"
        reasons.append(f"{namesakes} different public figures share this name")

    story.score = points
    return band, reasons, sorted(set(matched))


#: Subject kinds graded as a person (exact name + corroborating facts) rather than as a
#: topic (distinctive terms + place). An identifier is person-like because a UPI handle
#: or a phone number is exact and unique — matching it verbatim is the whole job.
PERSON_LIKE = {"person", "identifier"}


def apply(stories: list[Story], anchors: Anchors, *, subject: str,
          namesakes: int = 0, kind: str = "person") -> list[Story]:
    person_like = (kind or "person").lower() in PERSON_LIKE
    for s in stories:
        if person_like:
            band, reasons, matched = score(s, anchors, subject=subject, namesakes=namesakes)
        else:
            band, reasons, matched = score_topic(s, anchors, subject=subject)
        s.attribution = band
        s.attribution_reasons = reasons
        s.matched_anchors = matched
    # Band first, then how much actually matched, then authority, then recency. The
    # score has to come before the tier: the summary reads from the top of this list, and
    # ordering by authority alone let a court record sharing nothing but a name outrank
    # the one report that named both the subject and his alias.
    stories.sort(key=lambda s: (-ATTRIBUTION_RANK[s.attribution], -s.score,
                                int(s.tier), s.lead.published or "0000"))
    return stories


def admissible(story: Story, *, independent_outlets: int) -> tuple[bool, str]:
    """May this story's claims enter the AI summary?

    Deliberately generous, and that is a change of posture. It used to require
    `probable` plus corroboration, which meant a subject with only weak matches got an
    EMPTY summary — the engine had found and read material about a similarly-named
    person and said nothing about it. For a research tool whose user cross-checks
    everything, silence is the least useful of the available answers.

    So the rule is now: anything the engine believes could be this subject is
    summarisable, and its confidence travels with it into the prose (see
    `claims.confidence_label`), where every sentence must state how strongly it is
    attributed. What remains excluded is only what is positively about somebody else —
    summarising that as though it were the subject is not caution, it is error.
    """
    if story.attribution in {"different_person", "unrelated"}:
        return False, f"attribution is {story.attribution}"
    return True, ""


def confidence_note(story: Story, *, independent_outlets: int) -> str:
    """One short phrase telling the model how much to trust this story.

    This is what replaces the old gate. The information the gate used to act on — band,
    source authority, whether anyone else reported it independently — is not thrown
    away, it is handed to the summariser so it can qualify each sentence instead of the
    sentence being deleted.
    """
    band = {
        "confirmed": "confirmed as this subject",
        "probable": "probably this subject",
        "possible": "POSSIBLY this subject, unverified",
    }.get(story.attribution, story.attribution)
    authority = "official source" if int(story.tier) == 1 else (
        "established newsroom" if int(story.tier) == 2 else "lower-authority source")
    corroboration = (f"{independent_outlets} independent outlets"
                     if independent_outlets >= 2 else "single outlet, uncorroborated")
    return f"{band}; {authority}; {corroboration}"
