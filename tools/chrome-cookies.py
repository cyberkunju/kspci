#!/usr/bin/env python3
"""Export a domain's cookies from the local Chrome profile as Playwright-ready JSON.

Why this is needed. The Catalyst console has no CLI for schema changes, so the Data Store
migration has to go through the browser. The Playwright MCP server runs its own profile, which
is not signed in, and the Chrome DevTools MCP requires an X server this machine does not have.
Chrome itself is signed in — but every Zoho session cookie is marked non-persistent, so a second
Chrome launched on a copy of the profile discards them and lands on the sign-in page.

Reading them out of the profile database and injecting them into a CDP-attached context is the
way through. Chrome on Linux with no keyring daemon uses the "basic" password store, whose key
is PBKDF2-HMAC-SHA1 of a fixed passphrase — documented and stable, not a bypass of anything.

Usage:
    python3 tools/chrome-cookies.py zoho > /tmp/cookies.json
"""

import base64
import hashlib
import json
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

from Crypto.Cipher import AES

PROFILE = Path.home() / ".config/google-chrome/Default/Cookies"
# Session cookies live in the running browser's memory and the on-disk copy is rewritten
# without them, so a snapshot of the database taken while the session is live is often the only
# place they exist. Pass one as argv[2].
# Chrome's Linux "basic" store constants.
PASSPHRASE, SALT, ITERATIONS, IV = b"peanuts", b"saltysalt", 1, b" " * 16


def decrypt(blob: bytes, key: bytes) -> str:
    if not blob:
        return ""
    if blob[:3] not in (b"v10", b"v11"):
        return blob.decode("utf-8", "replace")
    body = blob[3:]
    if len(body) % 16:
        body = body[: len(body) - (len(body) % 16)]
    plain = AES.new(key, AES.MODE_CBC, IV).decrypt(body)
    if plain:
        pad = plain[-1]
        if 1 <= pad <= 16:
            plain = plain[:-pad]
    # Chrome 130+ prefixes the plaintext with a 32-byte domain hash. Detect it rather than
    # assume: a real cookie value is printable, a hash generally is not.
    if len(plain) > 32 and not plain[:32].isascii():
        plain = plain[32:]
    return plain.decode("utf-8", "replace")


def main() -> int:
    needle = sys.argv[1] if len(sys.argv) > 1 else "zoho"
    src = Path(sys.argv[2]) if len(sys.argv) > 2 else PROFILE
    key = hashlib.pbkdf2_hmac("sha1", PASSPHRASE, SALT, ITERATIONS, 16)

    # The live browser holds a lock on the database, so work on a copy.
    tmp = Path(tempfile.mkdtemp()) / "Cookies"
    shutil.copy(src, tmp)
    con = sqlite3.connect(str(tmp))
    rows = con.execute(
        "SELECT host_key, name, encrypted_value, path, is_secure, is_httponly, expires_utc "
        "FROM cookies WHERE host_key LIKE ?", (f"%{needle}%",)
    ).fetchall()

    out = []
    for host, name, enc, path, secure, httponly, expires in rows:
        value = decrypt(enc, key)
        if not value:
            continue
        out.append({
            "name": name, "value": value, "domain": host, "path": path or "/",
            "secure": bool(secure), "httpOnly": bool(httponly),
            # Chrome stores microseconds since 1601; 0 means a session cookie, which Playwright
            # expresses as expires -1.
            "expires": -1 if not expires else (expires / 1_000_000) - 11644473600,
            "sameSite": "Lax",
        })
    json.dump(out, sys.stdout)
    print(f"\n{len(out)} cookies for *{needle}*", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
