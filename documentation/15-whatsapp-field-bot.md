# 15 · WhatsApp Field-Officer Channel

The dashboard is for a desk. This is the same intelligence platform reached from a
phone an officer already carries, over an app they already trust, while they are
standing in front of the person or the document they are asking about.

Code: `functions/api/lib/wa/` · routes in `functions/api/index.js` · tables 11–13 in
`datastore/SCHEMA.md` · tests in `functions/api/test/wa.test.js`.

---

## What an officer can do

Everything is expressed in natural language — English, Kannada or Hindi, typed or
spoken.
There is no command syntax, no menu, no keyword table.

| The officer sends | What happens |
|---|---|
| "any history on Suresh Kumar" | prior cases, arrests, and — for analyst and above — risk band and known associates |
| a photo of a person | face compared against the enrolled gallery; ranked **candidate leads** with confidence bands |
| a photo + "save this as Suresh Kumar in FIR 4021/2026" | photo enrolled into the gallery against that record |
| a photo of an FIR copy, notice or plate | Zia OCR, identifiers extracted, records looked up |
| a voice note | Sarvam transcribes it (auto-detects Kannada/English) and it runs as a normal request |
| their location | resolved to the nearest district, then used as the area for anything they ask |
| "status of FIR 4021/2026" | full dossier: record, accused, victims, arrests, timeline, similar-case outcomes |
| "what's flagged in Mysuru next month" | live output of the predictive early-warning engine |
| "alert me about Ballari too" / "alerts off" | changes their own push subscription |
| "reply in Hindi" / "ಕನ್ನಡದಲ್ಲಿ ಉತ್ತರ ಕೊಡಿ" | switches language and keeps it that way |
| "reset" | wipes their state and re-runs setup: language, then access context |
| *(nothing — a critical district is flagged)* | proactive push arrives with a one-line AI advisory |

## Setup: `reset` → language → access context

Sending **`reset`** wipes the officer's conversational state and walks them through
setup. Everything derived from past turns goes — the open frame, the language prior,
the undo ledger — but deliberately not their roster identity and not the message
ledger: a reset is an officer restarting a conversation, not erasing the audit trail
of what they were shown.

**Step 1 — language, as three tap buttons.** English, ಕನ್ನಡ, हिन्दी, each label written
in its own script. Offering "Kannada" in Latin letters to someone who reads Kannada is
the same failure the copy pack exists to prevent, one step earlier. The prompt itself
is trilingual and is the only message in the system not taken from a pack, because it
is sent before any language is known and a guess there strands the officer.

**Step 2 — access context**, the five roles the web app uses, as a numbered list
(WhatsApp caps reply buttons at three).

Both steps are **deterministic and never reach the model.** Choosing a language and a
role is a consent decision about identity, so it has the same standing as `help` and
`stop`: it must work when the model is down, which is exactly when an officer reaches
for `reset`. Backing out with "cancel" leaves existing settings untouched rather than
re-asking forever — setup is only ever entered deliberately, so being unable to leave
it would be the trap the frame machine exists to avoid.

### Self-selected roles are a demo affordance

`WA_SELF_ROLE` is **off unless explicitly `true`**, and that default matters. The trust
boundary of this channel is that the role comes from the roster row and never from a
message — it is what stops an investigator talking their way into risk scores and
associate networks. Letting the officer choose mirrors the web app's own
"Demo role · API enforced" selector and is right for a demonstration, but it is a
deliberate relaxation, not a default a deployment should inherit without deciding. It
is enabled in this environment. Every change is audited against the officer's identity
either way, and with it off the setup flow ends after the language step and says so.

### Changing language later

Any explicit request works, in any of the three languages and any phrasing:
"reply in English", "ab se mujhe hindi mein jawab dena", "ಕನ್ನಡದಲ್ಲಿ ಉತ್ತರ ಕೊಡಿ".

This is handled **deterministically**, not by the model, and the reason is a live
failure: asked in romanized Hindi, the model answered in Hindi and never called
`set_language`, so nothing persisted and the next English message would have flipped it
straight back. A named language plus a change word now switches and persists directly.
The `set_language` tool remains for phrasings the detector misses. Naming a language in
passing ("the FIR is written in Kannada") does not switch, and naming two does not
either — that is a comparison, not an instruction.

Once chosen, the language **outranks detection**. It is beaten only by writing in
another script, which is unambiguous; a couple of English function words in an
otherwise Hindi conversation is not. The choice is written to the roster row as well as
the conversation, so a 6am alert composed with no turn in flight still comes out right.

## Why the routing is a model, not a script

A field officer types what they mean, not what a parser expects: *"who's this"*,
*"ee vyaktiya history"*, a bare photo with no caption at all. Any deterministic
router fails on the first phrasing nobody anticipated, and in the field a failed
route means an officer gets nothing and stops using the channel.

So there is exactly one decision-maker: the model. It sees the message, the photo,
the conversation so far, and a catalogue of capabilities filtered to that officer's
role, and it chooses. The deterministic parts are only where determinism is
correct: the signature gate, the roster check, the rate limit, the safety
pre-check, role enforcement, the write gate, and the alert format.

The prompt also carries an explicit instruction for the case that matters most —
**a request nobody designed for**. The model is told to find the underlying
question, answer as close to it as the data allows, and say plainly when something
is general knowledge rather than a record. A reply that only says it did not
understand is treated as a defect of this system, not of the officer: `agent.js`
detects blank refusals and replaces them with the capability card, and every
failure string in `copy.js` names a concrete next move.

## The seven-step dispatch

Order matters here, because each step exists to stop the next one from misreading
the message. This is `agent.handleTurn()`:

| # | Step | Why it is where it is |
|---|---|---|
| 1 | **Language** | Decided before any string is selected, so even the deterministic replies come out in the officer's language |
| 2 | **Undo** | A six-character code is a decision already made. No model involved |
| 3 | **Frame** | If we just asked a question, this message answers *that* question |
| 4 | **`help` / `stop`** | The only two commands that stay deterministic (see below) |
| 5 | **Safety** | The shared `lib/guard` assessment, ahead of the model |
| 6 | **Injection** | Untrusted text is flagged and passed as a warning, never as instruction |
| 7 | **Write gate** | A negated or hypothetical phrasing cannot mint a write, whatever the model decided |
| 8 | **Agent** | Everything else |

Putting the frame resolver *after* the agent — the intuitive order — is what makes
a bot answer "2" with a confused non-answer to its own question.

Steps 5–7 read **the officer's own words**, never the text a resolved frame
produced. That rewrite is authored by the model, and a gate fed model-authored
text is a gate the model can widen. Step 4 is skipped entirely on a resolved
frame for the same reason: a candidate whose `resolve` string happened to be
"stop" must not be able to unsubscribe an officer who only tapped it.

`help` and `stop` are the two exceptions to routing everything through the model.
`help` because it has to work when the model is down — precisely when an officer
reaches for it — and `stop` because switching off proactive alerts is the officer's
own consent decision and must not depend on an LLM being reachable or agreeing. An
opt-out that fails is reported as a failure, never confirmed. Matching is
whole-string only: a substring match would unsubscribe an officer who wrote "stop
the vehicle at the checkpoint".

### Open frames

When a lookup is genuinely ambiguous the model calls `ask_choice`, which stores a
frame on the officer's row: `{v, kind, prompt, options, context, ts, ttlMs,
retries}`. The next message resolves it. Each option carries a `resolve` string —
the fully-specified request the agent receives when that option is picked — so
there is one generic resolver instead of one per frame kind, and no kind can
silently lack a handler.

The lifecycle is designed so an officer can never be trapped: a five-minute TTL,
three retries then release, universal cancel tokens in both languages checked
before the resolver, and release-on-unrelated so a fresh request is never swallowed
by a stale question. Two or three options are sent as tap buttons with positional
ids (`pick:1`), which route independently of the localized title; a tap whose
`context.id` does not match the question we asked is refused as stale.

### Trilingual by construction

Every officer-facing string lives in `lib/wa/copy.js` in English, Kannada and Hindi —
46 keys per pack, and a test asserts the three have identical keys, because a missing
key is exactly how a multilingual bot ends up answering in English.

**Romanized Hindi is far more dangerous than romanized Kannada**, and the lexicon is
shaped by that. It excludes every function word Hindi shares with English — `the` (थे),
`do` (दो), `is` (इस), `to` (तो), `par`, `main`, `mat` — because `the` alone would have
read every English sentence as Hindi. `fir` is excluded because it is FIR, which appears
in most messages on this channel, and `hogi` because Kannada already claims it: one
token cannot be evidence for two languages. Anything under three characters is left out
entirely. Where the two Indic sets tie, and where the officer's prior ties, the decision
goes away from English — leaning English on a tie is the same cardinal sin, just quieter.

Police vocabulary (FIR, CrimeNo, district) is deliberately left in English inside the
Kannada and Hindi copy, because that is how officers here actually write it.
`scripts/lint-wa-copy.mjs` fails the build if any module passes a literal string to a
send, which is the only way an unlocalized reply can reach an officer.

`lib/wa/lang.js` decides per turn, not per officer, from three layers: Kannada
script (decisive), a romanized-Kannada function-word lexicon, and suffix
morphology. Morphology detects but is never counted toward the officer's prior,
because it also fires on English words and a poisoned prior is worse than one
wrongly-read turn. When a turn carries no evidence either way it **fails toward the
officer** — a decaying twelve-turn prior — rather than toward English. Clear English
markers always beat the prior, so the reverse failure is guarded too.

Thresholds are set by the false positives that actually occur, not by symmetry:

- **Two** English markers, never one. A single borrowed English word inside
  romanized Kannada ("mysuru district nalli enide") is ordinary code-mixing, and
  our own Kannada copy borrows *district*, *FIR* and *CrimeNo* by design.
- **Two** morphology hits, and only in a sentence of three or more words. One was
  enough to read "privilege granted here" as Kannada.
- The `-ige` suffix is **excluded**: privilege, prestige, oblige and vestige all
  end that way, and legal prose is the last place to guess.
- Collision-prone lexicon entries are **removed**, not tolerated — `gotta`
  ("you gotta check this"), `togo`, `matte`, and `bedi`, which is a common surname.

Anything that normalizes a token keeps `\p{M}`. Kannada vowel signs and the virama
are combining marks, so stripping them turns ಸಹಾಯ into ಸಹಯ and every Kannada
keyword silently stops matching — a failure invisible to English testing.

### Reversibility and grounding

Both writes the channel can make (enrolling a photo, changing this officer's own
alert subscription) return a six-character undo token, appended by the server so it
is always present when a write happened and never invented when one did not. The
alphabet excludes `I L O 0 1`, and a token must mix at least one digit with at
least one letter — which is what stops `BUDGET` or `234567` from ever reversing an
officer's work. Both the bare code and the natural phrasing are accepted (`A2B3C4`,
`undo A2B3C4`, `ರದ್ದು A2B3C4`); the same digit-and-letter rule keeps the prefixed
form safe, so "undo the enrolment" and "cancel BUDGET" produce nothing.

After the model answers and before the officer sees it, `tools.verifyGrounding()`
checks the identifiers the reply *claims* against the identifiers tools actually
returned, plus whatever the officer supplied themselves. It refuses only the case
that matters: a reply citing identifiers when none can be traced, which is the
signature of an answer produced from the model's memory. A partial mismatch is
logged, not refused — a false refusal teaches officers to distrust the channel.

## Architecture

```
Officer's WhatsApp
      │
      ▼
Meta WhatsApp Cloud API (v25.0)
      │  POST /server/api/whatsapp/webhook
      ▼
┌─────────────────────────────────────────────────────────────┐
│ Catalyst Advanced I/O function                               │
│                                                              │
│  webhook route          verify HMAC → normalize → claim id   │
│      │                  → 200 to Meta  (fast, always)        │
│      ▼                                                       │
│  Catalyst Job Scheduling (webhook job, 2 retries)            │
│      │  POST /whatsapp/process   (x-wa-internal-key)         │
│      ▼                                                       │
│  lib/wa/inbound   officer lookup · rate limit · read receipt │
│      │            turn lock · media · voice → text · location │
│      ▼                                                       │
│  lib/wa/agent     ordered dispatch, then the model loop       │
│      │            1 lang · 2 undo · 3 frame · 4 safety        │
│      │            5 injection · 6 write gate · 7 agent        │
│      │                                                       │
│      │  GLM-4.7-Flash loop over lib/wa/tools                  │
│      │              ├─ query_db        → ZCQL (guarded)      │
│      │              ├─ person_history  → antecedents         │
│      │              ├─ case_dossier    → lib/investigator    │
│      │              ├─ identify_photo  → Zia compareFace     │
│      │              ├─ enroll_photo    → Stratus + gallery   │
│      │              ├─ read_document   → Zia OCR             │
│      │              ├─ area_alerts     → lib/backtest        │
│      │              ├─ ask_choice / ask_detail → open frame   │
│      │              └─ set_alerts / whoami                   │
│      ▼                                                       │
│  grounding check → WhatsApp markup → chunked → sent → logged  │
└─────────────────────────────────────────────────────────────┘

lib/wa modules
  copy.js      en + kn message pack, the only officer-facing strings
  lang.js      per-turn language: script · lexicon · morphology · prior
  frames.js    open-frame machine (TTL, retries, cancel, verdicts)
  waGuard.js   injection screen · epistemic write gate · ZCQL sanitization
  client.js    Meta transport; sends return a result union, never throw
  officers.js  roster · pending state · undo ledger · claims · turn lock
  tools.js     the action space: role-gated, audited, grounding capture
  agent.js     ordered dispatch + the reasoning loop
  inbound.js   webhook normalization, processing, outbound delivery
  photo.js     Zia face analytics, 1:1 comparison sweep, OCR, gallery
  alerts.js    proactive early-warning push (cron)

Catalyst Cron ──► POST /whatsapp/alerts/dispatch ──► lib/wa/alerts
```

### The one hard constraint

Meta redelivers any webhook it does not see acknowledged within seconds. Our agent
takes 10–20 seconds — an LLM loop, several ZCQL round-trips, and up to a dozen Zia
comparisons for a photo. Replying to Meta only after the work finished would
guarantee duplicate deliveries and duplicate answers.

The webhook therefore does only the cheap part inline (authenticate, normalize,
claim the message id) and hands the turn to a **Catalyst Job Scheduling webhook
job**, which gives a fast `200`, durable retries, and failure isolation. If no job
pool is configured, it processes inline instead — correct, just slower and without
retries, which is what local development wants.

Duplicate suppression is independent of that: every inbound `wamid` is claimed
once, in Catalyst Cache with the `WaMessages` ledger as the durable fallback.

## Photo identification — and its honest limits

This is the capability that makes the channel worth having, and the one that needs
the most care.

**How it works.** `zia.analyseFace()` first: no face means the image is a document,
so it goes down the OCR path. One face means identification. Face Analytics also
returns estimated gender and age, and those narrow the shortlist before any
comparison runs.

**Why the shortlist matters.** Catalyst Zia offers *facial comparison*, which is
strictly 1:1 — `compareFace(a, b) → {confidence, matched}`. There is no 1:N search
and no embedding index, so identification means N comparisons against N stored
photos. Filtering on gender and an age window before comparing, capping candidates
at `WA_FACE_CANDIDATES` (12), and running them at `WA_FACE_CONCURRENCY` (3) is the
difference between a four-second answer and a four-minute one.

**Three limits we state rather than paper over:**

1. **The crime database contains no photographs.** The gallery holds only what
   officers enrol in the field. A fresh deployment matches nothing, and the bot
   says exactly that instead of implying a search happened.
2. **A comparison is a lead, never an identification.** Zia flips `matched` to true
   at a confidence of 0.50, which is nowhere near enough to put a name to a person
   in a policing context. Results below 0.70 are discarded, 0.70–0.85 is reported
   as *possible*, above 0.85 as *strong*, and every reply says a human must verify
   against a document or record. The system prompt forbids suggesting any action
   against a person on the strength of a comparison.
3. **A group photo is refused.** Comparing a multi-face image silently picks
   whichever face dominates the frame, which is precisely how a misidentification
   happens. The officer is asked for a single-subject photo.

## Alerts

A Catalyst cron calls `/whatsapp/alerts/dispatch`, which reads the forecast, works out
who is subscribed to which district, and pushes.

**Free-form only — templates are off, and the refusal is structural.** A business-initiated
message reaches an officer only while their 24-hour service window is open. Outside it Meta
permits only an approved template, which is billable, so this deployment does not send one:
the alert is **deferred**, not downgraded and not dropped. `client.js sendTemplate()` refuses
outright unless `WA_ALLOW_TEMPLATES=true`, and the refusal lives at the transport every
template send must pass through rather than at the single call site that exists today — a
policy enforced only where it is currently needed is a policy the next feature silently breaks.
Turning it back on later is one variable; the template path itself is unchanged and still works.

**A deferred alert is not a lost one.** When the window is shut, nothing is written to the
ledger, which is the whole point: the dedupe key stays unclaimed so a later cycle still
delivers it. Recording a "blocked" row there would silently retire a genuine warning. The
window check also runs before the advisory, so a deferred alert costs no model call.

**The officer is the trigger, not just the clock.** A cron can only reach whoever happens to
have an open window when it fires, and with a daily run that can mean holding a warning until
tomorrow morning. But an officer who has just messaged us has, by definition, an open window —
so `flushAlertsFor()` runs at the end of every turn and hands over whatever they are still
owed. It is deliberately last, after the reply has been sent and the message completed: it must
never delay an answer, and a failure there must not fail the turn. Dedupe is shared with the
cron, so nothing arrives twice, and the turn result reports `alertsFlushed`.

**It reads the batch-scored snapshot, not a live recompute.** `backtest.earlyWarningPreferSnapshot`
exists for two reasons. Assembling a national panel inside the dispatch exceeds ZCQL's
processing ceiling past a million rows in `Cases`, so the original direct call to
`computeEarlyWarning` failed every cycle with an opaque 400. And even where it
succeeds, an officer's push has to say the same thing the dashboard says — both
reading one snapshot is the only way to guarantee that, since two independent
computations diverge the moment either side is retrained. It falls through to live
computation when no snapshot exists, so a fresh environment still works.

- **Officers are opted out by default.** An alert goes only to someone with a
  district on their roster row or a subscription they set over WhatsApp. Blanket
  notification is how a warning system becomes noise that gets muted.
- **One message per officer, per district, per horizon, per severity**, keyed and
  checked against the `WaMessages` ledger before sending. A cron that re-sends a
  3am alert because the previous run half-failed destroys the channel faster than a
  missed alert does. Max 3 pushes per officer per cycle, `WA_ALERT_MAX_SENDS` overall.
- **Inside Meta's 24-hour service window** (the officer messaged us today) the push
  is free-form and detailed. **Outside it** the alert is deferred and reported as
  `deferredWindowClosed`, and delivered by a later cycle or by the officer's next
  message. `/whatsapp/health` reports `templatesEnabled: false`.
- The AI advisory line is generated **once per district** and reused for every
  officer watching it, rather than once per recipient.

### The alert template — approved, and deliberately unused

Kept for later. `WA_ALLOW_TEMPLATES` is `false`, so nothing can send it today; leaving it
approved simply means the wait for Meta's review is already paid for when templates are
switched on. Note the code reads `WA_ALERT_TEMPLATE` for the name, which is currently unset —
set both to enable it.

Created as `ksp_early_warning_v2`, category **Utility**, four body parameters:

```
KSP Early Warning                       [static header]

District: {{1}}
Severity: {{2}}
Forecast period: {{3}}

{{4}}

Decision support for deployment planning only. Not grounds for action against any
individual. Reply to this message for detail.

Karnataka State Police - Crime Intelligence   [footer]
```

Two things about that shape are forced rather than chosen. **Every placeholder lives in
the BODY** because `client.js sendTemplate()` emits a single `body` component and nothing
else; a header placeholder would pass review and then fail with a parameter-count
mismatch the first time a real alert fired outside the 24-hour window. And the name ends
in `_v2` because deleting a template locks that name and language for a while — `POST`
returns `Message template language is being deleted`, and re-issuing the `DELETE` restarts
the clock, so a delete-then-recreate loop never converges. Meta's own advice is to pick a
new name, which is cheaper than waiting.

## Security model

| Concern | How it is handled |
|---|---|
| Webhook authenticity | `X-Hub-Signature-256` HMAC over the **raw** body, timing-safe compare, fails closed with no app secret. `express.json`'s `verify` hook keeps the raw bytes because re-serializing breaks the digest |
| Who is allowed | Strict allow-list: the number must be an active `Officers` row. Unknown numbers get one information-free notice per hour and no data |
| Privilege | The role comes from the roster row, never from the message. A claim in a message to be someone else is ignored by construction |
| Role scope | Tool authorization is enforced in `dispatch()`, not in the prompt. Mirrors the web API: risk scores and associate networks are analyst-and-above; biometric and write actions exclude the read-only policymaker role |
| Internal endpoints | `/whatsapp/process` and `/whatsapp/alerts/dispatch` require `x-wa-internal-key` and fail closed if it is unset. Both key guards use a constant-time compare, matching the webhook's HMAC check — a `!==` on a secret returns on the first differing byte |
| Query safety | Model-generated ZCQL goes through the same `isSafeSelect` gate as the web chat: SELECT-only, no semicolons, enforced LIMIT |
| Writes | The channel can add a gallery photo and change the officer's own alert settings. Nothing else. Case records are unreachable |
| Prompt injection | Screened deterministically in `waGuard.screenInjection()` before the model sees the turn, on message text, captions **and OCR output** — anyone can print "ignore your instructions" on a sheet and hold it to a police camera. Not blocked: the finding is attached to the turn as an explicit warning and logged, and the legitimate part of the request is still answered |
| Self-selected role | `WA_SELF_ROLE` is off unless explicitly `true`. It relaxes the channel's central trust boundary — role from the roster, never from a message — so it is a deliberate demo affordance mirroring the web app's own role selector, never a default. Every change is audited against the officer's identity |
| A question mistaken for a command | An alert subscription may only change when the officer's own words mention alerts, in any of the three languages. Asked what the risk was in Ballari next month, the model called `set_alerts` twice and resubscribed the officer before answering — the write gate cannot catch that, because the phrasing is a plain question and questions are permitted there by design. So the check is about topic rather than mood, and reads the officer's words rather than the model's reading of them |
| Unintended writes | `waGuard.epistemicWriteGate()` is clause-level. A negated ("don't save this") or hypothetical ("what if I save this") phrasing cannot mint a write, whatever the model decided. Polite and interrogative framings are treated as requests, because a silently-skipped enrolment is its own failure |
| Hallucinated identifiers | `tools.verifyGrounding()` runs after the model and before delivery. A reply citing identifiers that no tool returned and the officer never supplied is replaced. Comparison is canonical (`4021/2026` = `4021 / 2026` = `4021-2026`), never substring — a substring rule let a fabricated `AB1299/2026` pass because some real record contained `AB12` |
| A model that ignores a refusal | The second denial in one turn ends it with deterministic copy. Asking the model to stop and explain would rely on the same compliance that just failed twice, and the tools' refusal text is addressed to the model, not to an officer |
| Silent consent changes | `upsertOfficer` patches only the fields an admin supplied. Spreading a fully-defaulted row into the update reset the officer's alert subscription — their own consent decision — whenever anyone corrected a rank |
| Request body size | Capped at 1 MiB **before** the HMAC is computed, so an unauthenticated caller cannot make us hash their payload |
| Media provenance | Hop two carries our bearer token, so the download URL must be https on a Meta CDN host, and the size is checked three ways: Meta's declared `file_size`, the CDN `Content-Length`, and the bytes received. The allowlist has to include `fbsbx.com` — that is where Cloud API actually serves media from, and an allowlist built from the obvious names (fbcdn, facebook.com) rejects every real photo while looking correct |
| Retry after a failure | A retry is offered only when the failure happened **before** the agent ran. After that the turn may already have enrolled a photo, and re-running it would enrol twice. A silent duplicate write is worse than a turn the officer can see failed |
| A retry we did not ask for | The above governs only the status code we return, and Catalyst decides a webhook job failed from the HTTP response *it* sees — so a turn slower than its timeout is re-dispatched regardless. `claimMessage` could not catch it because the job calls `/whatsapp/process` directly, bypassing the webhook where the claim is made. `processEvent` now refuses any message already marked complete. Until it did, one officer's question was answered twice, 60 seconds apart |
| A gap in the data | A query filtered outside `DATA_WINDOW` comes back with a note saying the result describes missing data, not missing cases (`lib/wa/window.js`). The system prompt alone did not hold: the model reports the coverage correctly when asked and still answered "no cases in Hoshiarpur this year (2026)". In a policing tool that is the most damaging wrong answer available, so the correction sits in the observation rather than in an instruction the model has to recall |
| Lost conversational state | One turn per officer at a time (`acquireTurnLock`, 90-second ceiling, fails open). Without it, two messages seconds apart both read the pending blob and the second write erases the first |
| Abuse / cost | Per-number hourly cap in Catalyst Cache, capped agent steps, capped face comparisons, capped media size (8 MB) |
| Audit | Every inbound message, reply, alert, biometric use and write lands in `WaMessages` against the officer's identity |
| Self-harm / harm enablement | The same deterministic `lib/guard.js` pre-check as the web channel, ahead of the model |
| Secrets | Server-side only. The officer's handset never sees a key, and `/whatsapp/health` reports which pieces are configured, never their values |

## Provisioning

### Already done in this environment

| Resource | State |
|---|---|
| `Officers`, `WaMessages`, `PersonPhotos` | created, `Pending` is Text (max) |
| Stratus bucket `ksp-field-photos` | permission **authenticated**, data encryption **on**, PII/ePHI **on**, versioning off |
| Job pool `kspwaturns` | type Webhook, max concurrent 5 — `WA_JOBPOOL` set, turns verified queueing |
| Cron `ksp_wa_early_warning` | daily 06:30 IST → `POST /whatsapp/alerts/dispatch` with `x-wa-internal-key` |
| `WA_VERIFY_TOKEN`, `WA_INTERNAL_KEY` | generated into the gitignored function config |
| Meta credentials | real: app `2592724907814162`, sender `+91 94002 45958` (phone id `1079257601947704`, APPROVED, GREEN), never-expiring SYSTEM_USER token, real `WA_APP_SECRET` |
| Sending | **verified live** — a signed inbound turn, a Kannada turn and two early-warning alerts delivered to a real handset; a second dispatch suppressed both as duplicates |
| `DATA_WINDOW` | `2023-07..2025-06`, the period the case records actually cover |
| Catalyst SDK | **3.4.0** — required; see below |
| WABA | `2306127019919794` — learned from `entry[0].id`, see below |
| Webhook | all three levels point at KSP: app, **phone-number override**, and WABA `subscribed_apps` |
| Alert template | `ksp_early_warning_v2` (UTILITY, four body parameters) — **approved but disabled**, `WA_ALLOW_TEMPLATES=false` |
| Alert delivery | free-form only, inside the 24-hour window; otherwise deferred and flushed on the officer's next message |
| Languages | English, Kannada, **Hindi** — `WA_SELF_ROLE=true`, so `reset` also lets the officer pick their access context |

**The number is exclusive to KSP now.** It had been wired into three projects at once — SellThat,
Tia and Versifine — and a WhatsApp number delivers to exactly one webhook, so whichever project
last claimed a callback silently owned inbound for all of them. The other three are dismantled
(containers stopped and pinned, credentials removed, webhook routes retired to `410`), with
backups and a revert path in `DEVELOPMENT.md` §12.

**Webhooks have three levels and the most specific wins.** Repointing the app-level callback
returned `success: true` and changed nothing, because a phone-number-level override still pointed
elsewhere. It is invisible unless you ask for `webhook_configuration` on the phone number. Set
that one; the app-level alone is not enough.

**Delivery receipts now reach us, and that closed a real blind spot.** Before the takeover, a
business-initiated message outside the 24-hour window was accepted with a message id and then
dropped, and the `failed` status went to another project's webhook — so the ledger recorded `sent`
while the handset showed nothing. Both are now visible in `WaMessages`.

**The WABA id cannot be fetched with a system-user token** — `me/businesses` is empty and every
WABA edge and phone→WABA expansion is rejected. It arrives as `entry[0].id` on any callback, so
`lib/wa/inbound.js` captures it there and `/whatsapp/health` reports it; `WA_WABA_ID` takes
precedence once known so a cold start needs no callback. Without it, templates cannot be created
at all, because template management is WABA-scoped and does not accept a phone number id.

Each console resource has an idempotent step in `tools/steps/`: `create-bucket.js`,
`create-jobpool.js`, `create-cron.js`. Rerunning one reports what it found rather
than duplicating it.

**The SDK version is load-bearing.** `app.stratus()` and `app.jobScheduling()` exist
only in `zcatalyst-sdk-node` 3.x. On 2.x — which `^2.1.1` resolved to — photo
enrolment throws on the first real photo, and the async webhook path can never
succeed: it falls back inline forever, silently, because losing the queue must not
lose an officer's message. Do not relax that dependency range.

A second trap in the same path: Catalyst caps `job_name` at 20 characters and rejects
the whole submission when it is longer, so a name built from a wamid was too long and
every turn fell back inline. Both failures were reported healthy by a config-reading
health check, which is why `/whatsapp/health` now probes the SDK namespaces and
resolves the job pool for real, and why the webhook replies with event counts
(`received`, `queued`, `duplicates`, `inline`, `enqueueError`) — never message
content, on an endpoint no unauthenticated caller can reach.

### What only you can do

**1 · Meta (developers.facebook.com + Business Manager)**
- A Meta app with **WhatsApp** added, attached to a WhatsApp Business Account.
- A **business phone number** → note its **Phone Number ID** → `WA_PHONE_NUMBER_ID`.
- A **System User** with a **permanent access token** (`whatsapp_business_messaging`,
  `whatsapp_business_management`) → `WA_ACCESS_TOKEN`. The 24-hour test token will
  strand the bot tomorrow.
- App secret → `WA_APP_SECRET`.
- Invent a random string for `WA_VERIFY_TOKEN`.
- Webhook: callback URL `https://ksp.cyberkunju.com/server/api/whatsapp/webhook`,
  verify token as above, then **subscribe to the `messages` field**. Nothing arrives
  without that subscription.
- Create the alert template above and wait for approval.

**2 · Catalyst console** — done, except: confirm Zia **Face Analytics** and **Identity
Scanner** are enabled on the account. Facial comparison is IN-DC only, which this
project is. Recreating the rest in a new environment is three step invocations, and
the console traps they encode are worth knowing before doing it by hand: a cron name
must use underscores and reject hyphens, a job pool name must use neither, and the job
pool dialog sends **no request at all** when the name is wrong, so it looks like a dead
button rather than a validation failure.

**3 · Function config** — put `WA_PHONE_NUMBER_ID` and `WA_ACCESS_TOKEN` (and the real
`WA_APP_SECRET`) into `catalyst-config.json`, then `catalyst deploy --only functions`.
Everything else in the `WA_*` block is already set.

**4 · Register officers**

```bash
curl -X POST https://ksp.cyberkunju.com/server/api/admin/officers \
  -H "x-admin-key: $ADMIN_KEY" -H 'Content-Type: application/json' \
  -d '[{"phone":"+919845012345","name":"Suresh Rao","rank":"PSI","role":"investigator",
        "district":"Mysuru","state":"Karnataka","station":"Devaraja",
        "language":"en","alertSeverity":"critical"}]'
```

Revoking access day-to-day is the same endpoint with `{"active": false}`: the roster
lookup refuses an inactive row, and the row stays as the record that this number once
held access. `DELETE /admin/officers` removes the row outright, for the different case
of a number that should never have been registered — a typo, or a test registration —
where an inactive row would leave a live police roster permanently listing a number
nobody owns. The `WaMessages` ledger is kept unless `purgeLedger: true` is passed,
because it is the audit trail for data that number was shown; the purge runs whether or
not a roster row existed, since the number most needing its ledger cleared is one that
was never an officer.

**5 · Verify**

```bash
# Health is admin-guarded and reports capability, not configuration: it probes the SDK
# namespaces and resolves the job pool, so it cannot claim a queue that cannot run.
curl -s https://ksp.cyberkunju.com/server/api/whatsapp/health \
     -H "x-admin-key: $ADMIN_KEY"        # all flags true, jobPool "resolved"
curl -s -X POST "https://ksp.cyberkunju.com/server/api/whatsapp/alerts/dispatch?dryRun=true" \
     -H "x-wa-internal-key: $WA_INTERNAL_KEY"                          # who would be pushed
cd functions/api && npm test                                           # lint + unit tests + turn smoke
```

`npm test` runs three things: the copy lint, the unit tests, and
`scripts/smoke-turn.mjs`, which traces a complete turn with the model and the Data
Store stubbed. The unit tests prove the pieces; the smoke run proves the wiring —
ordered dispatch, the tool loop, the frame lifecycle, the write gate, grounding and
the deterministic commands actually composing into a turn. It needs no network and
touches no Catalyst resource.

Then message the business number from a registered handset.

## Known limits

| Limit | Detail |
|---|---|
| No vehicle, phone or IMEI data | The crime schema has no such columns, so a registration-number lookup can only text-search `BriefFacts` and will usually find nothing. OCR extracts plates correctly; there is nothing to match them against until the generator emits a `VehicleNo` field |
| Empty gallery on day one | Facial comparison is only as useful as what officers enrol |
| Nearest-district location | Centroid distance, not point-in-polygon, so near a boundary it can name the neighbour. Presented as "nearest district" |
| Rate limit and turn lock are approximate | Both live in Catalyst Cache, whose minimum TTL is one hour and whose get-then-put is not atomic. A simultaneous burst can slip a message or two past the hourly cap, and the lock fails open under contention. Both are the right trade — dropping an officer's message is worse than a rare interleave — but neither is a hard guarantee. Move the counter into a Data Store row if precise limiting ever matters |
| No burst aggregation | A photo and a follow-up caption sent as two messages are two turns. Handled instead by `ask_detail`, which parks the photo in Stratus and resolves it against the officer's next reply — so the outcome is right, but it costs an extra exchange |
| Voice replies are a convenience | Text is sent first and stays authoritative (an FIR number has to be readable). Synthesis is skipped for replies over 600 characters and on any TTS failure, silently, because the text has already landed |
| Voice notes are opus/ogg | Sarvam handles them in practice; a transcription failure degrades to a clear "please type it" rather than silence |
| Rate limit is a coarse window | Catalyst Cache's minimum TTL is one hour and get-then-put is not atomic, so a simultaneous burst can slip a couple over the cap |
| Text replies only | No voice reply back yet; it needs the Meta media-upload path |
| Officer roster is API-managed | No web UI for it in the dashboard yet |
