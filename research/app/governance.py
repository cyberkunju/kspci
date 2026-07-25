"""The rules that decide whether a run may happen at all.

This engine searches the open web for named individuals on behalf of a police force.
That is lawful, ordinary investigative practice, and it is also the exact shape of
thing that becomes surveillance if built without limits. The limits are here, in front
of the pipeline, rather than in a policy document nobody enforces.

Four of them:

  PURPOSE BINDING. A run states why it is being made, and it is recorded. There is no
  anonymous lookup. This is the difference between an investigation and a fishing trip,
  and the only way an audit can later ask whether a search was justified.

  SUBJECT-TYPE GATE. Victims, complainants and witnesses are refused. They are members
  of the public whose contact with the police was not their choosing, and researching
  their open-source footprint is not investigation.

  ROLE GATE. Person-level research requires an operational role. The read-only
  policymaker role gets aggregate work, not people.

  RATE LIMIT. Per officer, per day. A researcher who needs sixty subjects in a day is
  doing something this tool was not built for, and the cap makes that visible.

Nothing here is expensive or clever. It is all cheap, and it is what makes the rest of
the engine defensible.
"""

from __future__ import annotations

import json
import re
import sys
import time
from dataclasses import dataclass

#: Roles permitted to research a named person. Mirrors the KSP2 API's own RBAC so the
#: same officer cannot reach further by switching channel.
PERSON_ROLES = {"investigator", "analyst", "supervisor", "admin"}
ANY_ROLES = PERSON_ROLES | {"policymaker"}

#: Subject roles this engine will not research. Not configurable on purpose.
REFUSED_SUBJECT_ROLES = {"victim", "complainant", "witness", "informant", "minor"}

VALID_KINDS = {"person", "crime", "event", "organisation", "identifier", "topic"}

_MIN_PURPOSE_WORDS = 3

# A purpose that is technically present and says nothing. Rejected, because a binding
# that accepts "checking" is not a binding.
_EMPTY_PURPOSE = re.compile(
    r"^(?:test|testing|check|checking|research|verify|verification|info|information|"
    r"work|task|asdf|n/?a|none|na|\.|-)+$", re.I)


@dataclass
class Decision:
    allowed: bool
    reason: str = ""
    code: str = ""


def authorise(*, kind: str, role: str, purpose: str, subject: str,
              subject_role: str = "", crime_number: str = "") -> Decision:
    """Decide whether this run may proceed. Deterministic and cheap."""
    kind = (kind or "").strip().lower()
    role = (role or "").strip().lower()
    subject = " ".join((subject or "").split())

    if kind not in VALID_KINDS:
        return Decision(False, f"unknown subject kind '{kind}'", "bad_kind")
    if len(subject) < 2:
        return Decision(False, "a subject is required", "no_subject")
    if len(subject) > 200:
        return Decision(False, "the subject is implausibly long", "bad_subject")

    allowed_roles = PERSON_ROLES if kind == "person" else ANY_ROLES
    if role not in allowed_roles:
        return Decision(
            False,
            f"the {role or 'unknown'} role may not run {kind} research"
            + (" — person-level research needs an operational role" if kind == "person" else ""),
            "role")

    words = [w for w in re.split(r"\W+", purpose or "") if w]
    if len(words) < _MIN_PURPOSE_WORDS or _EMPTY_PURPOSE.match("".join(words)):
        return Decision(
            False,
            "state why this research is needed, in a few words — it is recorded against "
            "your name and against the case",
            "purpose")

    if (subject_role or "").strip().lower() in REFUSED_SUBJECT_ROLES:
        return Decision(
            False,
            f"this person is recorded as a {subject_role}. Open-source research is for "
            "suspects and subjects of investigation, not for the people who reported a "
            "crime or were harmed by one",
            "subject_role")

    return Decision(True)


def audit(event: str, **fields) -> None:
    """One structured line per governed action, to stdout.

    Catalyst captures stdout, so this is the audit trail without a second store to keep
    — which matters for an engine that deliberately persists nothing else. Kept to one
    line of JSON so it can be grepped and shipped.
    """
    payload = {"event": event, "ts": round(time.time(), 3)}
    for k, v in fields.items():
        if v is None or v == "":
            continue
        payload[k] = v if isinstance(v, (int, float, bool)) else str(v)[:300]
    print("RESEARCH_AUDIT " + json.dumps(payload, ensure_ascii=False), file=sys.stdout, flush=True)


class DailyCap:
    """Per-officer daily run cap, in memory.

    In memory is honest for this deployment: the service is a single always-on instance
    and the counter resets if it restarts. It is a guard-rail against runaway use, not a
    billing control, and pretending otherwise would mean building a store this engine
    was explicitly asked not to have.
    """

    def __init__(self, limit: int = 40) -> None:
        self.limit = limit
        self._counts: dict[tuple[str, str], int] = {}

    def _key(self, officer: str) -> tuple[str, str]:
        return (officer or "unknown", time.strftime("%Y-%m-%d", time.gmtime()))

    def check(self, officer: str) -> Decision:
        used = self._counts.get(self._key(officer), 0)
        if used >= self.limit:
            return Decision(
                False,
                f"you have run {used} research requests today, which is the daily limit. "
                "Contact your control room if this is urgent.",
                "rate")
        return Decision(True)

    def record(self, officer: str) -> int:
        k = self._key(officer)
        self._counts[k] = self._counts.get(k, 0) + 1
        # Keep only today's keys; the map is otherwise unbounded over a long uptime.
        today = k[1]
        for key in [x for x in self._counts if x[1] != today]:
            self._counts.pop(key, None)
        return self._counts[k]


#: The notice attached to every result. Open-source material is not evidence, and a
#: research product that does not say so will eventually be read as though it were.
DISCLAIMER = (
    "Open-source material, retrieved automatically and not verified by KSP. It is not "
    "evidence and is not grounds for action against any person. Attribution bands state "
    "how confident the engine is that a source refers to this subject; anything below "
    "'confirmed' needs human checking before it is relied on."
)
