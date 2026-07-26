'use strict';

/**
 * Meta WhatsApp Cloud API — outbound client and inbound webhook authentication.
 *
 * The only module that speaks Meta's HTTP protocol. Everything else in lib/wa
 * deals in normalized shapes, so a Graph version bump is contained here.
 *
 * Two design decisions worth stating, because they shape every caller:
 *
 *  1. SENDS DO NOT THROW. Every send returns a SendResult union. A throwing send
 *     forces each caller to invent its own catch, and the catch that gets written
 *     under pressure is the one that swallows a closed 24-hour window and reports
 *     "sent". A union makes the interesting failures — window closed, credentials
 *     missing, payload rejected — impossible to ignore without saying so. Callers
 *     branch on `ok` and `kind`; nothing needs try/catch.
 *
 *  2. INTERACTIVE PAYLOADS ARE VALIDATED, NOT TRUNCATED. Meta's caps are counted
 *     in code points, not UTF-16 units, so a Kannada title that measures 20 in
 *     `.length` can still be rejected. And silently truncating a button title is
 *     how an officer ends up tapping a button whose label no longer says what it
 *     does. If a payload does not fit, we say so and the caller falls back to
 *     plain numbered text, which always fits.
 *
 * Trust boundary: verifySignature() gates every inbound webhook. Meta signs the
 * RAW body, so index.js captures rawBody in the express.json verify hook —
 * re-serializing the parsed object changes key order and breaks the HMAC.
 */

const crypto = require('crypto');

const GRAPH = 'https://graph.facebook.com';
const version = () => process.env.WA_GRAPH_VERSION || 'v25.0';
const phoneId = () => process.env.WA_PHONE_NUMBER_ID || '';
const token = () => process.env.WA_ACCESS_TOKEN || '';
const timeoutMs = () => Number(process.env.WA_HTTP_TIMEOUT_MS || 20000);

/**
 * Meta's hard text limit is 4096 characters. We chunk below it so a "(1/2)"
 * marker or an undo hint can always be appended without pushing a part over.
 */
const TEXT_LIMIT = 3800;

/**
 * Cap on the unauthenticated request body, enforced before the HMAC is computed.
 * A legitimate Meta webhook is a few kilobytes; anything approaching a megabyte
 * is someone making us hash their payload for them.
 */
const MAX_BODY_BYTES = 1024 * 1024;

/** Meta interactive caps, in code points. */
const CAPS = { buttonTitle: 20, buttonId: 256, header: 60, footer: 60, interactiveBody: 1024, buttons: 3 };

/** Code-point-accurate length. Kannada and emoji both break `.length`. */
const glyphs = (s) => Array.from(String(s == null ? '' : s)).length;

function configured() {
  return Boolean(phoneId() && token());
}

class WaError extends Error {
  constructor(message, { status, code, subcode, detail } = {}) {
    super(message);
    this.name = 'WaError';
    this.status = status;
    this.code = code;
    this.subcode = subcode;
    this.detail = detail;
  }
  /**
   * 131047 / 131026 / 470: the 24-hour customer service window has closed, so a
   * free-form message is refused and the caller must use an approved template.
   */
  get isWindowClosed() {
    return this.code === 131047 || this.code === 131026 || this.code === 470;
  }
  get isRetryable() {
    if (this.status === 429 || this.status >= 500) return true;
    return this.code === 131056 || this.code === 133016;
  }
}

/* ------------------------------ send result ------------------------------ */

const ok = (ids, extra = {}) => ({ ok: true, ids: ids.filter(Boolean), ...extra });
const fail = (kind, message, extra = {}) => ({ ok: false, kind, message: String(message).slice(0, 300), ...extra });

/** Classify a thrown WaError into the union. Never rethrows. */
function classify(e) {
  if (!(e instanceof WaError)) return fail('transport', (e && e.message) || String(e));
  if (e.isWindowClosed) return fail('windowClosed', e.message, { code: e.code });
  if (e.status === 401 || e.status === 403) return fail('auth', e.message, { code: e.code });
  if (e.status === 429) return fail('rateLimited', e.message, { code: e.code });
  if (e.status === 400) return fail('invalidPayload', e.message, { code: e.code });
  if (e.status === 599) return fail('transport', e.message);
  return fail('graph', e.message, { code: e.code, status: e.status });
}

/* ------------------------------ inbound auth ------------------------------ */

/**
 * Verify Meta's X-Hub-Signature-256 against the raw body. Returns false rather
 * than throwing so the route can answer 403 uniformly, and rejects the header on
 * shape before doing any crypto.
 */
function verifySignature(rawBody, headerValue) {
  const secret = process.env.WA_APP_SECRET || '';
  if (!secret) return false;
  if (!Buffer.isBuffer(rawBody) || !rawBody.length) return false;
  if (rawBody.length > MAX_BODY_BYTES) return false;

  const header = String(headerValue || '');
  if (!/^sha256=[a-f0-9]{64}$/.test(header)) return false;

  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Meta's subscription handshake (GET). Returns the challenge to echo, or null. */
function verifyChallenge(query) {
  const expected = process.env.WA_VERIFY_TOKEN || '';
  const mode = query && query['hub.mode'];
  const supplied = query && query['hub.verify_token'];
  const challenge = query && query['hub.challenge'];
  if (!expected || mode !== 'subscribe' || !challenge) return null;
  const a = Buffer.from(String(supplied || ''));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return String(challenge);
}

/* ------------------------------ graph transport ------------------------------ */

async function graph(path, { method = 'POST', body, query, form, attempt = 0 } = {}) {
  if (!configured()) {
    throw new WaError('WA_PHONE_NUMBER_ID / WA_ACCESS_TOKEN are not configured', { status: 401 });
  }
  const qs = query ? '?' + new URLSearchParams(query).toString() : '';
  const url = `${GRAPH}/${version()}/${path}${qs}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs());
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: 'Bearer ' + token(),
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: form || (body ? JSON.stringify(body) : undefined),
      signal: ctrl.signal
    });
  } catch (e) {
    clearTimeout(timer);
    if (attempt < 2) return backoff(attempt, () => graph(path, { method, body, query, form, attempt: attempt + 1 }));
    throw new WaError(e.name === 'AbortError' ? 'WA_TIMEOUT' : String(e.message || e), { status: 599 });
  }
  clearTimeout(timer);

  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    const e = detail && detail.error;
    const err = new WaError((e && e.message) || `Graph ${res.status}`, {
      status: res.status,
      code: e && Number(e.code),
      subcode: e && Number(e.error_subcode),
      detail: e
    });
    if (err.isRetryable && attempt < 2) {
      return backoff(attempt, () => graph(path, { method, body, query, form, attempt: attempt + 1 }));
    }
    throw err;
  }
  return res.json();
}

function backoff(attempt, fn) {
  const wait = 400 * 2 ** attempt + Math.floor(Math.random() * 250);
  return new Promise((resolve) => setTimeout(resolve, wait)).then(fn);
}

const post = (payload) => graph(`${phoneId()}/messages`, { body: { messaging_product: 'whatsapp', ...payload } });

/* ------------------------------ text ------------------------------ */

/**
 * Split a reply into WhatsApp-sized messages, preferring paragraph, then line,
 * then sentence boundaries so a part never ends mid-word.
 */
function chunkText(text, limit = TEXT_LIMIT) {
  const body = String(text == null ? '' : text).trim();
  if (!body) return [];
  if (body.length <= limit) return [body];

  const out = [];
  let rest = body;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = window.lastIndexOf('\n\n');
    if (cut < limit * 0.5) cut = window.lastIndexOf('\n');
    if (cut < limit * 0.5) cut = window.lastIndexOf('. ');
    if (cut > 0 && window[cut] === '.') cut += 1;
    if (cut < limit * 0.5) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = limit;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

/**
 * Send a text reply, chunked. Partial delivery is reported honestly: if part 2 of
 * 3 fails the officer has already seen part 1, and pretending otherwise would
 * have the caller re-send the whole thing.
 */
async function sendText(to, text, { previewUrl = false } = {}) {
  const parts = chunkText(text);
  if (!parts.length) return fail('empty', 'nothing to send');

  const ids = [];
  for (let i = 0; i < parts.length; i++) {
    const suffix = parts.length > 1 ? `\n\n_(${i + 1}/${parts.length})_` : '';
    try {
      const r = await post({
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { preview_url: Boolean(previewUrl), body: parts[i] + suffix }
      });
      ids.push(r && r.messages && r.messages[0] && r.messages[0].id);
    } catch (e) {
      const res = classify(e);
      return { ...res, ids, partial: ids.length > 0, parts: parts.length };
    }
  }
  return ok(ids, { parts: parts.length });
}

/* ------------------------------ interactive ------------------------------ */

/**
 * Validate reply buttons against Meta's caps in code points. All-or-nothing: a
 * payload that does not fit is refused so the caller can fall back to numbered
 * text, rather than being silently mangled.
 */
function validateButtons(body, buttons, { header, footer } = {}) {
  const list = Array.isArray(buttons) ? buttons : [];
  if (!list.length) return { valid: false, reason: 'no_buttons' };
  if (list.length > CAPS.buttons) return { valid: false, reason: 'too_many_buttons' };
  // Graph rejects an empty interactive body, and the rejection message does not
  // say which field was at fault.
  if (!String(body || '').trim()) return { valid: false, reason: 'empty_body' };
  if (glyphs(body) > CAPS.interactiveBody) return { valid: false, reason: 'body_too_long' };
  if (header && glyphs(header) > CAPS.header) return { valid: false, reason: 'header_too_long' };
  if (footer && glyphs(footer) > CAPS.footer) return { valid: false, reason: 'footer_too_long' };

  const seen = new Set();
  for (const b of list) {
    const id = String((b && b.id) || '');
    const title = String((b && b.title) || '');
    if (!id || !title) return { valid: false, reason: 'empty_button' };
    if (glyphs(title) > CAPS.buttonTitle) return { valid: false, reason: 'title_too_long' };
    if (glyphs(id) > CAPS.buttonId) return { valid: false, reason: 'id_too_long' };
    // Duplicate ids make the tap ambiguous, and WhatsApp does not reject them.
    if (seen.has(id)) return { valid: false, reason: 'duplicate_id' };
    seen.add(id);
  }
  return { valid: true };
}

/**
 * Send reply buttons. Button ids are stable and language-independent by contract
 * (see inbound.js): a tap must route on its id, never on its localized title, or
 * an officer switching language breaks their own buttons.
 */
async function sendButtons(to, body, buttons, { header, footer } = {}) {
  const check = validateButtons(body, buttons, { header, footer });
  if (!check.valid) return fail('invalidPayload', 'interactive payload rejected: ' + check.reason, { reason: check.reason });

  try {
    const r = await post({
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        ...(header ? { header: { type: 'text', text: String(header) } } : {}),
        body: { text: String(body) },
        ...(footer ? { footer: { text: String(footer) } } : {}),
        action: {
          buttons: buttons.map((b) => ({ type: 'reply', reply: { id: String(b.id), title: String(b.title) } }))
        }
      }
    });
    return ok([r && r.messages && r.messages[0] && r.messages[0].id]);
  } catch (e) {
    return classify(e);
  }
}

/**
 * An approved template — the only thing Meta permits outside the 24-hour window,
 * so this is what proactive alerts ride on. `params` fill {{1}}..{{n}} in order.
 */
/**
 * Send an approved message template.
 *
 * **Disabled by policy.** Templates are billable and this deployment is deliberately
 * free-form only: a business-initiated message goes out only while the officer's
 * 24-hour service window is open, and otherwise waits. The refusal lives here, at the
 * single transport every template send must pass through, rather than at the one call
 * site that happens to exist today — a policy enforced only where it is currently
 * needed is a policy the next feature silently breaks.
 *
 * Set `WA_ALLOW_TEMPLATES=true` to turn the capability back on. Nothing else is
 * required; the send itself is unchanged and still works.
 */
async function sendTemplate(to, name, params = [], { language } = {}) {
  if (String(process.env.WA_ALLOW_TEMPLATES || '').toLowerCase() !== 'true') {
    return fail('templatesDisabled',
      'Template sending is disabled (WA_ALLOW_TEMPLATES is not true). This deployment sends free-form only, inside the 24-hour service window.');
  }
  if (!name) return fail('missingConfig', 'WA_ALERT_TEMPLATE is not configured');
  try {
    const r = await post({
      recipient_type: 'individual',
      to,
      type: 'template',
      template: {
        name,
        language: { code: language || process.env.WA_ALERT_TEMPLATE_LANG || 'en' },
        components: params.length
          ? [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: String(p).slice(0, 1024) })) }]
          : []
      }
    });
    return ok([r && r.messages && r.messages[0] && r.messages[0].id]);
  } catch (e) {
    return classify(e);
  }
}

/**
 * Mark the officer's message read and raise a typing indicator. The indicator
 * lasts ~25 seconds or until we reply, which covers the agent's think time so the
 * officer sees activity instead of silence. Best-effort by design.
 */
async function markRead(messageId, { typing = true } = {}) {
  try {
    await post({ status: 'read', message_id: messageId, ...(typing ? { typing_indicator: { type: 'text' } } : {}) });
    return true;
  } catch (_) {
    return false;
  }
}

/* ------------------------------ media in ------------------------------ */

/**
 * Hosts Meta actually serves media from.
 *
 * `fbsbx.com` is the important one and the easy one to miss: WhatsApp Cloud API
 * hands out `https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=…`,
 * so an allowlist built from the obvious names (fbcdn, facebook.com) rejects every
 * real photo and voice note while looking perfectly reasonable in review.
 *
 * `mmg.whatsapp.net` appears on some media paths, and `fbcdn.net` on others.
 * Matched on the full hostname with a leading dot or start anchor, so
 * "fbsbx.com.evil.tld" does not pass.
 */
const MEDIA_HOST = /(^|\.)(fbsbx\.com|fbcdn\.net|facebook\.com|whatsapp\.net|whatsapp\.com|cdninstagram\.com)$/i;

/** Resolve a media id to a short-lived (five minute) download URL. */
async function getMediaUrl(mediaId) {
  const r = await graph(String(mediaId), { method: 'GET', query: { phone_number_id: phoneId() } });
  return { url: r && r.url, mime: r && r.mime_type, size: Number((r && r.file_size) || 0), sha256: r && r.sha256 };
}

/**
 * Download media bytes. Three independent size checks, because each one alone
 * can be defeated: Meta's declared file_size, the CDN's Content-Length, and the
 * bytes actually received. The URL is also required to be https on a Meta host —
 * hop two carries our bearer token, and it must not follow a redirect to
 * somebody else's server.
 */
async function downloadMedia(url, { maxBytes = 8 * 1024 * 1024, declaredSize = 0 } = {}) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch (_) {
    throw new WaError('media url is not a url', { status: 400 });
  }
  if (parsed.protocol !== 'https:') throw new WaError('media url is not https', { status: 400 });
  if (!MEDIA_HOST.test(parsed.hostname)) {
    throw new WaError('media url host is not a Meta CDN', { status: 400 });
  }
  if (declaredSize && declaredSize > maxBytes) throw new WaError('media too large', { status: 413 });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs() * 2);
  try {
    const res = await fetch(parsed.toString(), {
      headers: { Authorization: 'Bearer ' + token() },
      redirect: 'follow',
      signal: ctrl.signal
    });
    if (!res.ok) throw new WaError('media download ' + res.status, { status: res.status });
    const contentLength = Number(res.headers.get('content-length') || 0);
    if (contentLength && contentLength > maxBytes) throw new WaError('media too large', { status: 413 });
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new WaError('media too large', { status: 413 });
    if (!buf.length) throw new WaError('media was empty', { status: 502 });
    return { buffer: buf, mime: res.headers.get('content-type') || 'application/octet-stream' };
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch a media id straight to bytes. Throws — media failures need to be handled. */
async function fetchMedia(mediaId, opts = {}) {
  const meta = await getMediaUrl(mediaId);
  if (!meta.url) throw new WaError('media url unavailable');
  const dl = await downloadMedia(meta.url, { ...opts, declaredSize: meta.size });
  return { ...dl, mime: meta.mime || dl.mime, sha256: meta.sha256, size: dl.buffer.length };
}

/* ------------------------------ media out ------------------------------ */

const AUDIO_EXT = { 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/amr': 'amr', 'audio/aac': 'aac' };

/**
 * Upload audio and send it as a voice note.
 *
 * Both the multipart `type` and the filename extension have to agree with the
 * actual bytes; Graph rejects the upload on a mismatch, and the failure message
 * does not say which of the two was wrong. Ogg/Opus is what WhatsApp itself
 * records, so it is the default.
 */
async function sendAudio(to, buffer, { mime = 'audio/ogg' } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return fail('empty', 'no audio to send');
  const baseMime = String(mime).split(';')[0].toLowerCase();
  const ext = AUDIO_EXT[baseMime];
  if (!ext) return fail('invalidPayload', 'unsupported audio mime ' + baseMime);

  try {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', baseMime);
    form.append('file', new Blob([buffer], { type: baseMime }), 'reply.' + ext);
    const up = await graph(`${phoneId()}/media`, { form });
    if (!up || !up.id) return fail('graph', 'media upload returned no id');

    const r = await post({ recipient_type: 'individual', to, type: 'audio', audio: { id: up.id } });
    return ok([r && r.messages && r.messages[0] && r.messages[0].id], { mediaId: up.id });
  } catch (e) {
    return classify(e);
  }
}

module.exports = {
  WaError, configured, verifySignature, verifyChallenge,
  sendText, sendButtons, sendTemplate, sendAudio, markRead,
  getMediaUrl, downloadMedia, fetchMedia,
  chunkText, validateButtons, glyphs, classify,
  TEXT_LIMIT, MAX_BODY_BYTES, CAPS, MEDIA_HOST
};
