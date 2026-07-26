"""Cross-encoder reranking: choosing which candidates are worth reading.

THE PROBLEM THIS SOLVES. Discovery returns 120-140 candidates and a standard run can
only READ 48 of them. Reading is what earns an attribution band — an unread link can
only ever be a link — so the choice of which 48 is the single highest-leverage decision
in the pipeline, and until now it was made lexically: does a subject word appear in the
title, else the snippet, then fused rank, tier, date.

Lexical overlap cannot tell "Vipul Singh" from "Manmohan Singh". Both contain the word
the query contains. On a real run that put five Manmohan Singh obituaries and a box-office
column called "Khooni Monday" into the read budget while genuinely relevant coverage sat
unread at position sixty. The fuzzy search APIs we depend on make this worse, not better:
Quintype ORs the query terms and has no exact-phrase mode, so noise arrives by design.

A cross-encoder reads the query and the candidate TOGETHER and scores their relationship,
which is exactly the judgment lexical matching cannot make. Measured on the same five
documents that broke the lexical path:

    the real encounter report ...................... 0.907
    an unrelated Baghpat shootout detail ........... 0.379
    "Khooni Monday" box-office column .............. 0.127
    Justice Vipul Pancholi (a different person) .... 0.081
    Manmohan Singh's funeral ....................... 0.059

WHY A HOSTED MODEL AND NOT A SELF-HOSTED ONE. The engine's rule is no external providers
for retrieval, and that still holds: every URL and every document still comes from
keyless public sources. This is scoring, not retrieval — no document leaves the service
except the title and a 200-character snippet of pages that are already public — and the
alternative was a 570 MB int8 ONNX cross-encoder in a container, which for 130 pairs per
run is more infrastructure than the problem deserves. Rerank v4 Pro also covers 100+
languages, which matters because half our sources are Hindi or Kannada and a
self-hosted English cross-encoder would have quietly demoted all of them.

FAILURE IS NOT FATAL. No credential, a timeout, an HTTP error or a malformed response all
return None, and the pipeline keeps its lexical ordering. Reranking makes the read budget
smarter; it is not load-bearing, and a scoring outage must not stop a run that has
already done its retrieval.
"""

from __future__ import annotations

import json
import os
import time

import httpx

#: Why the last rerank call failed. Surfaced by /health for the same reason llm.LAST_ERROR
#: is: a missing credential and a rejected request both present as "no scores", and the
#: operator cannot tell "switched off" from "broken" without being told.
LAST_ERROR: dict[str, str] = {}

#: Cohere counts a rerank call by search, not by document, so one call for the whole
#: candidate set is both cheapest and fastest. v2/rerank accepts up to 1000 documents;
#: we send at most a few hundred.
MAX_DOCUMENTS = 400

#: Enough of each candidate for a cross-encoder to judge it, and no more. We only have
#: the headline and the search snippet at this stage — the page has not been fetched yet,
#: which is the whole point — so there is nothing longer to send.
MAX_DOC_CHARS = 420


def _env(name: str, default: str = "") -> str:
    v = (os.getenv(name) or default).strip()
    return "" if v in {"", "..."} else v


def endpoint() -> str:
    """The Foundry provider route, assembled from the resource endpoint.

    Two routes exist on an Azure AI Foundry resource and only one of them serves a v4
    deployment: `/providers/cohere/v2/rerank` works, while the older
    `/models/v1/rerank` answers HTTP 500 for every request body — a failure that looks
    like a schema problem and is not one. This cost an hour, so it is written down.
    """
    explicit = _env("RERANK_URL")
    if explicit:
        return explicit
    base = _env("RERANK_ENDPOINT") or _env("AZURE_AI_ENDPOINT")
    return f"{base.rstrip('/')}/providers/cohere/v2/rerank" if base else ""


def model() -> str:
    return _env("RERANK_MODEL", "Cohere-rerank-v4.0-pro")


def available() -> bool:
    if _env("RERANK_ENABLED", "true").lower() not in {"true", "1", "yes"}:
        return False
    return bool(endpoint() and (_env("RERANK_KEY") or _env("AZURE_AI_KEY")))


def status() -> dict:
    return {"available": available(), "model": model() if available() else "",
            **({"last_error": LAST_ERROR} if LAST_ERROR else {})}


def _note(reason: str) -> None:
    LAST_ERROR["reason"] = reason[:200]
    LAST_ERROR["at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def document_text(title: str, snippet: str, outlet: str, published: str) -> str:
    """What the model is shown about one candidate.

    Outlet and date are included on purpose. They are weak relevance signals on their own
    but they are the difference between two identically-headlined wire copies, and the
    model is better placed than a sort key to decide which of them to read.
    """
    head = " ".join((title or "").split())
    body = " ".join((snippet or "").split())
    meta = " | ".join(x for x in (outlet, published) if x)
    text = head or body or meta
    if body and body != head:
        text = f"{head}. {body}" if head else body
    if meta:
        text = f"{text} [{meta}]"
    return text[:MAX_DOC_CHARS]


async def scores(query: str, documents: list[str], *, timeout_s: float = 20.0) -> list[float] | None:
    """Relevance scores in the order the documents were given. None on any failure.

    Cohere returns results sorted by score with the original index attached, so the
    response is mapped back onto the input order here — the caller wants scores it can
    combine with its own signals, not a pre-sorted list that has thrown away everything
    else it knows about each candidate.
    """
    url, key = endpoint(), (_env("RERANK_KEY") or _env("AZURE_AI_KEY"))
    if not url or not key or not query.strip() or not documents:
        return None
    docs = [d for d in documents[:MAX_DOCUMENTS]]
    payload = {"model": model(), "query": query[:1000], "documents": docs,
               "top_n": len(docs)}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout_s)) as client:
            r = await client.post(url, headers={"api-key": key,
                                               "Content-Type": "application/json"},
                                  content=json.dumps(payload))
        if r.status_code != 200:
            _note(f"http {r.status_code}: {r.text[:140]}")
            return None
        results = (r.json() or {}).get("results") or []
        if not results:
            _note("no results in response")
            return None
        out = [0.0] * len(documents)
        for row in results:
            i = row.get("index")
            if isinstance(i, int) and 0 <= i < len(out):
                out[i] = float(row.get("relevance_score") or 0.0)
        LAST_ERROR.clear()
        return out
    except Exception as e:  # noqa: BLE001 — scoring must never fail a run
        _note(f"{e.__class__.__name__}: {str(e)[:140]}")
        return None
