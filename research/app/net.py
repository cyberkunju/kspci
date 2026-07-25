"""Outbound HTTP: canonicalisation, robots, rate discipline, and SSRF defence.

This module is the service's trust boundary. Every URL it fetches was discovered
on the open web, which means an attacker who can get a page indexed can choose a
URL we will request. Two consequences shape everything here:

  1. SSRF IS A REAL RISK, NOT A CHECKBOX. A discovered URL that resolves to
     169.254.169.254, 127.0.0.1 or a private range is an attempt to make this
     container read cloud metadata or reach inside Catalyst's network on the
     attacker's behalf. Hostnames are resolved and every resulting address is
     checked, before connecting and again on every redirect hop — a DNS name that
     resolves public once and private later is the classic bypass.

  2. RETRIEVAL MUST BE POLITE ENOUGH TO KEEP WORKING. robots.txt is honoured, a
     real contactable User-Agent is sent, and per-host concurrency is capped. This
     is not etiquette: a publisher who can rate-limit us will, and one who cannot
     will ban us outright.
"""

from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import socket
import time
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from urllib.robotparser import RobotFileParser

import httpx

from .config import settings

# Query parameters that identify a campaign, not a document. Stripping them is
# what makes two links to the same article deduplicate.
_TRACKING_PREFIXES = ("utm_", "ga_", "fb", "gclid", "mc_", "pk_", "_hs", "yclid", "igsh", "at_")
_TRACKING_EXACT = {
    "gclid", "fbclid", "msclkid", "ref", "referrer", "source", "amp", "spm",
    "share", "shared", "utm", "cmpid", "ncid", "smid", "cid", "sr_share",
}

_ALLOWED_SCHEMES = {"http", "https"}


def canonical_url(raw: str) -> str:
    """A stable identity for a page.

    Lowercases the host, drops the fragment, strips tracking parameters, sorts what
    remains, and removes a trailing slash. Two links that differ only in campaign
    tags become one document, which is the first and cheapest deduplication we get.
    """
    try:
        s = urlsplit(str(raw).strip())
    except ValueError:
        return ""
    if s.scheme.lower() not in _ALLOWED_SCHEMES or not s.netloc:
        return ""

    host = s.hostname or ""
    host = host.lower().rstrip(".")
    if host.startswith("www."):
        host = host[4:]
    port = f":{s.port}" if s.port and s.port not in (80, 443) else ""

    keep = [
        (k, v) for k, v in parse_qsl(s.query, keep_blank_values=False)
        if not (k.lower() in _TRACKING_EXACT or k.lower().startswith(_TRACKING_PREFIXES))
    ]
    keep.sort()

    path = s.path or "/"
    if len(path) > 1 and path.endswith("/"):
        path = path[:-1]

    return urlunsplit((s.scheme.lower(), host + port, path, urlencode(keep), ""))


def host_of(url: str) -> str:
    try:
        return (urlsplit(url).hostname or "").lower()
    except ValueError:
        return ""


def registrable(host: str) -> str:
    """A crude eTLD+1 for outlet grouping.

    Deliberately crude: it exists to say "these two URLs are the same newsroom",
    which two labels achieve for almost every case, with a hardcoded allowance for
    the compound suffixes that actually matter here (.co.in, .co.uk, .gov.in).
    """
    parts = [p for p in host.split(".") if p]
    if len(parts) <= 2:
        return host
    if parts[-2] in {"co", "com", "net", "org", "gov", "ac", "nic"} and len(parts[-1]) <= 3:
        return ".".join(parts[-3:])
    return ".".join(parts[-2:])


def _is_public_ip(addr: str) -> bool:
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        return False
    return not (
        ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast
        or ip.is_reserved or ip.is_unspecified
        # 169.254.169.254 is link-local and already covered; this is belt-and-braces
        # for the address every cloud metadata service lives on.
        or str(ip) in {"169.254.169.254", "100.100.100.200"}
    )


async def resolves_public(host: str) -> tuple[bool, str]:
    """Resolve a host and require EVERY address to be public.

    Any-address-public is not good enough: a hostname with one public and one
    private A record would let an attacker win the race. Returns (ok, reason).
    """
    if not host:
        return False, "no host"
    # A literal IP needs no DNS and must still pass.
    try:
        ipaddress.ip_address(host)
        return (True, "") if _is_public_ip(host) else (False, f"non-public address {host}")
    except ValueError:
        pass
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    except OSError as e:
        return False, f"dns failed: {e.__class__.__name__}"
    addrs = {i[4][0] for i in infos}
    if not addrs:
        return False, "dns returned nothing"
    bad = [a for a in addrs if not _is_public_ip(a)]
    if bad:
        return False, f"resolves to non-public address {bad[0]}"
    return True, ""


class Fetcher:
    """A shared, bounded HTTP client for the whole run.

    One client per service (connection reuse matters when a run touches 80 URLs),
    with a semaphore per host so a subject whose coverage happens to sit on one
    newsroom does not hammer it.
    """

    def __init__(self) -> None:
        self._client: httpx.AsyncClient | None = None
        self._host_locks: dict[str, asyncio.Semaphore] = {}
        self._robots: dict[str, tuple[RobotFileParser | None, float]] = {}
        self._robots_locks: dict[str, asyncio.Lock] = {}

    async def start(self) -> None:
        if self._client is None:
            self._client = httpx.AsyncClient(
                headers={
                    "User-Agent": settings.user_agent,
                    "Accept-Language": "en-IN,en;q=0.9,kn;q=0.8,hi;q=0.7",
                    "Accept": "text/html,application/xhtml+xml,application/pdf,*/*;q=0.6",
                },
                # Redirects are followed manually so every hop can be re-checked
                # against the SSRF rules. httpx's own following would skip that.
                follow_redirects=False,
                timeout=httpx.Timeout(settings.fetch_timeout_s),
                http2=True,
                limits=httpx.Limits(max_connections=40, max_keepalive_connections=20),
            )

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    def _host_lock(self, host: str) -> asyncio.Semaphore:
        lock = self._host_locks.get(host)
        if lock is None:
            lock = asyncio.Semaphore(settings.per_host_concurrency)
            self._host_locks[host] = lock
        return lock

    async def allowed_by_robots(self, url: str) -> tuple[bool, str]:
        """Check robots.txt, cached for an hour, failing OPEN.

        Failing open is the deliberate choice: a robots.txt that times out is an
        infrastructure problem, not a refusal, and treating every unreachable
        robots.txt as a denial would silently gut coverage. A robots.txt we can read
        is always obeyed.
        """
        host = host_of(url)
        if not host:
            return False, "no host"
        cached = self._robots.get(host)
        if cached and time.time() - cached[1] < 3600:
            rp = cached[0]
            return (True, "") if rp is None else (rp.can_fetch(settings.user_agent, url), "robots")

        lock = self._robots_locks.setdefault(host, asyncio.Lock())
        async with lock:
            cached = self._robots.get(host)
            if cached and time.time() - cached[1] < 3600:
                rp = cached[0]
                return (True, "") if rp is None else (rp.can_fetch(settings.user_agent, url), "robots")
            rp: RobotFileParser | None = None
            try:
                assert self._client is not None
                scheme = urlsplit(url).scheme or "https"
                r = await self._client.get(f"{scheme}://{host}/robots.txt",
                                           timeout=httpx.Timeout(6.0))
                if r.status_code == 200 and len(r.content) < 512_000:
                    rp = RobotFileParser()
                    rp.parse(r.text.splitlines())
            except Exception:
                rp = None
            self._robots[host] = (rp, time.time())
        if rp is None:
            return True, ""
        ok = rp.can_fetch(settings.user_agent, url)
        return ok, "" if ok else "disallowed by robots.txt"

    async def get(self, url: str, *, respect_robots: bool = True,
                  max_bytes: int | None = None, timeout_s: int | None = None,
                  accept: str | None = None) -> dict:
        """Fetch one URL safely.

        Returns a dict rather than raising, because in this pipeline a failed fetch
        is data — the officer is told the link exists and could not be read, which is
        more useful than the link silently vanishing.
        """
        await self.start()
        assert self._client is not None
        cap = max_bytes or settings.max_bytes
        out = {"url": url, "final_url": url, "status": 0, "content": b"",
               "content_type": "", "error": "", "hops": 0}

        current = url
        for hop in range(4):
            out["hops"] = hop
            if urlsplit(current).scheme.lower() not in _ALLOWED_SCHEMES:
                out["error"] = "scheme not allowed"
                return out
            host = host_of(current)
            ok, why = await resolves_public(host)
            if not ok:
                out["error"] = f"blocked: {why}"
                return out
            if respect_robots and hop == 0:
                allowed, reason = await self.allowed_by_robots(current)
                if not allowed:
                    out["error"] = reason or "disallowed"
                    return out

            headers = {"Accept": accept} if accept else None
            try:
                async with self._host_lock(host):
                    req = self._client.build_request(
                        "GET", current, headers=headers,
                        timeout=httpx.Timeout(timeout_s or settings.fetch_timeout_s))
                    resp = await self._client.send(req, stream=True)
                    try:
                        out["status"] = resp.status_code
                        out["content_type"] = resp.headers.get("content-type", "")
                        if resp.is_redirect:
                            loc = resp.headers.get("location", "")
                            if not loc:
                                out["error"] = f"redirect {resp.status_code} without location"
                                return out
                            current = str(httpx.URL(current).join(loc))
                            continue
                        declared = int(resp.headers.get("content-length") or 0)
                        if declared and declared > cap:
                            out["error"] = f"too large ({declared} bytes)"
                            return out
                        buf = bytearray()
                        async for chunk in resp.aiter_bytes():
                            buf.extend(chunk)
                            if len(buf) > cap:
                                out["error"] = "too large (stream)"
                                return out
                        out["content"] = bytes(buf)
                        out["final_url"] = str(resp.url)
                        return out
                    finally:
                        await resp.aclose()
            except httpx.TimeoutException:
                out["error"] = "timeout"
                return out
            except Exception as e:  # noqa: BLE001 — a failed fetch is a reportable outcome
                out["error"] = f"{e.__class__.__name__}: {str(e)[:120]}"
                return out

        out["error"] = "too many redirects"
        return out

    async def get_json(self, url: str, *, timeout_s: int | None = None) -> dict | list | None:
        """Fetch a machine API. robots.txt is not consulted for these.

        The JSON endpoints this engine uses (GDELT, Wikipedia, the Wayback CDX) are
        published for programmatic use; applying a robots rule written for crawlers
        to a documented API would block the very access it is offered for.
        """
        r = await self.get(url, respect_robots=False, max_bytes=8 * 1024 * 1024,
                           timeout_s=timeout_s or settings.search_timeout_s,
                           accept="application/json")
        if r["error"] or r["status"] != 200 or not r["content"]:
            return None
        import json
        try:
            return json.loads(r["content"].decode("utf-8", "replace"))
        except ValueError:
            return None


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class RateLimiter:
    """Minimum spacing between calls to one upstream, process-wide.

    Written for GDELT, which asks for one request every five seconds and answers a
    faster caller with HTTP 429 and a plain-text scolding — a response that parses as
    "no articles found" if you are not looking for it. A source that silently
    degrades to zero results is worse than one that is plainly down, so the limit is
    respected rather than discovered.

    Also the right thing to do: GDELT is free, keyless and maintained by one person.
    """

    def __init__(self, min_interval_s: float) -> None:
        self.min_interval_s = min_interval_s
        self._lock = asyncio.Lock()
        self._last = 0.0

    async def acquire(self) -> float:
        """Wait until the next call is allowed. Returns how long it waited."""
        async with self._lock:
            now = time.monotonic()
            wait = self.min_interval_s - (now - self._last)
            if wait > 0:
                await asyncio.sleep(wait)
            self._last = time.monotonic()
            return max(0.0, wait)
