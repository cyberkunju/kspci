'use strict';

/**
 * Open frames — "the bot just asked a question and the next message is the
 * answer to THAT question".
 *
 * The bug this prevents is specific and it is the one every WhatsApp assistant
 * ships with. The bot asks "which Suresh Kumar — 1, 2 or 3?". The officer sends
 * "2". Without a frame, "2" re-enters general dispatch as a fresh utterance, the
 * model has no idea what 2 means, and the officer gets a non-answer to a question
 * the bot itself asked. So a frame is resolved BEFORE any other routing.
 *
 * Deliberately NOT a resolver registry. The reference implementation this is
 * modelled on registers one resolver per frame kind, which is right when each
 * kind produces different copy. Here every frame does the same thing: turn a
 * short answer into a fully-specified utterance and hand that back to the agent.
 * One generic resolver plus data-only frames is the same behaviour with no
 * registry to keep in sync and no kind that can silently lack a handler.
 *
 * Frame shape (JSON-serializable, persisted on the officer row):
 *   { v, kind, prompt, options:[{id,label,resolve}], context, ts, ttlMs, retries }
 *
 * `options[].resolve` is the utterance the agent receives when that option is
 * picked. `context.resolveTemplate` does the same job for free-form frames, with
 * `{answer}` substituted. Both are plain strings so a frame survives being
 * written to a Data Store column and read back on another invocation.
 */

const FRAME_VERSION = 1;

/** Long enough for an officer to look up from a traffic stop, short enough not to lurk. */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

/** After this many consecutive unresolvable answers the frame lets go, so nobody is trapped. */
const MAX_RETRIES = 3;

/**
 * Universal escape hatches. Checked before the resolver so an officer can always
 * get out of a question, in either language. Single tokens only — a longer
 * message is an answer attempt and goes through the resolver.
 */
const CANCEL_TOKENS = new Set([
  'cancel', 'stop', 'skip', 'nevermind', 'never mind', 'forget it', 'forget that',
  'exit', 'quit', 'leave it', 'drop it', 'no',
  // Kannada, script and romanized
  'ಬೇಡ', 'ಬಿಡು', 'ಬಿಡಿ', 'ಸಾಕು', 'ನಿಲ್ಲಿಸು', 'ಬೇಡಾ',
  'beda', 'bedi', 'bidu', 'bidi', 'saaku', 'saku', 'illa', 'bekilla'
]);

/**
 * Signals that the officer has moved on to something else entirely rather than
 * answering. Any of these releases the frame and lets the message be handled as
 * a fresh request — a frame must never swallow real work.
 */
const NEW_INTENT = /\b(fir|crimeno|ocr|status|history|alert|alerts|photo|identify|enrol|enroll|help)\b|\d{1,5}\s*\/\s*(?:19|20)\d{2}|[\u0C80-\u0CFF]{6,}/i;

/** Ordinal words → zero-based option position, in both languages. */
const ORDINALS = new Map([
  ['first', 0], ['second', 1], ['third', 2], ['fourth', 3], ['fifth', 4],
  ['1st', 0], ['2nd', 1], ['3rd', 2],
  ['ಮೊದಲ', 0], ['ಮೊದಲನೇ', 0], ['ಎರಡನೇ', 1], ['ಮೂರನೇ', 2], ['ನಾಲ್ಕನೇ', 3]
]);

const now = () => Date.now();

/* ------------------------------ read / write ------------------------------ */

/** The active frame, honouring TTL and schema version. Pure. */
function getFrame(pending) {
  const raw = pending && pending.openFrame;
  if (!raw || raw.v !== FRAME_VERSION || typeof raw.kind !== 'string' || typeof raw.ts !== 'number') return null;
  if (now() - raw.ts > (raw.ttlMs || DEFAULT_TTL_MS)) return null;
  return raw;
}

const hasFrame = (pending) => getFrame(pending) != null;

/**
 * Stash a frame. Returns the mutated pending blob so the caller can persist it
 * in the same write it already makes at the end of a turn.
 */
function openFrame(pending, { kind, prompt, options, context, ttlMs }) {
  const p = pending && typeof pending === 'object' ? pending : {};
  p.openFrame = {
    v: FRAME_VERSION,
    kind: String(kind),
    prompt: String(prompt || '').slice(0, 1200),
    ...(Array.isArray(options) && options.length
      ? {
        options: options.slice(0, 9).map((o, i) => ({
          id: String(o.id != null ? o.id : i + 1).slice(0, 80),
          label: String(o.label || '').slice(0, 120),
          resolve: String(o.resolve || o.label || '').slice(0, 400)
        }))
      }
      : {}),
    context: context && typeof context === 'object' ? context : {},
    ts: now(),
    ...(ttlMs ? { ttlMs: Number(ttlMs) } : {}),
    retries: 0
  };
  return p;
}

function clearFrame(pending) {
  if (pending && pending.openFrame) delete pending.openFrame;
  return pending;
}

/**
 * Strip surrounding punctuation for cancel matching.
 *
 * `\p{M}` is in the keep set for a reason: Kannada vowel signs and the virama are
 * combining marks, and several cancel words end in one. Without it "ನಿಲ್ಲಿಸು"
 * loses its final ು, stops matching, and a Kannada-speaking officer cannot escape
 * a question — a failure that never shows up in English testing.
 */
function normalizeToken(body) {
  return String(body || '').toLowerCase().trim()
    .replace(/^[^\p{L}\p{M}\p{N}]+|[^\p{L}\p{M}\p{N}]+$/gu, '');
}

/**
 * Read a numbered pick out of a reply. Accepts "2", "2.", "option 2", "second",
 * and the bare label. Rejects anything that merely contains a digit — "FIR
 * 2/2026" is a new request, not a pick of option 2.
 */
function matchOption(body, options) {
  const raw = String(body || '').trim();
  const token = normalizeToken(raw);

  const bare = raw.match(/^(?:option\s*|no\.?\s*|#)?(\d{1,2})[.)\s]*$/i);
  if (bare) {
    const n = Number(bare[1]);
    if (n >= 1 && n <= options.length) return options[n - 1];
    return null;
  }

  // Explicit word → position. An index-arithmetic version of this was correct but
  // silently wrong the moment a word was added to the list.
  const ord = ORDINALS.get(token);
  if (ord !== undefined && ord < options.length) return options[ord];

  const exact = options.find((o) => normalizeToken(o.label) === token);
  if (exact) return exact;

  // A reply that fully contains one label and no other is an unambiguous pick.
  const contained = options.filter((o) => o.label && token.includes(normalizeToken(o.label)));
  if (contained.length === 1) return contained[0];

  return null;
}

/* ------------------------------ resolution ------------------------------ */

/**
 * Try to resolve the active frame against this message.
 *
 * Returns null when there is no frame or the message is unrelated — in both
 * cases the caller continues normal dispatch with the body intact. Otherwise one
 * of:
 *   { verdict:'cancelled', reply }            frame dropped at the officer's request
 *   { verdict:'resolved', text, context }     hand `text` to the agent instead of the raw body
 *   { verdict:'retry', reply }                frame stays open, re-prompt sent
 *   { verdict:'exhausted', reply }            frame dropped after MAX_RETRIES
 *
 * `pending` is mutated in place; the caller persists it once per turn.
 */
function resolveFrame({ pending, body, messages }) {
  const frame = getFrame(pending);
  if (!frame) {
    // An expired or stale-version frame must not linger on the row.
    if (pending && pending.openFrame) clearFrame(pending);
    return null;
  }

  const token = normalizeToken(body);
  if (token && CANCEL_TOKENS.has(token)) {
    clearFrame(pending);
    return { verdict: 'cancelled', kind: frame.kind, reply: messages.frameCancelled };
  }

  const options = Array.isArray(frame.options) ? frame.options : null;

  if (options && options.length) {
    const picked = matchOption(body, options);
    if (picked) {
      clearFrame(pending);
      return { verdict: 'resolved', kind: frame.kind, text: picked.resolve, option: picked, context: frame.context };
    }
    // Not a pick. Either the officer moved on, or they answered unusably.
    if (NEW_INTENT.test(String(body || '')) || proseLength(body) > 6) {
      clearFrame(pending);
      return null;
    }
    return bumpOrExhaust(pending, frame, messages, messages.frameUnknownPick(options));
  }

  // Free-form frame: any substantive reply is the answer.
  const answer = String(body || '').trim();
  if (answer.length >= 2) {
    clearFrame(pending);
    const template = String((frame.context && frame.context.resolveTemplate) || '{answer}');
    return {
      verdict: 'resolved',
      kind: frame.kind,
      text: template.replace('{answer}', answer).slice(0, 1200),
      context: frame.context
    };
  }
  return bumpOrExhaust(pending, frame, messages, frame.prompt);
}

function proseLength(body) {
  return String(body || '').trim().split(/\s+/).filter(Boolean).length;
}

function bumpOrExhaust(pending, frame, messages, reprompt) {
  const retries = (Number(frame.retries) || 0) + 1;
  if (retries >= MAX_RETRIES) {
    clearFrame(pending);
    return { verdict: 'exhausted', kind: frame.kind, reply: reprompt + messages.frameMaxRetriesSuffix };
  }
  pending.openFrame = { ...frame, retries };
  return { verdict: 'retry', kind: frame.kind, retries, reply: reprompt };
}

/**
 * Render the question an options frame asks. Kept here so the wording and the
 * numbering that `matchOption` parses can never drift apart.
 */
function renderPrompt(frame, messages) {
  const options = Array.isArray(frame.options) ? frame.options : [];
  return options.length ? messages.framePickPrompt(frame.prompt, options) : frame.prompt;
}

module.exports = {
  getFrame, hasFrame, openFrame, clearFrame, resolveFrame, renderPrompt,
  matchOption, normalizeToken,
  FRAME_VERSION, DEFAULT_TTL_MS, MAX_RETRIES, CANCEL_TOKENS
};
