"""HTTP surface for the research engine.

Shaped by one platform fact: Catalyst Advanced I/O functions time out at 30 seconds, so
the KSP2 function cannot hold a research run open. It starts one here and polls. This
service is a container with no such limit, which is why the engine lives here.

Three endpoints do the work:

  POST /research            start a run, return its id immediately
  GET  /research/{id}       poll state, and the result once finished
  GET  /research/{id}/stream  the same progress as server-sent events

A caller that cannot poll — the WhatsApp channel, whose function is killed at 30 seconds —
supplies `callback_url` instead and is POSTed the finished result. There is no synchronous
endpoint: both modes outlive any caller willing to hold a connection open.

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
from . import rerank
from .config import BUDGETS, budget_for, settings
from .models import Anchors
from .pipeline import run as run_pipeline
from .runs import Run, registry
from .verdict import verdicts

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

    #: Short factual statements from the caller's own database about this subject. Used
    #: in the report, cited as [DB], and kept visibly separate from open-source material.
    #: Supplied by the caller because only the caller can read its own records — this
    #: service has no database access and should not have any.
    records: list[str] = Field(default_factory=list)

    #: Where to POST the finished result. For callers that cannot hold a connection for
    #: 90 to 300 seconds — which is every Catalyst function, since they are killed at 30.
    #: Without this, WhatsApp could only ever have had a cut-down mode.
    callback_url: str = ""
    callback_key: str = ""
    #: Opaque value echoed back on the callback so the receiver knows which conversation
    #: the result belongs to.
    callback_context: dict = Field(default_factory=dict)


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


async def _deliver(run: Run, body: ResearchIn) -> None:
    """POST the finished result to the caller's callback, if one was given.

    Best-effort and never allowed to fail the run: the result is already in the registry
    and still pollable, so a failed callback costs a notification, not the research. One
    retry, because the usual failure here is a cold function instance.
    """
    if not body.callback_url:
        return
    import httpx

    payload = {"id": run.id, "state": run.state, "context": body.callback_context,
               "result": run.result, "error": run.error or None}
    headers = {"Content-Type": "application/json"}
    if body.callback_key:
        headers["x-research-callback-key"] = body.callback_key
    for attempt in (1, 2):
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as client:
                r = await client.post(body.callback_url, json=payload, headers=headers)
            if r.status_code < 400:
                governance.audit("delivered", run=run.id, officer=body.officer,
                                 status=r.status_code)
                return
            reason = f"http {r.status_code}"
        except Exception as e:  # noqa: BLE001
            reason = f"{e.__class__.__name__}: {str(e)[:120]}"
        if attempt == 2:
            registry.note(run, "callback_failed", reason)
            governance.audit("delivery_failed", run=run.id, officer=body.officer,
                             reason=reason)
        else:
            await asyncio.sleep(2)


async def _execute(run: Run, body: ResearchIn, anchors: Anchors) -> None:
    async with registry.gate:
        run.state = "running"

        async def progress(stage: str, message: str, data: dict) -> None:
            registry.note(run, stage, message, data)

        try:
            result = await run_pipeline(
                subject=body.subject, kind=body.kind, anchors=anchors,
                budget=budget_for(body.mode), question=body.question,
                records=body.records, progress=progress)
            run.result = asdict(result)
            run.state = "done"
            registry.note(run, "done", "complete")
            await _deliver(run, body)
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


# There is deliberately no synchronous endpoint. It existed for `quick` mode, whose
# whole purpose was to fit inside a 30-second caller; with both remaining modes taking 90
# to 300 seconds, any caller that holds the connection open is a caller that times out.
# Callers either poll `GET /research/{id}` or supply `callback_url` and are told when the
# run finishes.


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
        # The cross-encoder that decides which of ~130 candidates the run actually reads.
        # Reported separately from the chat model because losing it degrades the run
        # quietly — the answer is still produced, from a worse selection of sources.
        "rerank": rerank.status(),
        "sources": sources.available(),
        "source_status": dict(sources.STATUS),
        # Which publishers this instance has learned it cannot read without a browser.
        # Operationally useful: a domain appearing here repeatedly is the argument for
        # building the render tier, or evidence that one is now needed.
        "publishers": verdicts.summary(),
        "runs": {"active": registry.active(), "max_concurrent": settings.max_concurrent_runs,
                 "ttl_s": settings.run_ttl_s},
        "authenticated": bool(settings.internal_key),
    }
