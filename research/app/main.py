"""HTTP surface for the research engine.

Shaped by one platform fact: Catalyst Advanced I/O functions time out at 30 seconds, so
the KSP2 function cannot hold a research run open. It starts one here and polls. This
service is a container with no such limit, which is why the engine lives here.

Three endpoints do the work:

  POST /research            start a run, return its id immediately
  GET  /research/{id}       poll state, and the result once finished
  GET  /research/{id}/stream  the same progress as server-sent events

Plus `POST /research/sync` for quick mode, which fits inside a function's budget and
saves the caller a polling loop when it does.

Every route requires the internal key. This service reaches the open internet on
instruction and must never be a URL an outsider can point anywhere.
"""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import asdict

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from . import governance, llm, sources
from .config import BUDGETS, budget_for, settings
from .models import Anchors
from .pipeline import run as run_pipeline
from .runs import Run, registry

app = FastAPI(title="KSP Research Engine", version="1.0",
              docs_url=None, redoc_url=None, openapi_url=None)

_caps = governance.DailyCap()
_started = time.time()


class AnchorsIn(BaseModel):
    """What the caller already knows about the subject.

    Supplied by the KSP2 function from its own records. These are what make the
    difference between researching a person and researching a name.
    """

    names: list[str] = Field(default_factory=list)
    district: str = ""
    state: str = ""
    station: str = ""
    age: int | None = None
    crime_numbers: list[str] = Field(default_factory=list)
    sections: list[str] = Field(default_factory=list)
    associates: list[str] = Field(default_factory=list)
    organisations: list[str] = Field(default_factory=list)
    date_from: str = ""
    date_to: str = ""


class ResearchIn(BaseModel):
    subject: str
    kind: str = "person"
    purpose: str = ""
    question: str = ""
    mode: str = "standard"
    officer: str = ""
    role: str = "investigator"
    subject_role: str = ""
    crime_number: str = ""
    anchors: AnchorsIn = Field(default_factory=AnchorsIn)


def _auth(key: str | None) -> None:
    """Fail closed. With no key configured, nobody may drive this service."""
    expected = settings.internal_key
    if not expected:
        raise HTTPException(503, "RESEARCH_INTERNAL_KEY is not configured")
    if not key or not secrets_equal(key, expected):
        raise HTTPException(401, "unauthorized")


def require_key(x_research_key: str | None = Header(default=None)) -> None:
    """The same check, as a dependency, so it runs BEFORE the body is validated.

    Reading the header inside the handler looks equivalent and is not: FastAPI validates
    the request body first, so an unauthenticated caller sending `{}` got a 422 naming
    every required field. Small leak, but it is the schema of an internet-facing service
    handed to someone who has not authenticated, and it means their payload was parsed
    before we decided whether to talk to them at all. Dependencies are solved before
    body validation, so this answers 401 first.
    """
    _auth(x_research_key)


AUTH = [Depends(require_key)]


def secrets_equal(a: str, b: str) -> bool:
    import hmac
    return hmac.compare_digest(a.encode(), b.encode())


def _authorise(body: ResearchIn) -> Anchors:
    decision = governance.authorise(
        kind=body.kind, role=body.role, purpose=body.purpose, subject=body.subject,
        subject_role=body.subject_role, crime_number=body.crime_number)
    if not decision.allowed:
        governance.audit("refused", officer=body.officer, kind=body.kind,
                         subject=body.subject, code=decision.code, reason=decision.reason)
        raise HTTPException(403, {"error": decision.code, "message": decision.reason})

    cap = _caps.check(body.officer)
    if not cap.allowed:
        governance.audit("rate_limited", officer=body.officer, subject=body.subject)
        raise HTTPException(429, {"error": cap.code, "message": cap.reason})

    a = body.anchors
    return Anchors(
        names=[n for n in a.names if n] or [body.subject],
        district=a.district, state=a.state, station=a.station, age=a.age,
        crime_numbers=[c for c in a.crime_numbers if c] +
                      ([body.crime_number] if body.crime_number else []),
        sections=[s for s in a.sections if s],
        associates=[x for x in a.associates if x],
        organisations=[o for o in a.organisations if o],
        date_from=a.date_from, date_to=a.date_to)


async def _execute(run: Run, body: ResearchIn, anchors: Anchors) -> None:
    async with registry.gate:
        run.state = "running"

        async def progress(stage: str, message: str, data: dict) -> None:
            registry.note(run, stage, message, data)

        try:
            result = await run_pipeline(
                subject=body.subject, kind=body.kind, anchors=anchors,
                budget=budget_for(body.mode), question=body.question, progress=progress)
            run.result = asdict(result)
            run.state = "done"
            registry.note(run, "done", "complete")
            governance.audit(
                "completed", run=run.id, officer=body.officer, kind=body.kind,
                subject=body.subject, purpose=body.purpose, crime_number=body.crime_number,
                mode=result.mode, partial=result.partial, elapsed_s=result.elapsed_s,
                stories=result.counts.get("stories", 0),
                readable=result.counts.get("readable", 0),
                confirmed=result.counts.get("by_attribution", {}).get("confirmed", 0),
                summarised=bool(result.summary))
        except asyncio.CancelledError:
            run.state = "cancelled"
            raise
        except Exception as e:  # noqa: BLE001
            run.state = "failed"
            run.error = f"{e.__class__.__name__}: {str(e)[:200]}"
            registry.note(run, "failed", run.error)
            governance.audit("failed", run=run.id, officer=body.officer,
                             subject=body.subject, error=run.error)


@app.post("/research", dependencies=AUTH)
async def start(body: ResearchIn) -> dict:
    anchors = _authorise(body)
    _caps.record(body.officer)
    run = registry.create(subject=body.subject, kind=body.kind, mode=budget_for(body.mode).name,
                          officer=body.officer, purpose=body.purpose)
    governance.audit("started", run=run.id, officer=body.officer, role=body.role,
                     kind=body.kind, subject=body.subject, purpose=body.purpose,
                     crime_number=body.crime_number, mode=run.mode,
                     anchor_strength=anchors.strength())
    run.task = asyncio.create_task(_execute(run, body, anchors))
    return {"id": run.id, "state": run.state, "mode": run.mode,
            "poll": f"/research/{run.id}", "stream": f"/research/{run.id}/stream"}


@app.post("/research/sync", dependencies=AUTH)
async def start_sync(body: ResearchIn) -> dict:
    """Run to completion in the request.

    For quick mode only, and capped below the caller's own 30-second ceiling so the
    function that called us does not time out holding this connection open.
    """
    anchors = _authorise(body)
    _caps.record(body.officer)
    budget = budget_for("quick" if body.mode not in {"quick"} else body.mode)
    governance.audit("started_sync", officer=body.officer, kind=body.kind,
                     subject=body.subject, purpose=body.purpose, mode=budget.name)
    result = await run_pipeline(subject=body.subject, kind=body.kind, anchors=anchors,
                               budget=budget, question=body.question)
    governance.audit("completed_sync", officer=body.officer, subject=body.subject,
                     elapsed_s=result.elapsed_s, partial=result.partial,
                     stories=result.counts.get("stories", 0))
    return asdict(result)


@app.get("/research/{run_id}", dependencies=AUTH)
async def poll(run_id: str) -> dict:
    run = registry.get(run_id)
    if run is None:
        raise HTTPException(404, "no such run (it may have expired)")
    return run.public(with_events=True)


@app.delete("/research/{run_id}", dependencies=AUTH)
async def cancel(run_id: str) -> dict:
    run = registry.get(run_id)
    if run is None:
        raise HTTPException(404, "no such run")
    if run.task and not run.task.done():
        run.task.cancel()
    governance.audit("cancelled", run=run.id, officer=run.officer)
    return {"id": run.id, "state": "cancelled"}


@app.get("/research/{run_id}/stream", dependencies=AUTH)
async def stream(run_id: str, request: Request) -> StreamingResponse:
    """Progress as server-sent events.

    A deep run takes minutes, and a spinner with no detail invites the officer to
    conclude it has hung. Streaming the stages costs nothing and shows the engine
    working: how many sources were found, how many were readable, how many graded.
    """
    run = registry.get(run_id)
    if run is None:
        raise HTTPException(404, "no such run")

    async def gen():
        sent = 0
        while True:
            if await request.is_disconnected():
                return
            while sent < len(run.events):
                yield f"data: {json.dumps(run.events[sent], ensure_ascii=False)}\n\n"
                sent += 1
            if run.state in {"done", "failed", "cancelled"}:
                yield f"data: {json.dumps({'stage': run.state, 'final': True})}\n\n"
                return
            await asyncio.sleep(0.5)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-store",
                                      "X-Accel-Buffering": "no"})


@app.get("/health")
async def health() -> dict:
    """What this deployment can actually do, without revealing a single secret."""
    return {
        "ok": True,
        "service": "ksp-research",
        "uptime_s": round(time.time() - _started, 1),
        "modes": sorted(BUDGETS),
        "model": {"configured": llm.available(), "backend": llm.backend(),
                  **({"last_error": llm.LAST_ERROR} if llm.LAST_ERROR else {})},
        "sources": sources.available(),
        "source_status": dict(sources.STATUS),
        "runs": {"active": registry.active(), "max_concurrent": settings.max_concurrent_runs,
                 "ttl_s": settings.run_ttl_s},
        "authenticated": bool(settings.internal_key),
    }
