"""Turn retrieved bytes into an article.

Trafilatura does the hard part — deciding which of a page's text is the story and
which is navigation, related-links and cookie notices. That decision is the
difference between a claim extractor reading a news report and reading a sidebar of
unrelated headlines, so it is worth a dependency and not worth writing ourselves.

Three things this module adds on top:

  * PDFs. Judgments, gazettes and advisories are PDFs, and a research engine for a
    police force that cannot read a judgment is not finished.
  * Outlet identity and language, needed by clustering and by the officer.
  * An injection screen. Page text is untrusted input that an adversary can publish
    on purpose; it is flagged here so the synthesis prompt can be told it is data.
"""

from __future__ import annotations

import io
import json
import re

import trafilatura
from trafilatura.settings import use_config

from .models import Document, Tier
from .net import host_of, registrable, sha256

# Trafilatura's default config reads a user file and applies a signal timeout that
# does not exist off the main thread. Both are wrong inside an async service.
_TRAF = use_config()
_TRAF.set("DEFAULT", "EXTRACTION_TIMEOUT", "0")

_KANNADA = re.compile(r"[\u0C80-\u0CFF]")
_DEVANAGARI = re.compile(r"[\u0900-\u097F]")

# Text that only appears when a page is talking to a model rather than a reader.
# Kept to high-signal patterns: a screenful of false positives trains everyone to
# ignore the flag.
_INJECTION = [
    re.compile(r"ignore\s+(?:all\s+|any\s+|your\s+|the\s+)?(?:previous\s+|prior\s+|above\s+)?(?:instructions?|rules?|prompts?)", re.I),
    re.compile(r"disregard\s+(?:all\s+|your\s+|the\s+)?(?:previous\s+|prior\s+)?instructions?", re.I),
    re.compile(r"(?:system|developer)\s*(?:prompt|message)\s*[:=]", re.I),
    re.compile(r"you\s+are\s+now\s+(?:a|an|in)\b", re.I),
    re.compile(r"(?:reveal|print|repeat|dump)\s+(?:your|the)\s+(?:system\s+)?(?:prompt|instructions)", re.I),
    re.compile(r"\bas\s+an?\s+AI\s+(?:language\s+)?model\b.{0,80}\byou\s+must\b", re.I),
]


def screen_injection(text: str) -> list[str]:
    hits: list[str] = []
    for rx in _INJECTION:
        m = rx.search(text or "")
        if m:
            hits.append(m.group(0)[:80])
        if len(hits) >= 3:
            break
    return hits


def guess_language(text: str) -> str:
    """Script-based, and honest about it.

    Script detection is decisive for Kannada and Devanagari and says nothing about
    which Latin-script language a page is in. That is enough here: the officer needs
    to know a source is Kannada, and everything else is treated as English-or-other.
    """
    sample = (text or "")[:4000]
    if not sample.strip():
        return ""
    if _KANNADA.search(sample):
        return "kn"
    if _DEVANAGARI.search(sample):
        return "hi"
    return "en"


def _pdf_text(data: bytes, max_pages: int = 40) -> str:
    try:
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(data))
        parts = []
        for page in reader.pages[:max_pages]:
            try:
                parts.append(page.extract_text() or "")
            except Exception:  # noqa: BLE001 — one bad page must not lose the document
                continue
        return re.sub(r"\n{3,}", "\n\n", "\n".join(parts)).strip()
    except Exception:
        return ""


def _clean(text: str) -> str:
    text = re.sub(r"[ \t\u00a0]+", " ", text or "")
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def extract(*, url: str, final_url: str, content: bytes, content_type: str,
            tier: Tier, status: int, via: list[str], error: str = "") -> Document:
    """Build a Document from a fetch result. Never raises."""
    doc = Document(url=url, final_url=final_url or url, status=status, tier=tier,
                   via=list(via), bytes=len(content or b""), error=error)
    if error or not content:
        doc.error = error or "empty response"
        return doc

    doc.sha256 = sha256(content)
    host = host_of(doc.final_url)
    doc.outlet = registrable(host)

    ctype = (content_type or "").lower()
    if "pdf" in ctype or doc.final_url.lower().endswith(".pdf"):
        doc.text = _clean(_pdf_text(content))
        if not doc.text:
            doc.error = "pdf yielded no text"
        doc.title = doc.title or doc.final_url.rsplit("/", 1)[-1]
    else:
        html = content.decode("utf-8", "replace")
        # favor_precision: a research engine would rather lose a paragraph than
        # absorb a block of unrelated headlines into an article it is about to
        # extract factual claims from.
        raw = trafilatura.extract(
            html, url=doc.final_url, config=_TRAF,
            output_format="json", with_metadata=True,
            include_comments=False, include_tables=True,
            favor_precision=True,
        )
        if raw:
            try:
                meta = json.loads(raw)
            except ValueError:
                meta = {}
            doc.text = _clean(meta.get("text") or "")
            doc.title = (meta.get("title") or "").strip()
            doc.published = (meta.get("date") or "").strip()
            doc.author = (meta.get("author") or "").strip()
            if meta.get("sitename"):
                doc.outlet = str(meta["sitename"]).strip()[:80] or doc.outlet
        if not doc.text:
            # A precision-first pass returns nothing on some templates. Retry once
            # with recall favoured before declaring the page unreadable — the
            # alternative is telling an officer a real article could not be read.
            fallback = trafilatura.extract(html, url=doc.final_url, config=_TRAF,
                                           favor_recall=True, include_comments=False)
            doc.text = _clean(fallback or "")
        if not doc.text:
            doc.error = "no article text found"

    doc.language = guess_language(doc.text)
    if doc.text:
        doc.injection_flags = screen_injection(doc.text)
    return doc
