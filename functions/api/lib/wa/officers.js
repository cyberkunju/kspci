'use strict';

/**
 * Field-officer identity, authorization, throttling and message ledger.
 *
 * This is the trust boundary for the WhatsApp channel. A WhatsApp number is the
 * only credential a field message carries, so the rule is strict allow-listing:
 * a number that is not an active row in `Officers` gets no data, ever. Roles are
 * read from that row, never from the message, so an officer cannot talk their way
 * into a higher role.
 */

const ROLES = ['investigator', 'analyst', 'supervisor', 'policymaker', 'admin'];

/** Languages the channel speaks. Kept here so the roster column and the copy packs agree. */
const LANGUAGES = ['en', 'kn', 'hi'];

const dtNow = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const genId = (p) => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function flatten(row) {
  const out = {};
  for (const k of Object.keys(row)) {
    const v = row[k];
    if (v && typeof v === 'object') Object.assign(out, v);
    else out[k] = v;
  }
  return out;
}

async function q(app, query) {
  const res = await app.zcql().executeZCQLQuery(query);
  return (res || []).map(flatten);
}

/**
 * WhatsApp reports numbers as digits in E.164 without '+' (wa_id). Everything
 * downstream stores and compares that canonical form.
 *
 * Validation is deliberately strict rather than escape-based: the phone is
 * interpolated into ZCQL, and "digits only, 8-15 long" makes injection
 * structurally impossible instead of merely quoted.
 */
function normalizePhone(input) {
  const raw = String(input == null ? '' : input).trim();
  // Reject anything that is not plausibly a written phone number, rather than
  // stripping it down to digits. Blind stripping turns garbage — or an injection
  // attempt — into a different but structurally valid number, which is worse than
  // refusing it.
  if (!raw || /[^\d\s+()\-.]/.test(raw)) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

const isTrue = (v) => v === true || v === 1 || /^(true|yes|1|active)$/i.test(String(v == null ? '' : v));

function shapeOfficer(row) {
  if (!row) return null;
  const role = String(row.Role || 'investigator').toLowerCase();
  return {
    officerId: row.OfficerID || null,
    phone: row.Phone,
    name: row.Name || 'Officer',
    rank: row.Rank || '',
    role: ROLES.includes(role) ? role : 'investigator',
    state: row.StateName || '',
    district: row.DistrictName || '',
    station: row.StationName || '',
    language: LANGUAGES.includes(String(row.Language || '').toLowerCase())
      ? String(row.Language).toLowerCase() : 'en',
    active: isTrue(row.IsActive),
    alertDistricts: String(row.AlertDistricts || '').split(',').map((s) => s.trim()).filter(Boolean),
    alertSeverity: String(row.AlertSeverity || 'critical').toLowerCase(),
    lastSeenAt: row.LastSeenAt || null,
    rowId: row.ROWID || null
  };
}

/* ------------------------------ lookup ------------------------------ */

/**
 * Resolve a WhatsApp number to an officer. Cached briefly in Catalyst Cache
 * because every inbound message hits this path and the roster changes rarely.
 * A cache miss or a cache failure always falls through to the Data Store — the
 * cache is a latency optimization, never the authority.
 */
async function getOfficer(app, phone) {
  const p = normalizePhone(phone);
  if (!p) return null;
  const key = 'wa_officer_' + p;

  try {
    const cached = await app.cache().segment().getValue(key);
    const val = cached && (cached.cache_value || cached.value || cached);
    if (typeof val === 'string' && val.startsWith('{')) {
      const parsed = JSON.parse(val);
      if (parsed && parsed.phone === p) return parsed.active ? parsed : null;
    }
  } catch (_) { /* cache is optional */ }

  const rows = await q(app, `SELECT * FROM Officers WHERE Phone='${p}' LIMIT 1`);
  const officer = shapeOfficer(rows[0]);
  if (!officer) return null;

  try {
    await app.cache().segment().put(key, JSON.stringify(officer), 1);
  } catch (_) { /* ignore */ }

  return officer.active ? officer : null;
}

async function invalidateOfficer(app, phone) {
  const p = normalizePhone(phone);
  if (!p) return;
  try { await app.cache().segment().delete('wa_officer_' + p); } catch (_) { /* ignore */ }
}

/** Officers who should receive an alert for a district at a given severity. */
async function alertRecipients(app) {
  const rows = await q(app, 'SELECT * FROM Officers LIMIT 300');
  return rows.map(shapeOfficer).filter((o) => o && o.active);
}

/* ------------------------------ registration (admin) ------------------------------ */

/**
 * Register or amend an officer.
 *
 * Creation applies defaults; an amendment patches ONLY the fields the caller
 * supplied. That distinction matters: an admin correcting a rank must not reset
 * the officer's alert subscription to the default, because that subscription is
 * the officer's own consent decision and they would never learn it had been
 * changed. Spreading a fully-defaulted row into updateRow did exactly that.
 */
async function upsertOfficer(app, input) {
  const phone = normalizePhone(input.phone);
  if (!phone) throw new Error('a valid E.164 phone number is required');
  if (input.role !== undefined && !ROLES.includes(String(input.role).toLowerCase())) {
    throw new Error('unknown role: ' + input.role);
  }

  const districts = (value) => (Array.isArray(value) ? value.join(',') : String(value || '')).slice(0, 2000);

  // Only the keys actually present in the request.
  const patch = {};
  const set = (key, value) => { if (value !== undefined) patch[key] = value; };
  set('Name', input.name === undefined ? undefined : (String(input.name).slice(0, 120) || 'Officer'));
  set('Rank', input.rank === undefined ? undefined : String(input.rank).slice(0, 80));
  set('Role', input.role === undefined ? undefined : String(input.role).toLowerCase());
  set('StateName', input.state === undefined ? undefined : String(input.state).slice(0, 80));
  set('DistrictName', input.district === undefined ? undefined : String(input.district).slice(0, 80));
  set('StationName', input.station === undefined ? undefined : String(input.station).slice(0, 120));
  set('Language', input.language === undefined
    ? undefined
    : (LANGUAGES.includes(String(input.language).toLowerCase()) ? String(input.language).toLowerCase() : 'en'));
  set('IsActive', input.active === undefined ? undefined : (input.active === false ? 'false' : 'true'));
  set('AlertDistricts', input.alertDistricts === undefined ? undefined : districts(input.alertDistricts));
  set('AlertSeverity', input.alertSeverity === undefined ? undefined : String(input.alertSeverity).toLowerCase());

  const ds = app.datastore().table('Officers');
  const existing = await q(app, `SELECT ROWID, OfficerID FROM Officers WHERE Phone='${phone}' LIMIT 1`);

  if (existing.length) {
    if (Object.keys(patch).length) {
      await ds.updateRow({ ROWID: existing[0].ROWID, ...patch });
    }
    await invalidateOfficer(app, phone);
    return { phone, updated: true, officerId: existing[0].OfficerID, fields: Object.keys(patch) };
  }

  const row = {
    Phone: phone,
    Name: 'Officer', Rank: '', Role: 'investigator',
    StateName: '', DistrictName: '', StationName: '',
    Language: 'en', IsActive: 'true',
    AlertDistricts: '', AlertSeverity: 'critical',
    ...patch,
    OfficerID: genId('off'),
    OptedInAt: dtNow()
  };
  await ds.insertRow(row);
  await invalidateOfficer(app, phone);
  return { phone, created: true, officerId: row.OfficerID };
}

/**
 * Remove an officer from the roster entirely.
 *
 * The normal way to revoke access is `upsertOfficer({ active: false })` — the
 * lookup refuses an inactive row, and the row stays as the record that this number
 * once held access. Deletion exists for the other case: a number that should never
 * have been on the roster at all (a typo, a test registration), where leaving an
 * inactive row means a live police roster permanently lists a number nobody owns.
 *
 * The message ledger is kept by default. Those rows are the audit trail for data
 * this number was shown, and an audit trail that disappears when the account does
 * is not an audit trail. `purgeLedger` is for traffic that was never real — the
 * same typo-or-test case — and says how many rows it removed so the deletion is
 * itself visible in the response.
 */
async function deleteOfficer(app, { phone, purgeLedger = false } = {}) {
  const p = normalizePhone(phone);
  if (!p) throw new Error('a valid E.164 phone number is required');

  const ds = app.datastore();
  const rows = await q(app, `SELECT ROWID, OfficerID FROM Officers WHERE Phone='${p}' LIMIT 1`);
  const out = { phone: p, deleted: false, officerId: null };

  if (rows.length) {
    await ds.table('Officers').deleteRow(rows[0].ROWID);
    // Invalidate after the delete, not before: a cached row re-read between the two
    // would put the officer straight back into the cache for another hour.
    await invalidateOfficer(app, p);
    out.deleted = true;
    out.officerId = rows[0].OfficerID || null;
  } else {
    out.reason = 'not on the roster';
  }

  // The purge runs whether or not there was a roster row. The number that most needs
  // its ledger cleared is one that was never an officer — a wrong number, or an
  // unknown caller whose rejected attempts we logged — and refusing to touch those
  // would leave the one case this is for unreachable.
  if (purgeLedger) {
    let removed = 0;
    // deleteRows caps at 200 ids per call, so page rather than assuming one pass.
    for (let pass = 0; pass < 25; pass++) {
      const ledger = await q(app, `SELECT ROWID FROM WaMessages WHERE Phone='${p}' LIMIT 200`);
      if (!ledger.length) break;
      await ds.table('WaMessages').deleteRows(ledger.map((r) => r.ROWID));
      removed += ledger.length;
      if (ledger.length < 200) break;
    }
    out.ledgerRowsPurged = removed;
  }
  return out;
}

/**
 * Persist the officer's own language choice.
 *
 * Written to the roster row, not just to the turn's pending blob, because it has to
 * outlive the conversation: a proactive alert is composed with no turn in flight, and
 * an officer who asked for Hindi should not get an English push at 6am.
 */
async function setLanguage(app, officer, language) {
  const code = String(language || '').toLowerCase();
  if (!LANGUAGES.includes(code)) throw new Error('language must be one of ' + LANGUAGES.join(', '));
  if (!officer || !officer.rowId) throw new Error('officer record not found');
  await app.datastore().table('Officers').updateRow({ ROWID: officer.rowId, Language: code });
  await invalidateOfficer(app, officer.phone);
  return code;
}

/**
 * Persist the officer's access context.
 *
 * Caller-gated, not gated here: `WA_SELF_ROLE` decides whether an officer may set
 * their own, and that decision belongs at the point where officer intent is being
 * interpreted rather than buried in a setter. Every change is audited against their
 * identity, because a role change is the single most consequential thing this channel
 * can write.
 */
async function setRole(app, officer, role) {
  const r = String(role || '').toLowerCase();
  if (!ROLES.includes(r)) throw new Error('role must be one of ' + ROLES.join(', '));
  if (!officer || !officer.rowId) throw new Error('officer record not found');
  const previous = officer.role;
  await app.datastore().table('Officers').updateRow({ ROWID: officer.rowId, Role: r });
  await invalidateOfficer(app, officer.phone);
  await logMessage(app, {
    direction: 'audit', phone: officer.phone, officerId: officer.officerId,
    type: 'role-change', body: `role ${previous} -> ${r} (set by the officer over WhatsApp)`,
    status: 'applied'
  });
  return r;
}

/** Persist an officer's own alert preferences (set by the officer over WhatsApp). */
async function setAlertPrefs(app, officer, { districts, severity }) {
  if (!officer || !officer.rowId) throw new Error('officer record not found');
  const patch = { ROWID: officer.rowId };
  if (districts !== undefined) {
    patch.AlertDistricts = (Array.isArray(districts) ? districts : String(districts || '').split(','))
      .map((s) => String(s).trim()).filter(Boolean).join(',').slice(0, 2000);
  }
  if (severity !== undefined) {
    const s = String(severity).toLowerCase();
    if (!['critical', 'elevated', 'watch', 'none'].includes(s)) throw new Error('severity must be critical, elevated, watch or none');
    patch.AlertSeverity = s;
  }
  await app.datastore().table('Officers').updateRow(patch);
  await invalidateOfficer(app, officer.phone);
  return { districts: patch.AlertDistricts, severity: patch.AlertSeverity };
}

/**
 * Stamp presence and persist the turn's conversational state in ONE write.
 *
 * `LastSeenAt` decides whether a later proactive alert may be free-form or must
 * be a template, and the pending blob carries the open frame, the language prior
 * and the undo ledger. Both change on every turn, so they share the update — an
 * extra round-trip per message on a field channel is latency an officer feels.
 */
async function touchOfficer(app, officer, pending) {
  if (!officer || !officer.rowId) return;
  const patch = { ROWID: officer.rowId, LastSeenAt: dtNow() };
  if (pending !== undefined) patch.Pending = serializePending(pending);
  try {
    await app.datastore().table('Officers').updateRow(patch);
  } catch (_) { /* non-fatal: presence tracking must never block a reply */ }
}

/* ------------------------------ conversational state ------------------------------ */

/**
 * The pending blob: open frame, language prior, undo ledger.
 *
 * Read straight from the Data Store rather than from the officer cache. The cache
 * holds identity and role, which change on a roster edit; this changes every turn,
 * and a stale copy would make the bot forget the question it just asked. One
 * extra read per turn is the price of that never happening.
 */
/**
 * A ROWID as a safe SQL literal: digits only, or null. Validating the shape is
 * what makes direct interpolation safe, and keeping it a string is what keeps a
 * 17-digit id intact.
 */
function rowIdLiteral(value) {
  const s = String(value == null ? '' : value).trim();
  return /^\d{1,25}$/.test(s) ? s : null;
}

async function getPending(app, officer) {
  if (!officer || !officer.rowId) return {};
  try {
    // Interpolated as digits, NOT through Number(). A Catalyst ROWID is around
    // 5.1e16, well past Number.MAX_SAFE_INTEGER (9.0e15), so converting it to a
    // double can silently change the last digits and read the wrong row — or none.
    const rowId = rowIdLiteral(officer.rowId);
    if (!rowId) return {};
    const rows = await q(app, `SELECT Pending FROM Officers WHERE ROWID=${rowId} LIMIT 1`);
    return parsePending(rows[0] && rows[0].Pending);
  } catch (_) {
    return {};
  }
}

function parsePending(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const v = JSON.parse(String(raw));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (_) {
    return {};
  }
}

/**
 * Serialize for the column, with a hard size ceiling. The blob is bounded by
 * construction (one frame, 12 prior entries, 5 undo records), but a runaway value
 * must degrade to an empty state rather than fail the write that also stamps
 * LastSeenAt — losing a frame is recoverable, losing the service window is not.
 */
function serializePending(pending) {
  const p = pending && typeof pending === 'object' ? pending : {};
  const s = JSON.stringify(p);
  return s.length <= 8000 ? s : '{}';
}

/* ------------------------------ undo tokens ------------------------------ */

/**
 * Token alphabet with the ambiguous glyphs removed: no I, L, O, 0 or 1. An
 * officer reads this off a phone screen in daylight and types it back, so O/0
 * and I/1/l confusion is a guaranteed support call.
 */
const TOKEN_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const UNDO_TTL_MS = 30 * 60 * 1000;
const UNDO_KEEP = 5;

/**
 * A token must contain at least one digit AND at least one letter. That single
 * rule is what stops ordinary words and bare numbers from being read as undo
 * codes: "BUDGET" has no digit, "234567" has no letter, and neither can ever
 * accidentally reverse an officer's work.
 */
const TOKEN_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const TOKEN_DIGITS = '23456789';
const pick = (set) => set[Math.floor(Math.random() * set.length)];

/**
 * Built to satisfy the rule rather than sampled until it happens to. Rejection
 * sampling needed a fallback for the case where every attempt failed, and a FIXED
 * fallback token is a collision waiting to happen — two officers handed the same
 * code, each able to reverse the other's write.
 */
function mintUndoToken() {
  const chars = [pick(TOKEN_LETTERS), pick(TOKEN_DIGITS)];
  while (chars.length < 6) chars.push(pick(TOKEN_ALPHABET));
  // Fisher-Yates, so the guaranteed letter and digit are not always in positions 1-2.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

const TOKEN_SHAPE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;

/**
 * Is this message an undo instruction, and nothing else?
 *
 * Both forms are accepted, because officers write both: the bare code, and the
 * code after a verb ("undo A2B3C4", "cancel A2B3C4"). Accepting only the bare
 * form makes the natural phrasing fall through to the model, which then has to
 * guess at a reversal — precisely the decision we took out of its hands.
 *
 * The digit-and-letter requirement is what makes the prefixed form safe too:
 * "undo the enrolment" cannot produce a token, and neither can "cancel BUDGET".
 */
function looksLikeUndoToken(body) {
  const raw = String(body || '').trim();
  if (!raw) return null;

  const prefixed = raw.match(/^\s*(?:undo|revert|reverse|cancel|remove|ರದ್ದು|ಹಿಂತೆಗೆ)\s+([A-Za-z0-9]{6})\s*[.!]?\s*$/i);
  const candidate = prefixed
    ? prefixed[1].toUpperCase()
    : raw.toUpperCase().replace(/^[^A-Z2-9]+|[^A-Z2-9]+$/g, '');

  if (!TOKEN_SHAPE.test(candidate)) return null;
  if (!/[2-9]/.test(candidate) || !/[A-Z]/.test(candidate)) return null;
  return candidate;
}

/**
 * Record a reversible action against a fresh token. Mutates `pending`; the caller
 * persists it with the turn's single write.
 */
function recordUndo(pending, { action, payload, describe }) {
  const p = pending && typeof pending === 'object' ? pending : {};
  const token = mintUndoToken();
  const list = Array.isArray(p.undo) ? p.undo : [];
  p.undo = [{ token, action, payload: payload || {}, describe: String(describe || action).slice(0, 160), ts: Date.now() }]
    .concat(list.filter((u) => u && u.token !== token))
    .slice(0, UNDO_KEEP);
  return token;
}

/**
 * Look a token up. Returns { found, expired, used, record }, so the caller can
 * tell "never existed" from "already reversed" — the officer needs to know which.
 */
function findUndo(pending, token) {
  const list = (pending && Array.isArray(pending.undo)) ? pending.undo : [];
  const record = list.find((u) => u && u.token === token);
  if (!record) return { found: false };
  if (Date.now() - Number(record.ts || 0) > UNDO_TTL_MS) return { found: true, expired: true, record };
  if (record.used) return { found: true, used: true, record };
  return { found: true, record };
}

/** Mark a token spent, so a double-tap cannot reverse twice. */
function consumeUndo(pending, token) {
  const list = (pending && Array.isArray(pending.undo)) ? pending.undo : [];
  for (const u of list) if (u && u.token === token) u.used = true;
  return pending;
}

/**
 * Meta only permits free-form replies inside 24 hours of the officer's last
 * inbound message. Outside it, proactive sends must use an approved template.
 */
function withinServiceWindow(officer) {
  if (!officer || !officer.lastSeenAt) return false;
  const seen = Date.parse(String(officer.lastSeenAt).replace(' ', 'T') + 'Z');
  if (!Number.isFinite(seen)) return false;
  return Date.now() - seen < 24 * 60 * 60 * 1000;
}

/* ------------------------------ throttle ------------------------------ */

/**
 * Per-number hourly cap. Guards LLM spend and blunts a compromised handset.
 *
 * ponytail: this is a coarse fixed-window counter in Catalyst Cache, whose
 * minimum TTL is one hour, and get-then-put is not atomic — a burst of
 * simultaneous messages can slip a couple over the cap. That is the right
 * trade for abuse control; if precise limiting ever matters, move the counter
 * into a Data Store row and increment under a read-modify-write.
 */
async function checkRate(app, phone, limit = Number(process.env.WA_RATE_LIMIT || 60)) {
  const bucket = new Date().toISOString().slice(0, 13); // yyyy-mm-ddThh
  const key = `wa_rate_${phone}_${bucket}`;
  try {
    const seg = app.cache().segment();
    const cur = await seg.getValue(key);
    const raw = cur && (cur.cache_value || cur.value || cur);
    const count = Number(raw) || 0;
    if (count >= limit) return { allowed: false, count, limit };
    await seg.put(key, String(count + 1), 1);
    return { allowed: true, count: count + 1, limit };
  } catch (_) {
    return { allowed: true, count: 0, limit, degraded: true };
  }
}

/* ------------------------------ message ledger ------------------------------ */

/**
 * Claim an inbound message id exactly once.
 *
 * Meta redelivers a webhook whenever it does not see a prompt 200, so without
 * this the officer gets the same answer twice and we pay for the LLM twice. The
 * cache claim is the fast path; the WaMessages row is the durable audit record
 * and the fallback when the cache is unavailable.
 */
const CLAIM_STALE_MS = 120 * 1000;
const seenKey = (msgId) => 'wa_seen_' + String(msgId).slice(-64);

async function claimMessage(app, msgId, meta = {}) {
  if (!msgId) return { claimed: true };
  const key = seenKey(msgId);
  try {
    const seg = app.cache().segment();
    const raw = await seg.getValue(key);
    const val = raw && (raw.cache_value || raw.value || raw);
    if (val) {
      const state = readClaim(val);
      // Completed: this message has been answered. Never process it twice.
      if (state.done) return { claimed: false, via: 'cache', reason: 'completed' };
      // In flight. A worker that died mid-turn would otherwise strand the message
      // forever, because Meta stops redelivering once we have acknowledged; the
      // retry that matters is the job's own, and it must be allowed through.
      if (Date.now() - state.ts < CLAIM_STALE_MS) return { claimed: false, via: 'cache', reason: 'in_flight' };
      await seg.put(key, claimValue('p'), 1);
      return { claimed: true, reclaimed: true };
    }
    await seg.put(key, claimValue('p'), 1);
  } catch (_) {
    // Cache unavailable — fall back to the ledger. Slower, durable, and it skips
    // rows that were explicitly released after a failed attempt.
    try {
      const rows = await q(app,
        `SELECT ROWID, Status FROM WaMessages WHERE MsgID='${String(msgId).replace(/'/g, '')}' LIMIT 2`);
      if (rows.some((r) => String(r.Status || '') !== 'released')) return { claimed: false, via: 'datastore' };
    } catch (_) { /* if both fail, prefer answering over dropping the message */ }
  }
  await logMessage(app, { direction: 'in', msgId, ...meta });
  return { claimed: true };
}

const claimValue = (s) => JSON.stringify({ s, ts: Date.now() });

function readClaim(val) {
  if (typeof val === 'string' && val.startsWith('{')) {
    try {
      const v = JSON.parse(val);
      return { done: v.s === 'd', ts: Number(v.ts) || 0 };
    } catch (_) { /* fall through to the legacy shape */ }
  }
  // Legacy '1' marker written before claims carried state: treat as completed,
  // which is the safe reading — it means some earlier worker got there first.
  return { done: true, ts: Date.now() };
}

/**
 * Has this message already been answered?
 *
 * `claimMessage` refuses a completed message, but it also writes the inbound ledger
 * row, so it can only be called once per message — on the webhook. The job that
 * carries the turn POSTs straight to /whatsapp/process, which bypasses it entirely,
 * and that is the path the job runner retries.
 *
 * It has to retry there: Catalyst decides a webhook job failed from the HTTP response
 * it sees, so a turn slower than its timeout is marked failed and re-dispatched no
 * matter what status code the function eventually returns. That is how one officer's
 * question got answered twice, 60 seconds apart — one `retry_interval`.
 *
 * Only the **completed** state counts as answered. An in-flight claim must pass,
 * because the inline path claims the message immediately before processing it, and a
 * released claim must pass because releasing it is precisely how a failed pre-agent
 * attempt asks to be retried.
 *
 * Fails open on a cache error: answering twice is bad, dropping an officer's message
 * is worse.
 */
async function messageAlreadyAnswered(app, msgId) {
  if (!msgId) return false;
  try {
    const raw = await app.cache().segment().getValue(seenKey(msgId));
    const val = raw && (raw.cache_value || raw.value || raw);
    return Boolean(val) && readClaim(val).done;
  } catch (_) {
    return false;
  }
}

/** Mark a turn finished. After this the message id can never be processed again. */
async function completeMessage(app, msgId) {
  if (!msgId) return;
  try { await app.cache().segment().put(seenKey(msgId), claimValue('d'), 1); } catch (_) { /* ignore */ }
}

/**
 * Give a claim back after a failed attempt, so the job's retry can pick it up
 * immediately instead of waiting out the stale window. Paired with forgetting the
 * ledger marker, otherwise the Data Store fallback would read the released
 * message as a duplicate.
 */
async function releaseMessage(app, msgId) {
  if (!msgId) return;
  try { await app.cache().segment().delete(seenKey(msgId)); } catch (_) { /* ignore */ }
  try {
    const rows = await q(app, `SELECT ROWID FROM WaMessages WHERE MsgID='${String(msgId).replace(/'/g, '')}' LIMIT 1`);
    if (rows.length) await app.datastore().table('WaMessages').updateRow({ ROWID: rows[0].ROWID, Status: 'released' });
  } catch (_) { /* ignore */ }
}

/**
 * Append to the field-channel audit trail. Every inbound message, every reply,
 * and every alert lands here — the governance requirement for this channel is
 * the same as for the web app's AuditLog.
 */
async function logMessage(app, { direction, msgId, phone, officerId, type, body, mediaKey, sessionId, status }) {
  try {
    await app.datastore().table('WaMessages').insertRow({
      MsgID: String(msgId || genId('wa')).slice(0, 240),
      Direction: direction || 'in',
      Phone: normalizePhone(phone) || String(phone || '').slice(0, 20),
      OfficerID: officerId || '',
      MsgType: String(type || 'text').slice(0, 40),
      Body: String(body == null ? '' : body).slice(0, 40000),
      MediaKey: String(mediaKey || '').slice(0, 400),
      SessionID: sessionId || '',
      Status: status || '',
      CreatedAt: dtNow()
    });
  } catch (_) { /* never let audit failure break the conversation */ }
}

/** Was this alert already delivered to this officer? Keyed on the ledger. */
async function alertAlreadySent(app, alertKey) {
  const safe = String(alertKey).replace(/'/g, '');
  try {
    const rows = await q(app, `SELECT ROWID FROM WaMessages WHERE MsgID='${safe}' LIMIT 1`);
    return rows.length > 0;
  } catch (_) {
    return false;
  }
}

/** Recent conversation turns for multi-turn context, oldest first. */
async function recentTurns(app, phone, limit = 6) {
  const p = normalizePhone(phone);
  if (!p) return [];
  // Filtered in the query, not after it. Audit, alert and status rows share this
  // table, and letting them consume the LIMIT meant history thinned out on exactly
  // the turns that wrote or used biometrics — the ones where context matters most.
  const rows = await q(app,
    `SELECT Direction, Body, MsgType FROM WaMessages WHERE Phone='${p}' AND Direction IN ('in','out') ORDER BY CREATEDTIME DESC LIMIT ${Math.min(Number(limit) || 6, 20)}`);
  return rows.reverse()
    .filter((r) => r.Direction === 'in' || r.Direction === 'out')
    .map((r) => ({
      role: r.Direction === 'in' ? 'user' : 'assistant',
      content: String(r.Body || '').slice(0, 600)
    }))
    .filter((m) => m.content);
}

/* ------------------------------ per-officer turn lock ------------------------------ */

const LOCK_HOLD_MS = 90 * 1000;
const lockKey = (phone) => 'wa_lock_' + phone;

/**
 * Serialize turns for one officer.
 *
 * Two messages from the same handset arriving seconds apart both read the pending
 * blob, both write it, and the second write erases the first — which loses the
 * open frame, the language prior, or an undo token. That is a real lost-update,
 * not a hypothetical one: officers routinely fire a photo and a caption as two
 * messages.
 *
 * It fails OPEN. If the lock cannot be taken within the wait budget we process
 * anyway and say so in the log. A rare interleaved write is a smaller harm than
 * an officer's message being dropped because a previous turn hung.
 */
async function acquireTurnLock(app, phone, { waitMs = 8000 } = {}) {
  const key = lockKey(phone);
  const deadline = Date.now() + waitMs;
  let seg;
  try { seg = app.cache().segment(); } catch (_) { return { held: false, degraded: true }; }

  for (;;) {
    try {
      const raw = await seg.getValue(key);
      const val = raw && (raw.cache_value || raw.value || raw);
      const heldAt = val ? Number((JSON.parse(String(val)) || {}).ts) || 0 : 0;
      if (!val || Date.now() - heldAt > LOCK_HOLD_MS) {
        await seg.put(key, JSON.stringify({ ts: Date.now() }), 1);
        return { held: true };
      }
    } catch (_) {
      return { held: false, degraded: true };
    }
    if (Date.now() >= deadline) return { held: false, contended: true };
    await new Promise((r) => setTimeout(r, 900));
  }
}

async function releaseTurnLock(app, phone) {
  try { await app.cache().segment().delete(lockKey(phone)); } catch (_) { /* ignore */ }
}

module.exports = {
  ROLES, normalizePhone, getOfficer, invalidateOfficer, alertRecipients,
  upsertOfficer, deleteOfficer, setAlertPrefs, setLanguage, setRole,
  touchOfficer, withinServiceWindow, LANGUAGES,
  checkRate, claimMessage, completeMessage, releaseMessage, logMessage,
  messageAlreadyAnswered,
  alertAlreadySent, recentTurns, shapeOfficer, dtNow, genId,
  getPending, parsePending, serializePending, rowIdLiteral,
  mintUndoToken, looksLikeUndoToken, recordUndo, findUndo, consumeUndo,
  acquireTurnLock, releaseTurnLock,
  UNDO_TTL_MS, CLAIM_STALE_MS, LOCK_HOLD_MS
};
