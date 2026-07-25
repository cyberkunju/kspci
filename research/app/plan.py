"""Turning one question into the queries that will actually find things.

Two ideas do the work here.

FIRST, ANCHORS GO INTO THE QUERY, not just into the scoring. Searching for
"Suresh Kumar" and then filtering the results is the slow, expensive way to meet a
namesake; searching for "Suresh Kumar" Mysuru and "Suresh Kumar" alongside a
co-accused's name finds the right person directly. Every discriminating fact we
already hold becomes a query.

SECOND, SPELLING IS NOT STABLE. Indian names romanise many ways — Suresh /
Sureshkumar / S. Kumar, Reddy / Reddi, Krishnamurthy / Krishnamurti — and a
newsroom's spelling is whatever the reporter typed. A search for one spelling is a
search for one slice of the coverage, so variants are generated deterministically
and bounded.

What this module deliberately does NOT do is transliterate a Latin-script name into
Kannada script. Doing that correctly needs a phonetic model and doing it badly
produces queries that match nothing while looking like coverage was checked. Kannada
coverage is reached three other honest ways: the Kannada outlets are queried directly
by their own search, GDELT indexes Kannada sources and reports their language, and a
caller who holds a Kannada-script name can pass it in as another anchor name.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .models import Anchors

#: Which discovery routes a query should be sent to. Not every query suits every
#: source: an on-site newsroom search wants a short human phrase, while GDELT wants
#: one rich boolean and is rate-limited to a couple of calls per run.
Route = str
ALL_NEWS: tuple[Route, ...] = ("gdelt", "onsite", "searxng", "marginalia")
ONSITE_ONLY: tuple[Route, ...] = ("onsite",)
WEB: tuple[Route, ...] = ("searxng", "marginalia", "mojeek")
REFERENCE: tuple[Route, ...] = ("wikipedia",)


@dataclass
class Query:
    text: str
    routes: tuple[Route, ...] = ALL_NEWS
    purpose: str = ""
    #: Anchors this query already pins. A hit from a query that pinned the FIR number
    #: is far likelier to be our subject than a hit from a bare-name query, and the
    #: attribution stage is told so.
    pins: tuple[str, ...] = ()
    weight: float = 1.0


@dataclass
class GdeltPlan:
    """GDELT is queried differently from everything else, on purpose.

    One request every five seconds, up to 250 records per call. So instead of many
    narrow queries we send one or two broad ones: the subject as a required term, and
    everything that would corroborate it as an OR group.
    """

    must: list[str] = field(default_factory=list)
    any_of: list[str] = field(default_factory=list)
    #: GDELT DOC 2.0 searches a ROLLING THREE-MONTH WINDOW. `timespan` can only narrow
    #: it — a larger value is silently clamped, so asking for "24months" is a statement
    #: in our code that reads like coverage and is not.
    timespan: str = "3months"
    #: Absolute window, YYYYMMDDHHMMSS. Only set when the case period falls INSIDE
    #: GDELT's three months, because the API rejects anything older.
    start: str = ""
    end: str = ""
    #: True when the case predates GDELT's window entirely. GDELT is still queried —
    #: a chargesheet or a verdict reported this month about a 2019 offence is inside the
    #: window and is exactly what an officer wants — but the run must SAY that the
    #: breadth tier could not reach the incident period. Otherwise a structural blind
    #: spot presents as "no coverage exists", which is the most misleading answer this
    #: engine can give.
    out_of_range: str = ""


# ── name variants ───────────────────────────────────────────────────────────────

# Romanisation pairs that genuinely alternate in Indian English. Each is applied
# once, in one direction, to keep the variant count small and every variant plausible.
_SWAPS: tuple[tuple[str, str], ...] = (
    ("ee", "i"), ("oo", "u"), ("aa", "a"), ("th", "t"), ("dh", "d"),
    ("ksh", "x"), ("v", "w"), ("y", "i"), ("sh", "s"), ("ph", "f"),
)

_TITLES = re.compile(
    r"^\s*(?:mr|mrs|ms|dr|shri|sri|smt|kum|sh|md|hon'?ble|justice|adv|advocate|"
    r"psi|si|asi|ci|dysp|sp|dcp|acp|ips|ias)\.?\s+", re.I)

_KANNADA = re.compile(r"[\u0C80-\u0CFF]")


_KEEP_PUNCT = set(" .@'-")


def normalise_name(raw: str) -> str:
    """Strip honorifics and punctuation noise, keeping the name itself intact.

    Character filtering is category-aware rather than `\\w`-based. Python's `\\w` is
    alphanumeric, and Kannada vowel signs and the virama are combining MARKS, not
    alphanumerics — so a `\\w` filter silently shreds ಸುರೇಶ್ ಕುಮಾರ್ into disconnected
    consonants and every subsequent query matches nothing while appearing to have been
    run. Marks are preserved explicitly.
    """
    import unicodedata

    n = _TITLES.sub("", str(raw or "").strip())
    kept = [
        c for c in n
        if c.isalnum() or unicodedata.category(c).startswith("M") or c in _KEEP_PUNCT
    ]
    return " ".join("".join(kept).split())


def name_variants(raw: str, *, limit: int = 5) -> list[str]:
    """Plausible alternative spellings and forms of one name, most likely first.

    Bounded hard. Each extra variant is another set of queries against every source,
    and the tail of a variant list is mostly noise — a name spelled five ways has
    already covered the realistic newsroom spellings.
    """
    base = normalise_name(raw)
    if not base:
        return []
    # A name already in Kannada script needs no romanisation variants; it is used
    # verbatim, which is exactly what the Kannada outlets want.
    if _KANNADA.search(base):
        return [base]

    out: list[str] = [base]
    parts = base.split()

    if len(parts) >= 2:
        # "Suresh Kumar" -> "Sureshkumar": extremely common in Indian records, and a
        # different string to every search engine.
        joined = "".join(parts)
        if len(joined) <= 24:
            out.append(joined)
        # "Suresh Kumar" -> "S Kumar": how bylines and charge sheets often render it.
        out.append(f"{parts[0][0]} {parts[-1]}")

    lowered = base.lower()
    for a, b in _SWAPS:
        if a in lowered:
            swapped = re.sub(a, b, base, flags=re.I, count=1)
            if swapped.lower() != lowered:
                out.append(swapped)
                break  # one phonetic variant is enough; more is combinatorial noise

    seen: set[str] = set()
    unique: list[str] = []
    for n in out:
        k = n.lower()
        if k and k not in seen:
            seen.add(k)
            unique.append(n)
    return unique[:limit]


# ── query planning ──────────────────────────────────────────────────────────────

# Words that turn a neutral lookup into a leading one. A query for "X fraud" biases
# every engine toward pages that say fraud, which is how a legitimate person acquires
# a reputation they do not have. The subject is searched neutrally FIRST; loaded terms
# only ever appear in explicitly-labelled allegation queries.
_LOADED = re.compile(
    r"\b(scam|fraud|fraudulent|cheat(?:ing|er)?|accused|criminal|crook|gang|"
    r"launder(?:ing)?|terror(?:ist)?|corrupt(?:ion)?)\b", re.I)

#: Neutral event words. These describe what a report would SAY, not what we conclude.
_EVENT_TERMS = ("arrested", "arrest", "chargesheet", "charge sheet", "FIR",
                "police case", "court", "judgment", "bail", "convicted", "acquitted")


def neutralise(text: str) -> str:
    """Strip conclusion-shaped words from a subject before it becomes a query."""
    return " ".join(_LOADED.sub(" ", str(text or "")).split())


# GDELT's DOC 2.0 full-text API searches a rolling window of the last three months.
# Its archive reaches back to 1 January 2017, but the *search* API does not: a request
# outside the rolling window is documented as invalid. Ninety-two days leaves a little
# margin against clock skew and against the window advancing mid-run.
_GDELT_WINDOW_DAYS = 92

_DATE = re.compile(r"(\d{4})\D(\d{1,2})\D(\d{1,2})|(\d{1,2})\D(\d{1,2})\D(\d{4})")


def _as_date(raw: str) -> tuple[int, int, int] | None:
    """Read a date out of either YYYY-MM-DD or DD-MM-YYYY. Returns None if neither.

    Both shapes occur: the Data Store holds registration dates as text, and an officer
    typing a window by hand will write whichever they are used to.
    """
    m = _DATE.search(str(raw or ""))
    if not m:
        return None
    if m.group(1):
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    else:
        d, mo, y = int(m.group(4)), int(m.group(5)), int(m.group(6))
    if not (1900 <= y <= 2100 and 1 <= mo <= 12 and 1 <= d <= 31):
        return None
    return y, mo, d


def gdelt_window(date_from: str, date_to: str = "") -> tuple[str, str, str]:
    """Turn a case's dates into a GDELT window, or into an honest admission.

    Returns `(start, end, out_of_range_note)`.

    The window opens sixty days BEFORE the case date, because reporting routinely
    precedes registration — a body is found and reported, the FIR follows.

    When the case predates GDELT's rolling three months, no absolute window is sent:
    the API would reject it, and reading the resulting empty answer as an absence of
    coverage is the failure this whole module exists to prevent. Instead a note comes
    back for the run report. GDELT is still queried over its own window, because recent
    reporting about an old offence — the chargesheet, the trial, the verdict — is inside
    that window and is often the most useful thing there is.

    `date_to` deliberately does not close the window, for the same reason.
    """
    import datetime as _dt

    got = _as_date(date_from)
    if not got:
        return "", "", ""
    try:
        case_day = _dt.date(*got)
    except ValueError:
        return "", "", ""

    start = case_day - _dt.timedelta(days=60)
    earliest = _dt.date.today() - _dt.timedelta(days=_GDELT_WINDOW_DAYS)
    if start < earliest:
        return "", "", (
            f"GDELT indexes only the last three months, which does not reach "
            f"{case_day.isoformat()}; its contribution covers recent reporting about "
            "this subject, not the incident period. Coverage of the period came from "
            "the newsrooms' own search.")
    return start.strftime("%Y%m%d") + "000000", "", ""


def plan_queries(*, subject: str, kind: str, anchors: Anchors,
                 max_queries: int = 14) -> tuple[list[Query], GdeltPlan]:
    """Build the query set and the GDELT plan for one run.

    Ordering matters: the list is returned most-discriminating first, so that when a
    run hits its deadline it has spent its budget on the queries most likely to have
    found the right person rather than on the broadest ones.
    """
    subject = " ".join(str(subject or "").split())
    names = [subject] if kind == "person" else []
    names += [n for n in anchors.names if n]
    variants: list[str] = []
    for n in names:
        for v in name_variants(n):
            if v.lower() not in {x.lower() for x in variants}:
                variants.append(v)
    variants = variants[:5]
    primary = variants[0] if variants else neutralise(subject)

    q: list[Query] = []

    def add(text: str, routes: tuple[Route, ...], purpose: str,
            pins: tuple[str, ...] = (), weight: float = 1.0) -> None:
        text = " ".join(str(text or "").split())
        if not text or len(text) < 3:
            return
        if any(x.text.lower() == text.lower() for x in q):
            return
        q.append(Query(text=text, routes=routes, purpose=purpose, pins=pins, weight=weight))

    if kind == "identifier":
        # An identifier is already unique. Quoting it is the whole trick, and there is
        # nothing to disambiguate.
        add(f'"{subject}"', ALL_NEWS, "the identifier itself", ("identifier",), 3.0)
        add(f'"{subject}" complaint', WEB + ONSITE_ONLY, "complaints naming it", ("identifier",), 2.0)
        start, end, note = gdelt_window(anchors.date_from, anchors.date_to)
        gdelt = GdeltPlan(must=[subject], any_of=list(_EVENT_TERMS[:6]),
                          start=start, end=end, out_of_range=note)
        return q[:max_queries], gdelt

    # ── most discriminating first: an identifier we already hold ────────────────
    for cn in anchors.crime_numbers[:3]:
        add(f'"{primary}" "{cn}"', ALL_NEWS, "subject with our own case number",
            ("name", "crime_number"), 4.0)
        add(f'"{cn}"', ALL_NEWS, "the case number alone", ("crime_number",), 3.0)

    # ── a co-accused or a linked organisation is nearly as good ─────────────────
    for a in anchors.associates[:3]:
        add(f'"{primary}" "{a}"', ALL_NEWS, "subject with a known associate",
            ("name", "associate"), 3.0)
    for o in anchors.organisations[:2]:
        add(f'"{primary}" "{o}"', ALL_NEWS, "subject with a linked organisation",
            ("name", "organisation"), 3.0)

    # ── place pins the person to our jurisdiction ─────────────────────────────
    if anchors.station:
        add(f'"{primary}" "{anchors.station}"', ALL_NEWS, "subject with the station",
            ("name", "station"), 2.5)
    if anchors.district:
        add(f'"{primary}" {anchors.district}', ALL_NEWS, "subject in the district",
            ("name", "district"), 2.0)
        add(f'"{primary}" {anchors.district} police', ALL_NEWS,
            "subject in district police reporting", ("name", "district"), 1.8)
    elif anchors.state:
        add(f'"{primary}" {anchors.state}', ALL_NEWS, "subject in the state",
            ("name", "state"), 1.5)

    # ── the neutral baseline, always present ───────────────────────────────────
    # Run even when anchors are rich: it is the only query that can reveal coverage
    # nobody thought to look for, and it is what makes an empty result honest.
    add(f'"{primary}"', ALL_NEWS, "the subject, neutrally", ("name",), 1.2)
    if kind == "person":
        add(f'"{primary}"', REFERENCE, "is this a publicly known person", ("name",), 1.0)

    # ── event-shaped queries, clearly labelled as such ─────────────────────────
    place = anchors.district or anchors.state
    add(f'"{primary}" arrested {place}'.strip(), ALL_NEWS, "reports of an arrest",
        ("name",), 1.4)
    add(f'"{primary}" court case {place}'.strip(), ALL_NEWS, "court reporting",
        ("name",), 1.3)

    # ── remaining spelling variants, at lower weight ───────────────────────────
    for v in variants[1:4]:
        add(f'"{v}" {place}'.strip(), ALL_NEWS, f"alternative spelling: {v}",
            ("name_variant",), 1.0)

    # ── a crime or event subject is not a person ───────────────────────────────
    if kind in {"crime", "event", "organisation"}:
        add(f'{neutralise(subject)} {place}'.strip(), ALL_NEWS, "the event in place", (), 2.0)
        for s in anchors.sections[:2]:
            add(f'{neutralise(subject)} "{s}"', ALL_NEWS, "the event under a section", (), 1.5)

    q.sort(key=lambda x: -x.weight)

    # GDELT gets ONE broad query carrying the whole subject: the required term plus
    # every corroborating fact as alternatives. One call, up to 250 records.
    start, end, note = gdelt_window(anchors.date_from, anchors.date_to)
    gdelt = GdeltPlan(
        must=[primary],
        any_of=[x for x in (
            anchors.district, anchors.state, anchors.station,
            *anchors.crime_numbers[:2], *anchors.associates[:2], *anchors.organisations[:2],
            *_EVENT_TERMS[:5],
        ) if x],
        start=start, end=end, out_of_range=note,
    )
    return q[:max_queries], gdelt
