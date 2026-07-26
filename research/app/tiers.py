"""Which sources count for more, and where to ask them directly.

This is the least glamorous file in the engine and one of the most important. A
general web search ranks by popularity, which systematically buries the judgment,
the gazette notification and the police press release under the twelve aggregators
that reprinted a summary of them. For a police research tool that ranking is
backwards, so authority is asserted here explicitly instead of being inferred.

The registry does two jobs:

  1. `tier_for()` grades a retrieved document, which drives corroboration counting
     and whether a claim may enter the summary at all.
  2. `ONSITE` lists sources worth querying AT SOURCE rather than through a search
     engine. For an authoritative publisher that is simply the correct method: a
     court's own search knows its own judgments better than any crawler does, and
     it works from a datacenter IP when Google does not.

Kannada outlets are first-class here, not an afterthought. A crime reported in
Mysuru is often covered in Kannada first and in English later or never.
"""

from __future__ import annotations

from .models import Tier
from .net import registrable

# ── official / judicial / regulatory ────────────────────────────────────────────
OFFICIAL: set[str] = {
    "indiankanoon.org", "ecourts.gov.in", "districts.ecourts.gov.in", "judgments.ecourts.gov.in",
    "sci.gov.in", "main.sci.gov.in", "supremecourt.gov.in", "karnatakajudiciary.kar.nic.in",
    "egazette.gov.in", "egazette.nic.in", "pib.gov.in",
    "ksp.gov.in", "ksp.karnataka.gov.in", "karnataka.gov.in", "bengalurucitypolice.gov.in",
    "cybercrime.gov.in", "cert-in.org.in", "csk.gov.in",
    "rbi.org.in", "sebi.gov.in", "irdai.gov.in", "npci.org.in", "trai.gov.in",
    "mca.gov.in", "incometax.gov.in", "enforcementdirectorate.gov.in", "cbi.gov.in",
    "nia.gov.in", "ncrb.gov.in", "mha.gov.in", "meity.gov.in",
}

# ── established newsrooms ───────────────────────────────────────────────────────
NEWS_EN: set[str] = {
    "thehindu.com", "deccanherald.com", "indianexpress.com", "newindianexpress.com",
    "indiatimes.com", "hindustantimes.com", "ndtv.com", "thenewsminute.com",
    "deccanchronicle.com", "telegraphindia.com", "theprint.in", "thewire.in",
    "scroll.in", "livemint.com", "business-standard.com", "indiatoday.in",
    "news18.com", "firstpost.com", "thequint.com", "moneycontrol.com",
    "bbc.com", "bbc.co.uk", "reuters.com", "aljazeera.com", "theguardian.com",
    "barandbench.com", "livelaw.in", "medianama.com",
}

# Hindi and north-Indian press. Added because the engine had a structural blind spot:
# a wanted man in Baghpat, covered the same day by six Hindi outlets, graded as no
# coverage at all — every source in the registry was Karnataka, national English or
# Kannada. Crime reporting in India is local and vernacular first, so a registry that
# only knows one language only knows one part of the country.
NEWS_HI: set[str] = {
    "amarujala.com", "jagran.com", "bhaskar.com", "divyabhaskar.co.in",
    "aajtak.in", "abplive.com", "livehindustan.com", "patrika.com",
    "navbharattimes.indiatimes.com", "jansatta.com", "naidunia.com",
    "punjabkesari.in", "dainiktribuneonline.com", "prabhatkhabar.com",
    "hindi.news18.com", "hindi.oneindia.com", "ndtv.in", "khabar.ndtv.com",
    "zeenews.india.com", "tv9hindi.com", "amarujala.co.in",
}

NEWS_KN: set[str] = {
    "prajavani.net", "vijaykarnataka.com", "vijayakarnataka.com", "kannadaprabha.com",
    "udayavani.com", "vijayavani.net", "tv9kannada.com", "publictv.in",
    "suvarnanews.com", "asianetnews.com", "hosadigantha.com", "samyuktakarnataka.com",
    "kannada.news18.com", "kannada.oneindia.com", "kannadadunia.com", "eesanje.com",
}

# ── syndicators and re-publishers ───────────────────────────────────────────────
# Not lesser journalism, but usually carrying somebody else's report. Grading them
# separately is what stops one wire story counting as many confirmations.
AGGREGATOR: set[str] = {
    "webindia123.com", "aninews.in", "ptinews.com", "uniindia.com", "ians.in",
    "msn.com", "yahoo.com", "news.google.com", "flipboard.com", "dailyhunt.in",
    "inshorts.com", "latestly.com", "devdiscourse.com", "zeenews.india.com",
    "newsbytesapp.com", "opindia.com", "thehansindia.com", "freepressjournal.in",
}

REFERENCE: set[str] = {"wikipedia.org", "wikidata.org", "wikimedia.org", "britannica.com"}

COMMUNITY: set[str] = {
    "reddit.com", "quora.com", "stackexchange.com", "consumercomplaints.in",
    "complaintboard.in", "mouthshut.com", "tripadvisor.in",
}

SOCIAL: set[str] = {
    "twitter.com", "x.com", "facebook.com", "instagram.com", "linkedin.com",
    "youtube.com", "t.me", "threads.net",
}


def tier_for(url_or_host: str) -> Tier:
    """Grade a source. Unknown domains are treated as community-grade.

    Unknown means unknown: a domain nobody has vouched for gets neither the benefit
    of the doubt nor an outright dismissal. It is retrieved, listed and shown to the
    officer, but it cannot on its own carry a claim into the summary.
    """
    host = url_or_host
    if "//" in host:
        from .net import host_of
        host = host_of(host)
    host = (host or "").lower().lstrip(".")
    if not host:
        return Tier.UNKNOWN
    reg = registrable(host)

    for group, tier in (
        (OFFICIAL, Tier.OFFICIAL),
        (NEWS_EN, Tier.NEWS),
        (NEWS_KN, Tier.NEWS),
        (NEWS_HI, Tier.NEWS),
        (AGGREGATOR, Tier.AGGREGATOR),
        (REFERENCE, Tier.REFERENCE),
        (COMMUNITY, Tier.COMMUNITY),
        (SOCIAL, Tier.SOCIAL),
    ):
        if host in group or reg in group:
            return tier
    # Any government or judiciary domain is official whether or not it is listed.
    if host.endswith((".gov.in", ".nic.in", ".gov", ".gouv.fr")) or ".gov." in host:
        return Tier.OFFICIAL
    if host.endswith((".ac.in", ".edu")):
        return Tier.REFERENCE
    return Tier.UNKNOWN


def is_kannada_outlet(url_or_host: str) -> bool:
    host = url_or_host
    if "//" in host:
        from .net import host_of
        host = host_of(host)
    host = (host or "").lower()
    return host in NEWS_KN or registrable(host) in NEWS_KN


# ── sources worth querying at source ────────────────────────────────────────────
#
# `{q}` is replaced with the URL-encoded query. `kind` tells the adapter how to read
# the response. These are on-site search endpoints, which is both more accurate than
# asking a search engine about the same site and more reliable from a datacenter.
#
# Every entry here is a public search form. Anything requiring a session, a CAPTCHA
# or a bulk-data agreement is deliberately absent — where a source restricts
# automated access, the run reports it as unreachable rather than working around it.

ONSITE: list[dict] = [
    # Judgments and legal reporting.
    {"name": "indiankanoon", "tier": Tier.OFFICIAL, "lang": "en",
     "url": "https://indiankanoon.org/search/?formInput={q}", "kind": "html",
     "link_contains": "/doc/"},
    {"name": "livelaw", "tier": Tier.NEWS, "lang": "en",
     "url": "https://www.livelaw.in/search?q={q}", "kind": "html"},
    {"name": "barandbench", "tier": Tier.NEWS, "lang": "en",
     "url": "https://www.barandbench.com/search?q={q}", "kind": "html"},

    # English newsrooms with cooperative on-site search.
    {"name": "thehindu", "tier": Tier.NEWS, "lang": "en",
     "url": "https://www.thehindu.com/search/?q={q}", "kind": "html"},
    {"name": "deccanherald", "tier": Tier.NEWS, "lang": "en",
     "url": "https://www.deccanherald.com/search?q={q}", "kind": "html"},
    {"name": "thenewsminute", "tier": Tier.NEWS, "lang": "en",
     "url": "https://www.thenewsminute.com/search?q={q}", "kind": "html"},
    {"name": "indianexpress", "tier": Tier.NEWS, "lang": "en",
     "url": "https://indianexpress.com/?s={q}", "kind": "html"},

    # Kannada. The reason this engine can see a Mysuru case that never reached
    # English coverage.
    {"name": "prajavani", "tier": Tier.NEWS, "lang": "kn",
     "url": "https://www.prajavani.net/search?q={q}", "kind": "html"},
    {"name": "kannadaprabha", "tier": Tier.NEWS, "lang": "kn",
     "url": "https://www.kannadaprabha.com/search?q={q}", "kind": "html"},
    {"name": "udayavani", "tier": Tier.NEWS, "lang": "kn",
     "url": "https://www.udayavani.com/?s={q}", "kind": "html"},
    {"name": "vijaykarnataka", "tier": Tier.NEWS, "lang": "kn",
     "url": "https://vijaykarnataka.com/search?q={q}", "kind": "html"},

    # National English whose on-site search returns real article urls. Probed rather
    # than assumed: of two dozen candidates tested against a live subject, most Indian
    # newsrooms answer /search with a JavaScript shell and hand a crawler their front
    # page. These two returned the actual story, so these two are here. The rest of the
    # country is reached through the news-feed tier instead, which is the honest place
    # for it — see sources.bing_news.
    {"name": "theprint", "tier": Tier.NEWS, "lang": "en",
     "url": "https://theprint.in/?s={q}", "kind": "html"},
    {"name": "newindianexpress", "tier": Tier.NEWS, "lang": "en",
     "url": "https://www.newindianexpress.com/search?q={q}", "kind": "html"},
]
