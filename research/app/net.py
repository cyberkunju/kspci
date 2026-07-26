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

#: Hosts that have answered 429, and the instant they said we may return. Module-level
#: on purpose: a rate limit is a property of OUR IP, not of one run, so a penalty
#: discovered by one run must be visible to the next. This is the single most expensive
#: thing we got wrong — GDELT rate-limited us on every live run of a testing session
#: because each run cheerfully re-asked while the previous penalty was still active.
_HOST_PENALTY: dict[str, float] = {}

#: Used when a 429 carries no Retry-After. Long enough to outlast a per-minute quota
#: without writing off a source for the whole run.
_DEFAULT_PENALTY_S = 120.0

#: A Retry-After further out than this is treated as "not within this run's lifetime"
#: rather than slept on. Nothing here ever waits for a penalty; it records and moves on.
_MAX_PENALTY_S = 900.0


def _retry_after_seconds(value: str | None) -> float | None:
    """Parse Retry-After. It is legally either a delay in seconds or an HTTP date."""
    raw = (value or "").strip()
    if not raw:
        return None
    if raw.isdigit():
        return min(float(raw), _MAX_PENALTY_S)
    try:
        from email.utils import parsedate_to_datetime
        when = parsedate_to_datetime(raw)
    except (TypeError, ValueError):
        return None
    if when is None:
        return None
    import datetime as _dt
    now = _dt.datetime.now(_dt.timezone.utc)
    if when.tzinfo is None:
        when = when.replace(tzinfo=_dt.timezone.utc)
    return max(0.0, min((when - now).total_seconds(), _MAX_PENALTY_S))


def host_penalty_remaining(host: str) -> float:
    """Seconds left on a host's rate-limit penalty, 0 when it may be called."""
    until = _HOST_PENALTY.get((host or "").lower(), 0.0)
    return max(0.0, until - time.monotonic())


def note_rate_limited(host: str, retry_after: str | None = None) -> float:
    """Record a 429. Returns the penalty length in seconds.

    Deliberately no retry. A 429 is the server saying we are over quota, and asking
    again — even politely, even later in the same run — is how a temporary throttle
    becomes a ban. The technique is Hermes Agent's (MIT); their comment puts it well:
    retrying when the upstream says you are over quota only wastes time.
    """
    wait = _retry_after_seconds(retry_after)
    if wait is None:
        wait = _DEFAULT_PENALTY_S
    _HOST_PENALTY[(host or "").lower()] = time.monotonic() + wait
    return wait


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


#: Addresses that must never be reached, whatever else the classification says.
#: Every cloud provider puts credentials on one of these, so this is the floor.
#: The `::ffff:` duplicates are not redundant: Python's `ipaddress` treats an
#: IPv4-mapped IPv6 address as a distinct object, so a set membership test on the
#: bare IPv4 form silently misses `::ffff:169.254.169.254`. See `_is_public_ip`,
#: which also unwraps the mapping — this set is the belt to that braces.
_METADATA_ADDRESSES = {
    "169.254.169.254",          # AWS / GCP / Azure / DigitalOcean / Oracle IMDS
    "169.254.170.2",            # ECS task metadata — hands out task IAM credentials
    "169.254.169.253",          # Azure IMDS wire server
    "100.100.100.200",          # Alibaba Cloud
    "fd00:ec2::254",            # AWS IPv6 metadata
    "::ffff:169.254.169.254", "::ffff:169.254.170.2",
    "::ffff:169.254.169.253", "::ffff:100.100.100.200",
}

#: Hostnames that resolve to a metadata service. Blocked on the NAME, before any DNS
#: lookup, because a resolver that answers differently from ours would otherwise win.
_METADATA_HOSTS = {"metadata.google.internal", "metadata.goog", "metadata"}

#: RFC 6598 carrier-grade NAT. Python reports this range as neither private nor
#: global, so every `is_private` check misses it — and it is exactly where Tailscale,
#: WireGuard and carrier NAT put internal hosts.
_CGNAT = ipaddress.ip_network("100.64.0.0/10")


def _is_public_ip(addr: str) -> bool:
    """Is this address safe to connect to? Fails closed on anything unparseable."""
    try:
        ip = ipaddress.ip_address(addr.split("%")[0])   # strip IPv6 scope id
    except ValueError:
        return False
    # An IPv4-mapped IPv6 address is the embedded IPv4 address for every purpose that
    # matters here, but none of Python's `is_*` properties look through the mapping.
    # Judge the address it actually reaches.
    mapped = getattr(ip, "ipv4_mapped", None)
    if mapped is not None:
        ip = mapped
    if str(ip) in _METADATA_ADDRESSES or addr in _METADATA_ADDRESSES:
        return False
    if ip.version == 4 and ip in _CGNAT:
        return False
    return not (
        ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast
        or ip.is_reserved or ip.is_unspecified
    )


async def resolves_public(host: str) -> tuple[bool, str]:
    """Resolve a host and require EVERY address to be public.

    Any-address-public is not good enough: a hostname with one public and one
    private A record would let an attacker win the race. Returns (ok, reason).
    """
    if not host:
        return False, "no host"
    # Metadata hostnames are refused before DNS. Resolving them first would mean
    # trusting the resolver to agree with us about where they point.
    if host.rstrip(".") in _METADATA_HOSTS:
        return False, "cloud metadata hostname"
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
            # Do not knock on a door that has just told us to go away. Checked per hop,
            # because a redirect can land on a host that is already penalised.
            left = host_penalty_remaining(host)
            if left:
                out["error"] = f"rate limited by {host}; {int(left)}s left on the penalty"
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
                        if resp.status_code == 429:
                            wait = note_rate_limited(
                                host, resp.headers.get("retry-after"))
                            out["error"] = (f"rate limited by {host} "
                                            f"(retry after {int(wait)}s)")
                            return out
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

    async def post_json(self, url: str, body: str, *, headers: dict[str, str] | None = None,
                        timeout_s: int | None = None) -> dict | None:
        """POST to a machine API that requires it, and parse the JSON reply.

        Separate from `get` on purpose: `get` exists to fetch attacker-influenceable pages
        and carries the whole redirect-by-redirect SSRF defence for that reason. This talks
        to one configured API endpoint with a credential attached, so a redirect is not
        something to follow — it is something to refuse.
        """
        await self.start()
        assert self._client is not None
        host = host_of(url)
        ok, why = await resolves_public(host)
        if not ok:
            return None
        try:
            r = await self._client.post(
                url, content=body.encode("utf-8"), headers=headers or {},
                timeout=httpx.Timeout(timeout_s or settings.search_timeout_s),
                follow_redirects=False)
            if r.status_code != 200:
                return None
            data = r.json()
            return data if isinstance(data, dict) else None
        except Exception:  # noqa: BLE001 — a dead API contributes nothing and says so
            return None

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
