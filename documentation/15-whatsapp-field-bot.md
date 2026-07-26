# 15 · WhatsApp Field-Officer Channel

The dashboard is for a desk. This is the same intelligence platform reached from a
phone an officer already carries, over an app they already trust, while they are
standing in front of the person or the document they are asking about.

Code: `functions/api/lib/wa/` · routes in `functions/api/index.js` · tables 11–13 in
`datastore/SCHEMA.md` · tests in `functions/api/test/wa.test.js`.

---

## What an officer can do

Everything is expressed in natural language, English or Kannada, typed or spoken.
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
| *(nothing — a critical district is flagged)* | proactive push arrives with a one-line AI advisory |

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

### Bilingual by construction

Every officer-facing string lives in `lib/wa/copy.js` in English and Kannada,
police vocabulary (FIR, CrimeNo, district) deliberately left in English inside the
Kannada copy because that is how Karnataka officers write it. `scripts/lint-wa-copy.mjs`
fails the build if any module passes a literal string to a send, and a test asserts
the two packs have identical keys — a missing Kannada key is exactly how a
bilingual bot ends up answering in English.

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

A Catalyst cron calls `/whatsapp/alerts/dispatch`, which reads the live forecast
from `lib/backtest`, works out who is subscribed to which district, and pushes.

- **Officers are opted out by default.** An alert goes only to someone with a
  district on their roster row or a subscription they set over WhatsApp. Blanket
  notification is how a warning system becomes noise that gets muted.
- **One message per officer, per district, per horizon, per severity**, keyed and
  checked against the `WaMessages` ledger before sending. A cron that re-sends a
  3am alert because the previous run half-failed destroys the channel faster than a
  missed alert does. Max 3 pushes per officer per cycle, `WA_ALERT_MAX_SENDS` overall.
- **Inside Meta's 24-hour service window** (the officer messaged us today) the push
  is free-form and detailed. **Outside it**, Meta permits only an approved
  template, so the template path is used — and if no template is configured, the
  alert is skipped and reported, not silently dropped.
- The AI advisory line is generated **once per district** and reused for every
  officer watching it, rather than once per recipient.

### The alert template

Create this in Meta Business Manager → WhatsApp Manager → Templates, category
**Utility**, name matching `WA_ALERT_TEMPLATE`, with four body parameters:

```
KSP Early Warning — {{1}}

Severity: {{2}}   Forecast period: {{3}}
{{4}}

Decision support for deployment planning only. Not grounds for action against any
individual. Reply to this message for detail.
```

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
| Unintended writes | `waGuard.epistemicWriteGate()` is clause-level. A negated ("don't save this") or hypothetical ("what if I save this") phrasing cannot mint a write, whatever the model decided. Polite and interrogative framings are treated as requests, because a silently-skipped enrolment is its own failure |
| Hallucinated identifiers | `tools.verifyGrounding()` runs after the model and before delivery. A reply citing identifiers that no tool returned and the officer never supplied is replaced. Comparison is canonical (`4021/2026` = `4021 / 2026` = `4021-2026`), never substring — a substring rule let a fabricated `AB1299/2026` pass because some real record contained `AB12` |
| A model that ignores a refusal | The second denial in one turn ends it with deterministic copy. Asking the model to stop and explain would rely on the same compliance that just failed twice, and the tools' refusal text is addressed to the model, not to an officer |
| Silent consent changes | `upsertOfficer` patches only the fields an admin supplied. Spreading a fully-defaulted row into the update reset the officer's alert subscription — their own consent decision — whenever anyone corrected a rank |
| Request body size | Capped at 1 MiB **before** the HMAC is computed, so an unauthenticated caller cannot make us hash their payload |
| Media provenance | Hop two carries our bearer token, so the download URL must be https on a Meta CDN host, and the size is checked three ways: Meta's declared `file_size`, the CDN `Content-Length`, and the bytes received. The allowlist has to include `fbsbx.com` — that is where Cloud API actually serves media from, and an allowlist built from the obvious names (fbcdn, facebook.com) rejects every real photo while looking correct |
| Retry after a failure | A retry is offered only when the failure happened **before** the agent ran. After that the turn may already have enrolled a photo, and re-running it would enrol twice. A silent duplicate write is worse than a turn the officer can see failed |
| Lost conversational state | One turn per officer at a time (`acquireTurnLock`, 90-second ceiling, fails open). Without it, two messages seconds apart both read the pending blob and the second write erases the first |
| Abuse / cost | Per-number hourly cap in Catalyst Cache, capped agent steps, capped face comparisons, capped media size (8 MB) |
| Audit | Every inbound message, reply, alert, biometric use and write lands in `WaMessages` against the officer's identity |
| Self-harm / harm enablement | The same deterministic `lib/guard.js` pre-check as the web channel, ahead of the model |
| Secrets | Server-side only. The officer's handset never sees a key, and `/whatsapp/health` reports which pieces are configured, never their values |

## Provisioning — what only you can do

Code is complete; these are account-level steps.

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

**2 · Catalyst console**
- Data Store: create `Officers`, `WaMessages`, `PersonPhotos` (`datastore/SCHEMA.md`).
  `Officers.Pending` must be **Text (max)** — it holds the JSON conversational state.
- Stratus: create the bucket `ksp-field-photos`.
- Job Scheduling: create a **Webhook** job pool → `WA_JOBPOOL`.
- Cron: recurring (daily is sensible), target **Webhook**,
  `POST https://ksp.cyberkunju.com/server/api/whatsapp/alerts/dispatch`,
  header `x-wa-internal-key: <WA_INTERNAL_KEY>`.
- Zia: confirm Face Analytics and Identity Scanner are enabled. Facial comparison
  in the console is IN-DC only, which this project is.

**3 · Function config** — add the `WA_*` block from
`functions/api/catalyst-config.example.json` to `catalyst-config.json`, then
`catalyst deploy --only functions`.

**4 · Register officers**

```bash
curl -X POST https://ksp.cyberkunju.com/server/api/admin/officers \
  -H "x-admin-key: $ADMIN_KEY" -H 'Content-Type: application/json' \
  -d '[{"phone":"+919845012345","name":"Suresh Rao","rank":"PSI","role":"investigator",
        "district":"Mysuru","state":"Karnataka","station":"Devaraja",
        "language":"en","alertSeverity":"critical"}]'
```

**5 · Verify**

```bash
# Health is admin-guarded: row counts and "which pieces are configured" are
# operational intelligence about a police system.
curl -s https://ksp.cyberkunju.com/server/api/whatsapp/health \
     -H "x-admin-key: $ADMIN_KEY"                                      # all flags true
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
