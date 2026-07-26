"""End-to-end checks for the pipeline and the HTTP surface, with no network.

The module suites cover the parts in isolation. What they cannot show is the thing
that actually breaks in a pipeline of nine stages: a stage that works alone but is
handed the wrong shape, or a deadline that is checked but not respected, or an auth
gate that is present but bypassable. Those are what this file is for.

Discovery and retrieval are replaced with canned data — not to make the test fast, but
because a test that depends on what a newsroom published today is a test that fails for
reasons unrelated to our code. The live behaviour of the adapters is verified by
actually running the engine against real sources; this verifies the wiring.

Run: python -m app.selftest_pipeline
"""

from __future__ import annotations

import asyncio
import sys

from . import pipeline as pipe
from . import sources
from .config import Budget
from .models import Anchors, Hit, Tier
from .plan import gdelt_window, plan_queries

FAILS: list[str] = []


def check(label: str, cond: bool, detail: str = "") -> None:
    print(f"{'ok  ' if cond else 'FAIL'} {label}" + (f"  [{detail}]" if detail else ""))
    if not cond:
        FAILS.append(label)


def head(title: str) -> None:
    print(f"\n— {title} —")


# ── canned world ────────────────────────────────────────────────────────────────

_PAGE = (
    "<html><head><title>{title}</title></head><body><article>"
    "<p>{body}</p>"
    "</article></body></html>"
)

# Two genuinely independent English reports, not two copies of one wire story. That
# distinction is the point of the clustering stage, so the fixture has to honour it:
# byte-identical bodies would correctly collapse into one story and the test would be
# asserting against its own mistake.
_BODY_HINDU = (
    "Mysuru police arrested Suresh Kumar, 34, on Tuesday in connection with a cheating "
    "case registered at Vijayanagar police station. Police said the accused had been "
    "absconding since the complaint was filed in Mysuru. The Mysuru city police "
    "commissioner said a chargesheet would be filed within ninety days of the arrest. "
    "Investigators told reporters that a second accused, Manjunath, was also named in "
    "the first information report filed at the same station in Mysuru district."
)

_BODY_DH = (
    "A 34-year-old man wanted in a cheating complaint was taken into custody in Mysuru "
    "on Tuesday evening, officers at Vijayanagar police station confirmed. The man, "
    "identified as Suresh Kumar, had evaded questioning for several weeks, according to "
    "an investigating officer who spoke on condition of anonymity. A relative named "
    "Manjunath is being questioned separately. The Mysuru district police plan to seek "
    "custody for further examination of bank records seized during the search."
)

_BODY_KANNADA = (
    "ಮೈಸೂರು ನಗರದ ವಿಜಯನಗರ ಪೊಲೀಸ್ ಠಾಣೆಯಲ್ಲಿ ದಾಖಲಾಗಿದ್ದ ವಂಚನೆ ಪ್ರಕರಣದಲ್ಲಿ ಆರೋಪಿಯನ್ನು "
    "ಮಂಗಳವಾರ ಬಂಧಿಸಲಾಗಿದೆ ಎಂದು ಪೊಲೀಸರು ತಿಳಿಸಿದ್ದಾರೆ. ದೂರು ದಾಖಲಾದ ಬಳಿಕ ಆರೋಪಿ "
    "ತಲೆಮರೆಸಿಕೊಂಡಿದ್ದನು. ಪ್ರಕರಣದಲ್ಲಿ ಇನ್ನೊಬ್ಬ ಆರೋಪಿಯನ್ನೂ ಹೆಸರಿಸಲಾಗಿದೆ ಎಂದು ತನಿಖಾಧಿಕಾರಿಗಳು "
    "ಹೇಳಿದ್ದಾರೆ. ಮೈಸೂರು ಜಿಲ್ಲಾ ಪೊಲೀಸರು ಬ್ಯಾಂಕ್ ದಾಖಲೆಗಳನ್ನು ಪರಿಶೀಲಿಸುತ್ತಿದ್ದಾರೆ."
)

_BODY_OTHER = (
    "The state cricket association announced its squad for the upcoming season on "
    "Monday. The selectors named eleven players and four reserves after two days of "
    "trials held at the university ground. The association said the season would begin "
    "in the second week of next month with a match against the neighbouring state."
)

_MATCH_URLS = (
    "https://www.thehindu.com/news/cities/mysuru/man-held-in-mysuru-cheating-case-12345/",
    "https://www.deccanherald.com/india/karnataka/suresh-kumar-arrested-mysuru-98765/",
)
_KANNADA_URL = "https://www.prajavani.net/district/mysuru/cheating-case-arrest-55501/"
_OTHER_URL = "https://example.com/sport/state-squad-announced-2211/"

_WORLD: dict[str, tuple[str, str]] = {
    _MATCH_URLS[0]: ("Man held in Mysuru cheating case", _BODY_HINDU),
    _MATCH_URLS[1]: ("Suresh Kumar arrested in Mysuru", _BODY_DH),
    _KANNADA_URL: ("ಮೈಸೂರು ವಂಚನೆ ಪ್ರಕರಣ: ಆರೋಪಿ ಬಂಧನ", _BODY_KANNADA),
    _OTHER_URL: ("State squad announced for new season", _BODY_OTHER),
}


class _FakeFetcher:
    """Stands in for net.Fetcher. Answers only from the canned world.

    Anything not in the world returns a 404 with no body, which is deliberate: the
    pipeline must present an unreadable source as an unreadable source rather than
    dropping it, and that path needs covering too.
    """

    def __init__(self) -> None:
        self.calls: list[str] = []

    async def get(self, url: str, **kw) -> dict:
        self.calls.append(url)
        page = _WORLD.get(url)
        if page is None:
            return {"status": 404, "content": b"", "content_type": "", "final_url": url,
                    "error": "http 404"}
        html = _PAGE.format(title=page[0], body=page[1]).encode("utf-8")
        return {"status": 200, "content": html, "content_type": "text/html; charset=utf-8",
                "final_url": url, "error": ""}

    async def get_json(self, url: str, **kw):
        return None

    async def close(self) -> None:
        return None


def _canned_hits() -> list[Hit]:
    return [
        Hit(url=u, title=t, via="onsite:thehindu", tier=Tier.NEWS,
            language="kn" if "prajavani" in u else "en")
        for u, (t, _b) in _WORLD.items()
    ] + [
        # A hit the fetcher cannot read. Must survive into the report as a link.
        Hit(url="https://www.newindianexpress.com/states/karnataka/gone-1/",
            title="Removed report", via="gdelt", tier=Tier.NEWS),
    ]


def _install_fakes() -> None:
    pipe.Fetcher = _FakeFetcher  # type: ignore[assignment]

    async def _discover(f, queries, gdelt_plan, budget, dl, progress):
        notes = [gdelt_plan.out_of_range] if gdelt_plan.out_of_range else []
        return (_canned_hits(), ["gdelt (rate limited in test)"],
                {"onsite:thehindu": 4}, notes)

    pipe._discover = _discover  # type: ignore[assignment]

    async def _no_namesakes(f, name, **kw):
        return []

    sources.wikidata_candidates = _no_namesakes  # type: ignore[assignment]


BUDGET = Budget("test", wall_s=20, max_queries=8, max_hits=40, max_fetch=10,
                max_rounds=1, fetch_concurrency=4, llm_calls=0)

ANCHORS = Anchors(names=["Suresh Kumar"], district="Mysuru", state="Karnataka",
                  station="Vijayanagar", age=34, crime_numbers=["118/2023"],
                  associates=["Manjunath"], date_from="2023-04-11")


# ── the run ─────────────────────────────────────────────────────────────────────

def test_run() -> None:
    head("a whole run, no model, no network")
    _install_fakes()
    stages: list[str] = []

    async def progress(stage, message, data):
        stages.append(stage)

    out = asyncio.run(pipe.run(subject="Suresh Kumar", kind="person", anchors=ANCHORS,
                               budget=BUDGET, progress=progress))

    check("the run completed", not out.partial, f"stages={out.stages}")
    check("every stage ran", {"plan", "discover", "retrieve", "cluster", "attribute"}
          <= set(out.stages), str(out.stages))
    check("progress was reported", "attribute" in stages, str(sorted(set(stages))))

    urls = {f.url for f in out.findings}
    check("every candidate appears in the report", len(out.findings) >= 5,
          f"{len(out.findings)} findings")
    check("the unreadable source is still a link the officer can open",
          any("gone-1" in u for u in urls))
    check("the unreadable source says why", any(
        f.error and "404" in f.error for f in out.findings))

    bands = {f.url: f.attribution for f in out.findings}
    matched = [u for u in _MATCH_URLS if bands.get(u) in {"confirmed", "probable"}]
    check("both independent reports are attributed to the subject", len(matched) == 2,
          f"{matched or bands}")
    check("two independent reports are two stories, not one",
          all(u in bands for u in _MATCH_URLS),
          f"{len(out.findings)} findings")
    check("the cricket report is not attributed to him", bands.get(_OTHER_URL) == "unrelated",
          str(bands.get(_OTHER_URL)))

    check("attribution states its reasons",
          all(f.why for f in out.findings if f.attribution != "unrelated"))
    # Counted from the page's own script, not from what the discovery adapter guessed.
    # A Kannada outlet publishing an English wire copy is an English source.
    check("Kannada coverage is counted", out.counts.get("kannada_sources") == 1,
          str(out.counts.get("kannada_sources")))
    check("and the Kannada report reaches the officer's list", _KANNADA_URL in bands)
    check("syndication is collapsed into stories",
          out.counts["stories"] <= out.counts["readable"],
          f"{out.counts['stories']} stories from {out.counts['readable']} readable")

    check("no summary is written without a model", out.summary == "")
    check("and the absence is stated, not hidden",
          any("no model" in w for w in out.warnings), str(out.warnings[:2]))
    # An unrelated story needs no warning: it is already in the table with its band and
    # its reasons, and one line per unrelated story buries the warnings that matter.
    check("unrelated stories are not each reported as a warning",
          not any("unrelated" in w for w in out.warnings), str(out.warnings))
    check("a failed source tier is reported", any("gdelt" in s for s in out.sources_failed),
          str(out.sources_failed))
    # ANCHORS is a 2023 case, so GDELT's rolling three months cannot reach it. The run
    # must say so: a tier that cannot cover the period is a limit, not an absence.
    check("a tier that cannot reach the case period says so",
          any("three months" in w for w in out.warnings), str(out.warnings))
    check("the disclaimer travels with the result", "not evidence" in out.disclaimer)


def test_deadline() -> None:
    head("the deadline is enforced, not hoped for")
    _install_fakes()
    tiny = Budget("tiny", wall_s=0, max_queries=4, max_hits=10, max_fetch=10,
                  max_rounds=1, fetch_concurrency=2, llm_calls=0)
    out = asyncio.run(pipe.run(subject="Suresh Kumar", kind="person", anchors=ANCHORS,
                               budget=tiny))
    check("an expired budget returns partial rather than hanging", out.partial)
    check("and it still returns a result object", out.subject == "Suresh Kumar")


def test_prefilter() -> None:
    head("relevance ordering before the fetch budget is spent")
    hits = [
        Hit(url="https://x.com/a-front-page-story-today-1/", title="Cabinet reshuffle likely"),
        Hit(url="https://x.com/b-2/", title=""),
        Hit(url="https://x.com/c-3/", title="Suresh Kumar held in Mysuru case"),
    ]
    order = [h.url for h in pipe._prefilter(hits, ["Suresh Kumar", "Mysuru"])]
    check("a title that matches is read first", "c-3" in order[0], order[0])
    check("an unknown title beats a known mismatch",
          order.index("https://x.com/b-2/") < order.index("https://x.com/a-front-page-story-today-1/"))
    check("nothing is discarded", len(order) == 3)


# ── the GDELT window ────────────────────────────────────────────────────────────

def test_window() -> None:
    head("GDELT's three-month window, stated rather than assumed")
    import datetime as _dt

    recent = (_dt.date.today() - _dt.timedelta(days=20)).isoformat()
    start, end, note = gdelt_window(recent)
    check("a case inside the window gets an absolute range", start.endswith("000000"), start)
    check("and it is left open at the top", end == "", repr(end))
    check("with nothing to warn about", note == "", note)
    check("DD-MM-YYYY reads the same",
          gdelt_window("-".join(reversed(recent.split("-"))))[0] == start)

    # The correction that matters. GDELT's full-text API is a rolling three months;
    # `timespan=24months` is silently clamped, so a 2019 case was never covered and the
    # engine used to present that as "GDELT found nothing".
    start, _end, note = gdelt_window("2019-06-15")
    check("an out-of-range case sends no absolute window", start == "", start)
    check("and the gap is reported instead of read as an absence",
          "three months" in note and "2019-06-15" in note, note)

    check("no date means no window and no note", gdelt_window("") == ("", "", ""))
    check("unparseable text means no window and no note",
          gdelt_window("last summer") == ("", "", ""))

    _q, plan = plan_queries(subject="Suresh Kumar", kind="person", anchors=ANCHORS)
    check("the default timespan does not overstate the index",
          plan.timespan == "3months", plan.timespan)
    check("our 2023 test case is correctly reported as out of GDELT's reach",
          bool(plan.out_of_range) and not plan.start, plan.out_of_range[:60])


# ── the HTTP surface ────────────────────────────────────────────────────────────

def test_api() -> None:
    head("the HTTP surface: auth, governance, and honest 404s")
    from fastapi.testclient import TestClient

    from . import main as main_mod
    from .config import settings

    # The service must not be drivable without a key; the test supplies one so the
    # governance checks below are reached rather than short-circuited by the auth gate.
    object.__setattr__(settings, "internal_key", "test-key")
    client = TestClient(main_mod.app)
    key = {"x-research-key": "test-key"}
    body = {"subject": "Suresh Kumar", "kind": "person", "purpose": "tracing absconding accused",
            "mode": "quick", "role": "investigator", "officer": "off_1"}

    check("no key is rejected", client.post("/research", json=body).status_code == 401)
    check("a wrong key is rejected", client.post(
        "/research", json=body, headers={"x-research-key": "nope"}).status_code == 401)
    # Authentication must be decided BEFORE the body is VALIDATED. Reading the header
    # inside the handler answers 422 here, naming every required field to a caller who
    # has not authenticated.
    #
    # Syntactically broken JSON is a separate case and deliberately not asserted:
    # FastAPI parses the raw body before it solves dependencies, so that still answers
    # 422 — which discloses nothing beyond "this endpoint expects JSON".
    for route in ("/research", "/research/sync"):
        r = client.post(route, json={})
        check(f"an unauthenticated empty body on {route} is 401, not a schema hint",
              r.status_code == 401, f"{r.status_code} {r.text[:60]}")
    check("an unauthenticated stream is refused",
          client.get("/research/rq_x/stream").status_code == 401)

    r = client.post("/research", json={**body, "purpose": "check"}, headers=key)
    check("an empty purpose is refused", r.status_code == 403, str(r.status_code))
    check("and the refusal says what to do", "why" in r.text.lower(), r.text[:90])

    r = client.post("/research", json={**body, "role": "policymaker"}, headers=key)
    check("a read-only role may not research a person", r.status_code == 403)

    r = client.post("/research", json={**body, "subject_role": "victim"}, headers=key)
    check("a victim is refused outright", r.status_code == 403)

    r = client.post("/research", json={**body, "kind": "nonsense"}, headers=key)
    check("an unknown subject kind is refused", r.status_code == 403)

    r = client.get("/research/rq_does_not_exist", headers=key)
    check("an unknown run is a clear 404, not an empty result", r.status_code == 404)

    h = client.get("/health", headers=key).json()
    check("health reports which sources are live", h["sources"]["gdelt"] is True)
    check("health reports whether a model is configured", "configured" in h["model"])
    check("health never leaks the key", "test-key" not in str(h))

    # A real start, with discovery faked. Proves the route wires through to the
    # pipeline and the registry, which no module suite can show.
    _install_fakes()
    r = client.post("/research", json=body, headers=key)
    check("a valid request starts a run", r.status_code == 200, str(r.status_code))
    run_id = r.json().get("id", "")
    check("and returns a poll handle", run_id.startswith("rq_"), run_id)

    import time as _t
    for _ in range(80):
        state = client.get(f"/research/{run_id}", headers=key).json()
        if state["state"] in {"done", "failed"}:
            break
        _t.sleep(0.1)
    check("the run reaches a terminal state", state["state"] == "done",
          state.get("error") or state["state"])
    check("the result comes back through the poll",
          bool(state.get("result", {}).get("findings")),
          str(len((state.get("result") or {}).get("findings", []))))


if __name__ == "__main__":
    test_run()
    test_deadline()
    test_prefilter()
    test_window()
    test_api()
    print("\n" + ("all pipeline and API checks passed" if not FAILS
                  else f"{len(FAILS)} FAILED: {FAILS}"))
    sys.exit(1 if FAILS else 0)
