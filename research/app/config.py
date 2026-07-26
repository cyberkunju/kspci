"""Runtime configuration and the budgets that keep a run bounded.

Everything is environment-driven with usable defaults, so the service starts and
does real work with no configuration at all. A missing optional source degrades
coverage visibly (the run reports which tiers it could not reach) rather than
failing.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field


def _env(name: str, default: str = "") -> str:
    v = os.getenv(name, default)
    return "" if v is None or v.strip() in {"", "..."} else v.strip()


def _int(name: str, default: int) -> int:
    try:
        return int(_env(name) or default)
    except ValueError:
        return default


@dataclass(frozen=True)
class Budget:
    """A research mode's hard ceilings.

    Every number here exists to stop one pathological subject from consuming the
    instance. `wall_s` is enforced by the pipeline as a deadline, not a hope: when
    it expires the run returns what it has, labelled partial. A research tool that
    hangs is worse than one that admits it ran out of time.
    """

    name: str
    wall_s: int
    max_queries: int
    max_hits: int
    max_fetch: int
    max_rounds: int
    fetch_concurrency: int
    llm_calls: int


# Two modes, on purpose.
#
# There used to be a third, `quick`, sized to fit inside an Advanced I/O function's
# 30-second ceiling so the WhatsApp channel could answer within one request. It was
# removed because it answered the wrong question: ten pages read is a sample, not
# research, and an officer who asks what the open internet says about a person deserves
# the same answer whichever channel they asked from. WhatsApp now starts a real run and
# the result is delivered when it is ready.
BUDGETS: dict[str, Budget] = {
    # The default. `max_fetch` is what decides how many of the discovered
    # links are actually READ rather than merely listed, and reading is what earns an
    # attribution band — an unread link can only ever be a link. Raised from 30 because
    # discovery now routinely returns 70-100 candidates and stopping at 30 left real
    # matches unexamined at position 40.
    "standard": Budget("standard", wall_s=90, max_queries=16, max_hits=250, max_fetch=48,
                       max_rounds=1, fetch_concurrency=12, llm_calls=12),
    # Follows leads discovered in round 1 into a second round of queries.
    "deep": Budget("deep", wall_s=300, max_queries=40, max_hits=500, max_fetch=120,
                   max_rounds=2, fetch_concurrency=14, llm_calls=40),
}

DEFAULT_MODE = _env("RESEARCH_DEFAULT_MODE", "standard")


@dataclass(frozen=True)
class Settings:
    # ── identity ────────────────────────────────────────────────────────────
    # A real, contactable User-Agent is not politeness theatre: it is what lets a
    # publisher rate-limit us instead of banning us, and it is the difference
    # between responsible retrieval and scraping.
    user_agent: str = field(default_factory=lambda: _env(
        "RESEARCH_USER_AGENT",
        "KSP-Research/1.0 (Karnataka State Police crime-intelligence research; +https://ksp.cyberkunju.com/about-bot)",
    ))
    contact: str = field(default_factory=lambda: _env("RESEARCH_CONTACT", ""))

    # ── network ─────────────────────────────────────────────────────────────
    fetch_timeout_s: int = field(default_factory=lambda: _int("RESEARCH_FETCH_TIMEOUT_S", 12))
    search_timeout_s: int = field(default_factory=lambda: _int("RESEARCH_SEARCH_TIMEOUT_S", 10))
    max_bytes: int = field(default_factory=lambda: _int("RESEARCH_MAX_BYTES", 3 * 1024 * 1024))
    per_host_concurrency: int = field(default_factory=lambda: _int("RESEARCH_PER_HOST", 2))

    # ── optional sources ────────────────────────────────────────────────────
    searxng_url: str = field(default_factory=lambda: _env("SEARXNG_URL"))
    marginalia_key: str = field(default_factory=lambda: _env("MARGINALIA_KEY"))
    # Off by default: Mojeek's robots.txt disallows /search, and we honour robots.
    # The adapter is kept because Mojeek offers a licensed API — if that is ever
    # arranged, this becomes a one-line switch rather than a rewrite.
    mojeek_enabled: bool = field(default_factory=lambda: _env("MOJEEK_ENABLED", "false") == "true")
    # There is deliberately no headless-browser tier, and this is now a measured
    # decision rather than an assumption. A Chromium image was built and probed against
    # the exact pages that fail; the findings are in
    # documentation/18-engine-techniques.md. In short:
    #
    #   * The image is 1.38 GB against this service's 333 MB, and Chromium would be
    #     resident in the same process that fetches attacker-influenceable URLs.
    #   * MSN — the publisher that motivated the idea — is not fixed by a browser. It
    #     renders 200 OK with an unrelated article's title and 25 characters of body,
    #     with a real Chrome user-agent and nothing blocked. See verdict.py.
    #   * LiveLaw's search, the one endpoint a browser genuinely would have unlocked,
    #     is disallowed by its robots.txt. That is a permission problem, not a
    #     rendering problem, and rendering it anyway would be a deliberate violation.
    #   * The remaining gaps were publishers whose search page loads results by
    #     JavaScript — and six of them run Quintype, whose own JSON search API returns
    #     better data than a rendered page would. See tiers.ONSITE.
    #
    # If a tier is ever added that surfaces app-shell pages we are permitted to read and
    # that have no API, that is when to revisit this.

    # ── model ───────────────────────────────────────────────────────────────
    llm_backend: str = field(default_factory=lambda: _env("RESEARCH_LLM_BACKEND", "openai"))
    llm_timeout_s: int = field(default_factory=lambda: _int("RESEARCH_LLM_TIMEOUT_S", 45))

    # ── run registry ────────────────────────────────────────────────────────
    # Runs live in memory only. There is no corpus and no document store: this is
    # a real-time engine, so a run's value expires with the officer's attention.
    run_ttl_s: int = field(default_factory=lambda: _int("RESEARCH_RUN_TTL_S", 1800))
    max_runs: int = field(default_factory=lambda: _int("RESEARCH_MAX_RUNS", 64))
    max_concurrent_runs: int = field(default_factory=lambda: _int("RESEARCH_MAX_CONCURRENT", 3))

    # ── access ──────────────────────────────────────────────────────────────
    internal_key: str = field(default_factory=lambda: _env("RESEARCH_INTERNAL_KEY"))


settings = Settings()


def budget_for(mode: str | None) -> Budget:
    return BUDGETS.get((mode or DEFAULT_MODE).lower(), BUDGETS["standard"])
