"""In-memory run registry.

Runs live in memory and expire. That is the explicit design: this is a real-time
engine, there is no corpus and no document store, and a run's value expires with the
officer's attention. What persists instead is what the officer keeps — the exported
report — and the audit line, which is the record that the search happened.

The honest consequence, stated rather than hidden: with more than one AppSail instance
a poll could land on the instance that does not hold the run. The service is therefore
deployed with a single instance, and the API returns a clear 404 rather than an empty
result if that assumption is ever broken.
"""

from __future__ import annotations

import asyncio
import secrets
import time
from dataclasses import dataclass, field
from typing import Any

from .config import settings


@dataclass
class Run:
    id: str
    subject: str
    kind: str
    mode: str
    officer: str
    purpose: str
    created: float = field(default_factory=time.time)
    state: str = "queued"          # queued | running | done | failed | cancelled
    stage: str = ""
    message: str = ""
    events: list[dict] = field(default_factory=list)
    result: dict | None = None
    error: str = ""
    task: asyncio.Task | None = None

    def public(self, *, with_events: bool = False) -> dict:
        out: dict[str, Any] = {
            "id": self.id, "subject": self.subject, "kind": self.kind, "mode": self.mode,
            "state": self.state, "stage": self.stage, "message": self.message,
            "created": round(self.created, 3),
            "age_s": round(time.time() - self.created, 1),
        }
        if self.error:
            out["error"] = self.error
        if with_events:
            out["events"] = self.events[-60:]
        if self.result is not None:
            out["result"] = self.result
        return out


class Registry:
    def __init__(self) -> None:
        self._runs: dict[str, Run] = {}
        self._gate = asyncio.Semaphore(settings.max_concurrent_runs)

    def _evict(self) -> None:
        now = time.time()
        for rid in [r for r, v in self._runs.items()
                    if now - v.created > settings.run_ttl_s and v.state != "running"]:
            self._runs.pop(rid, None)
        # Hard cap regardless of TTL, oldest finished first, so a burst cannot grow the
        # process without bound.
        if len(self._runs) > settings.max_runs:
            finished = sorted((v for v in self._runs.values() if v.state != "running"),
                              key=lambda v: v.created)
            for v in finished[:len(self._runs) - settings.max_runs]:
                self._runs.pop(v.id, None)

    def create(self, *, subject: str, kind: str, mode: str, officer: str,
               purpose: str) -> Run:
        self._evict()
        # A run id is guessable-resistant on purpose: it is the only thing standing
        # between one officer's poll and another officer's research subject.
        run = Run(id="rq_" + secrets.token_urlsafe(12), subject=subject, kind=kind,
                  mode=mode, officer=officer, purpose=purpose)
        self._runs[run.id] = run
        return run

    def get(self, run_id: str) -> Run | None:
        self._evict()
        return self._runs.get(run_id)

    def active(self) -> int:
        return sum(1 for v in self._runs.values() if v.state == "running")

    @property
    def gate(self) -> asyncio.Semaphore:
        return self._gate

    def note(self, run: Run, stage: str, message: str, data: dict | None = None) -> None:
        run.stage = stage
        run.message = message
        run.events.append({"t": round(time.time() - run.created, 2), "stage": stage,
                           "message": message, **(data or {})})


registry = Registry()
