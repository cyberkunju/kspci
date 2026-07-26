"""The model, behind one interface, so the engine is not welded to a vendor.

Three backends:

  * `openai`  — any OpenAI-compatible /v1/chat/completions endpoint. Covers OpenAI,
                Azure-compatible gateways, OpenRouter, vLLM, Ollama and llama.cpp,
                which means a fully self-hosted model is a base-URL change.
  * `quickml` — Zoho QuickML with a Zoho OAuth refresh token, mirroring what the
                KSP2 function already uses, so the whole system can run on one model.
  * `none`    — no model configured.

Reranking does not go through here: it is a cross-encoder, not a chat model, with its own
endpoint and its own failure semantics. See rerank.py.

The `none` backend is not a stub, it is a feature. Every claim and every summary in
this engine is optional decoration on top of a retrieved, attributed, citable source
list. With no model the run still returns all its sources with their attribution bands
and reasoning — which is the part an officer can act on. A research tool that produces
nothing without an LLM has its dependencies backwards.
"""

from __future__ import annotations

import json
import os
import time

import httpx

from .config import settings

_TOKEN: dict[str, float | str] = {"value": "", "expires": 0.0}

#: Why the last model call failed. Surfaced by /health.
#:
#: Without this, every model problem looks identical from the outside: a configured
#: backend that returns nothing. An expired credential, a rate-limited OAuth grant, a
#: rejected header and a genuine empty completion all present as None, and the operator
#: has no way to tell "the model is broken" from "the model had nothing to say".
LAST_ERROR: dict[str, str] = {}


def _note(reason: str) -> None:
    LAST_ERROR["reason"] = reason[:200]
    LAST_ERROR["at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def backend() -> str:
    b = (settings.llm_backend or "").lower()
    if b == "openai" and os.getenv("OPENAI_API_KEY", "").strip() not in {"", "sk-..."}:
        return "openai"
    if b == "quickml" and os.getenv("ZOHO_REFRESH_TOKEN", "").strip():
        return "quickml"
    # An explicitly configured local endpoint needs no key.
    if b == "openai" and os.getenv("OPENAI_API_URL", "").strip():
        return "openai"
    return "none"


def available() -> bool:
    return backend() != "none"


async def _zoho_token(client: httpx.AsyncClient) -> str:
    """Refresh-token grant, cached until shortly before expiry."""
    if _TOKEN["value"] and float(_TOKEN["expires"]) > time.time() + 60:
        return str(_TOKEN["value"])
    accounts = os.getenv("ZOHO_ACCOUNTS_URL", "https://accounts.zoho.in").rstrip("/")
    r = await client.post(f"{accounts}/oauth/v2/token", data={
        "refresh_token": os.getenv("ZOHO_REFRESH_TOKEN", ""),
        "client_id": os.getenv("ZOHO_CLIENT_ID", ""),
        "client_secret": os.getenv("ZOHO_CLIENT_SECRET", ""),
        "grant_type": "refresh_token",
    }, timeout=20.0)
    data = r.json() if r.status_code == 200 else {}
    token = str(data.get("access_token") or "")
    if not token:
        # Zoho answers a refused grant with HTTP 200 and an "error" field, so the status
        # code alone tells you nothing. The common one in practice is a rate limit on
        # refresh-token grants — which is why the token below is cached for its full
        # lifetime rather than fetched per call.
        raise RuntimeError(
            f"zoho oauth failed: http {r.status_code} {data.get('error') or r.text[:80]}")
    _TOKEN["value"] = token
    _TOKEN["expires"] = time.time() + float(data.get("expires_in") or 3000)
    return token


async def chat(system: str, user: str, *, max_tokens: int = 900,
               temperature: float = 0.1, timeout_s: int | None = None) -> str | None:
    """One completion. Returns None on any failure — never raises.

    Callers treat a None as "this enrichment did not happen" and carry on, because the
    alternative is a model outage taking down a retrieval engine that had already done
    the work.
    """
    b = backend()
    if b == "none" or not user.strip():
        return None
    timeout = timeout_s or settings.llm_timeout_s

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout)) as client:
            if b == "quickml":
                token = await _zoho_token(client)
                endpoint = os.getenv("QUICKML_LLM_ENDPOINT", "")
                if not endpoint:
                    return None
                # The header is CATALYST-ORG. Catalyst rejects the request with
                # ORGID_HEADER_UNAVAILABLE under any other name, which is a 400 that
                # says nothing about the header being the problem.
                headers = {"Authorization": "Zoho-oauthtoken " + token,
                           "Content-Type": "application/json"}
                org = os.getenv("QUICKML_ORG_ID", "")
                if org:
                    headers["CATALYST-ORG"] = org
                payload = {
                    "model": os.getenv("QUICKML_MODEL", "crm-di-glm47b_30b_it"),
                    "messages": [{"role": "system", "content": system},
                                 {"role": "user", "content": user}],
                    "max_tokens": min(max_tokens, 4096),
                    "temperature": temperature,
                    # GLM's extended reasoning mode. Off: it costs latency this engine
                    # spends better on retrieval, and claim extraction is not a
                    # reasoning task, it is a copying task.
                    "chat_template_kwargs": {
                        "enable_thinking": os.getenv("QUICKML_THINKING", "false") == "true"},
                }
                r = await client.post(endpoint, headers=headers, content=json.dumps(payload))
            else:
                base = os.getenv("OPENAI_API_URL", "https://api.openai.com").rstrip("/")
                key = os.getenv("OPENAI_API_KEY", "")
                r = await client.post(
                    f"{base}/v1/chat/completions",
                    headers={"Authorization": f"Bearer {key}",
                             "Content-Type": "application/json"},
                    content=json.dumps({
                        "model": os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
                        "messages": [{"role": "system", "content": system},
                                     {"role": "user", "content": user}],
                        "max_tokens": min(max_tokens, 4096),
                        "temperature": temperature,
                    }))
            if r.status_code != 200:
                _note(f"http {r.status_code}: {r.text[:120]}")
                return None
            data = r.json()
            if data.get("error"):
                _note(f"model error: {str(data['error'])[:120]}")
                return None
            # Two response shapes. Catalyst's GLM serving returns a flat {"response": ...};
            # everything OpenAI-compatible returns choices[0].message.content. Reading only
            # the OpenAI shape silently yields None against QuickML — a working model that
            # looks unconfigured.
            choices = data.get("choices") or []
            if choices:
                text = (choices[0].get("message", {}) or {}).get("content") or ""
            else:
                text = data.get("response") or ""
            out = str(text).strip()
            if not out:
                _note("model returned an empty completion")
                return None
            LAST_ERROR.clear()
            return out
    except Exception as e:  # noqa: BLE001 — a model failure must not fail the run
        _note(f"{e.__class__.__name__}: {str(e)[:140]}")
        return None


async def chat_json(system: str, user: str, *, max_tokens: int = 1200) -> dict | list | None:
    """A completion expected to be JSON, parsed forgivingly.

    Models wrap JSON in prose or fences however firmly you ask them not to, so the
    first balanced object or array in the response is extracted rather than trusting the
    whole body to parse. Returns None when nothing usable came back.
    """
    raw = await chat(system, user, max_tokens=max_tokens, temperature=0.0)
    if not raw:
        return None
    text = raw.strip()
    if text.startswith("```"):
        text = text.split("```")[1] if len(text.split("```")) > 1 else text
        text = text.split("\n", 1)[-1] if text[:8].isalpha() else text
    # Whichever bracket opens FIRST is the value the model meant to return. Trying "{"
    # before "[" unconditionally finds the first object INSIDE an array and returns that
    # one element as though it were the whole answer — five claims silently become one.
    candidates = [(text.find(o), o, c) for o, c in (("{", "}"), ("[", "]"))]
    candidates = sorted((pos, o, c) for pos, o, c in candidates if pos >= 0)

    for start, opener, closer in candidates:
        depth = 0
        for i in range(start, len(text)):
            if text[i] == opener:
                depth += 1
            elif text[i] == closer:
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(text[start:i + 1])
                    except ValueError:
                        break
    return None


def as_list(data) -> list:
    """Coerce a model's answer to the list it was asked for.

    Models wrap a requested array in an object — {"claims": [...]}, {"results": [...]} —
    with complete confidence and no consistency. Insisting on a bare array throws away a
    perfectly good answer over packaging.
    """
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        # A single list value is unambiguous whatever it is called.
        lists = [v for v in data.values() if isinstance(v, list)]
        if len(lists) == 1:
            return lists[0]
        # A lone object where an array was asked for is a one-element answer.
        if any(k in data for k in ("claim", "span")):
            return [data]
    return []
