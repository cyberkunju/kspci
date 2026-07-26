'use strict';

/**
 * Inbound orchestration: Meta webhook -> normalized event -> agent -> reply.
 *
 * The webhook has one hard constraint that dictates the shape of this module.
 * Meta redelivers any webhook it does not see acknowledged promptly, and a turn
 * here takes ten to twenty seconds (an LLM loop, several database round-trips, and
 * up to a dozen Zia comparisons for a photo). Acknowledging only after the work is
 * done guarantees duplicate deliveries and duplicate replies.
 *
 * So the webhook does the cheap part inline — authenticate, normalize, claim the
 * message id exactly once, put a read receipt on the officer's handset — and hands
 * the expensive part to a Catalyst Job Scheduling webhook job that calls back into
 * /whatsapp/process. That buys a fast 200, durable retries, and isolation: a
 * failing photo lookup retries without Meta resending anything.
 *
 * With no job pool configured (local development, or before provisioning) it
 * degrades to processing inline. Correct, just slower and without retries.
 */

const wa = require('./client');
const officers = require('./officers');
const agent = require('./agent');
const frames = require('./frames');
const lang = require('./lang');
const { messages: pack } = require('./copy');
const { nearestDistrict } = require('../analytics');

const MEDIA_LIMIT = 8 * 1024 * 1024;

/* ------------------------------ normalization ------------------------------ */

/**
 * Flatten Meta's nested envelope into the events we care about. Written
 * defensively: this is untrusted third-party input whose shape changes between
 * Graph versions, so anything unexpected is skipped rather than thrown on — and an
 * unknown message type still yields an event, so the officer gets an answer
 * instead of silence.
 */
function parseWebhook(body) {
  const events = [];
  const entries = Array.isArray(body && body.entry) ? body.entry : [];
  for (const entry of entries) {
    const changes = Array.isArray(entry && entry.changes) ? entry.changes : [];
    for (const change of changes) {
      const v = (change && change.value) || {};
      const phoneNumberId = (v.metadata && v.metadata.phone_number_id) || null;
      const profileName = (Array.isArray(v.contacts) && v.contacts[0] && v.contacts[0].profile && v.contacts[0].profile.name) || null;

      for (const msg of Array.isArray(v.messages) ? v.messages : []) {
        events.push(normalizeMessage(msg, { profileName, phoneNumberId }));
      }

      // Delivery receipts. Recorded, not acted on — they close the loop on whether
      // a pushed alert actually landed on the officer's handset.
      for (const s of Array.isArray(v.statuses) ? v.statuses : []) {
        events.push({
          kind: 'status', msgId: s.id, recipient: s.recipient_id, status: s.status,
          timestamp: Number(s.timestamp) || 0,
          errorCode: (Array.isArray(s.errors) && s.errors[0] && Number(s.errors[0].code)) || null
        });
      }
    }
  }
  return events;
}

function normalizeMessage(m, { profileName, phoneNumberId }) {
  const e = {
    kind: 'message', msgId: m.id, from: m.from, profileName, phoneNumberId,
    timestamp: Number(m.timestamp) || Math.floor(Date.now() / 1000),
    type: m.type, text: '', caption: '', mediaId: null, mediaMime: null,
    location: null, replyId: null,
    // The message this one is a reply to. For an interactive tap this is the
    // question we asked, which is what makes staleness detectable.
    contextMsgId: (m.context && m.context.id) || null
  };

  switch (m.type) {
    case 'text':
      e.text = (m.text && m.text.body) || '';
      break;
    case 'image':
      e.mediaId = m.image && m.image.id;
      e.mediaMime = (m.image && m.image.mime_type) || 'image/jpeg';
      e.caption = (m.image && m.image.caption) || '';
      break;
    case 'document':
      e.mediaId = m.document && m.document.id;
      e.mediaMime = (m.document && m.document.mime_type) || 'application/pdf';
      e.caption = (m.document && (m.document.caption || m.document.filename)) || '';
      break;
    case 'audio':
    case 'voice':
      e.mediaId = m.audio && m.audio.id;
      e.mediaMime = (m.audio && m.audio.mime_type) || 'audio/ogg';
      break;
    case 'interactive': {
      const i = m.interactive || {};
      const reply = i.button_reply || i.list_reply || {};
      e.replyId = reply.id || null;
      e.text = reply.title || reply.id || '';
      break;
    }
    case 'button':
      // A template quick-reply. Carries a payload rather than a structured id.
      e.replyId = (m.button && m.button.payload) || null;
      e.text = (m.button && m.button.text) || '';
      break;
    case 'location':
      e.location = {
        lat: Number(m.location && m.location.latitude),
        lng: Number(m.location && m.location.longitude),
        name: (m.location && m.location.name) || ''
      };
      break;
    default:
      break;
  }
  return e;
}

/* ------------------------------ fast path ------------------------------ */

/**
 * Called straight from the webhook route. Does the minimum, then returns.
 * Never throws: an error here would make Meta retry a message we already claimed.
 */
async function acceptWebhook(app, body) {
  const events = parseWebhook(body);
  const out = { received: events.length, queued: 0, duplicates: 0, statuses: 0, inline: 0 };

  for (const e of events) {
    try {
      if (e.kind === 'status') {
        out.statuses++;
        if (e.status === 'failed' || e.status === 'delivered') {
          await officers.logMessage(app, {
            direction: 'status', msgId: 'st_' + e.msgId + '_' + e.status, phone: e.recipient,
            type: 'status', body: e.status + (e.errorCode ? ' code=' + e.errorCode : ''), status: e.status
          });
        }
        continue;
      }
      if (!e.from || !e.msgId) continue;

      const claim = await officers.claimMessage(app, e.msgId, {
        phone: e.from, type: e.type,
        body: e.text || e.caption || (e.mediaId ? '[' + e.type + ']' : '')
      });
      if (!claim.claimed) { out.duplicates++; continue; }

      // Acknowledge on the handset immediately: read receipt plus typing bubble,
      // so the officer sees the message landed even though the answer is seconds
      // away. Deliberately not awaited — it must never delay the 200.
      wa.markRead(e.msgId).catch(() => {});

      const q = await enqueue(app, e);
      if (q.ok) out.queued++;
      else {
        // Report why the queue was not used. Falling back inline is correct, but a
        // fallback that happens on every single turn means the queue is broken, and
        // without this the only difference is a few hundred milliseconds nobody sees.
        if (q.error) out.enqueueError = q.error;
        await processEvent(app, e);
        out.inline++;
      }
    } catch (err) {
      out.error = String((err && err.message) || err).slice(0, 200);
    }
  }
  return out;
}

/**
 * Hand the turn to a Catalyst webhook job.
 *
 * Returns `{ ok: false, error }` when job scheduling is unconfigured or the
 * submission fails, so the caller falls back inline — losing the queue must never
 * lose the officer's message. The reason travels with the result because a queue
 * that fails on every turn is otherwise indistinguishable from one that works:
 * both answer 200 and both eventually reply to the officer.
 */
async function enqueue(app, event) {
  const pool = process.env.WA_JOBPOOL;
  const url = process.env.WA_PROCESS_URL;
  if (!pool || !url) return { ok: false };
  try {
    await app.jobScheduling().JOB.submitJob({
      // Catalyst caps job_name at 20 characters and rejects the whole submission
      // otherwise ("job_name should be within 1-20 char length"). Non-alphanumerics
      // are stripped as well: a real wamid is base64 and ends in '=' padding, which
      // is not worth discovering the same way. The tail is kept rather than the head
      // because a wamid's leading bytes are a constant prefix across every message.
      job_name: ('wa' + String(event.msgId).replace(/[^A-Za-z0-9]/g, '')).slice(-20),
      jobpool_name: pool,
      target_type: 'Webhook',
      request_method: 'POST',
      url,
      headers: { 'x-wa-internal-key': process.env.WA_INTERNAL_KEY || '', 'Content-Type': 'application/json' },
      request_body: JSON.stringify({ event }),
      job_config: { number_of_retries: 2, retry_interval: 60 }
    });
    return { ok: true };
  } catch (e) {
    const error = String((e && e.message) || e).slice(0, 300);
    console.error('wa job submit failed, processing inline:', error);
    return { ok: false, error };
  }
}

/* ------------------------------ processing ------------------------------ */

/**
 * Handle one claimed message to completion.
 *
 * The claim is released on an unexpected failure so the job's retry can pick it
 * up immediately, and completed on success so no retry can answer twice.
 */
async function processEvent(app, event) {
  const phone = officers.normalizePhone(event.from);
  if (!phone) return { skipped: 'bad_phone' };

  const officer = await officers.getOfficer(app, phone);
  if (!officer) return rejectUnknown(app, phone, event);

  // A first-pass language read for the replies that happen BEFORE the agent runs:
  // the throttle notice and the media refusals. The agent re-resolves it later with
  // the officer's prior and any speech-engine hint, which is strictly better — but
  // these paths never reach the agent, and they must not default to English.
  const turnLang = lang.resolveLanguage({
    text: [event.text, event.caption].filter(Boolean).join(' '),
    preference: officer.language
  }).language;

  const rate = await officers.checkRate(app, phone);
  if (!rate.allowed) {
    await reply(app, officer, pack(turnLang).throttled(rate.limit), { language: turnLang });
    return { throttled: true };
  }

  // Serialize this officer's turns: two messages seconds apart would otherwise
  // both read the pending blob and the second write would erase the first,
  // losing the open frame or an undo token. Fails open (see acquireTurnLock).
  const lock = await officers.acquireTurnLock(app, phone);
  let agentStarted = false;

  try {
    const pending = await officers.getPending(app, officer);
    const turn = await buildTurn(app, officer, event, pending, turnLang);

    if (turn.refusal) {
      await reply(app, officer, turn.refusal, { language: turnLang });
      await officers.touchOfficer(app, officer, pending);
      await officers.completeMessage(app, event.msgId);
      return { refused: true };
    }

    const history = await officers.recentTurns(app, phone, 6);
    // From here on the turn may have written something — a gallery photo, an alert
    // subscription — so a retry is no longer safe. See the catch below.
    agentStarted = true;
    const result = await agent.handleTurn(app, { officer, pending, turn, history });

    // Echo what was heard from a voice note. A mis-transcription that is never
    // shown looks like the bot answering a different question for no reason, and
    // the officer has no way to tell which of the two went wrong.
    const echo = turn.transcript ? `_🎙 "${turn.transcript.slice(0, 180)}"_\n\n` : '';
    const outText = echo + result.reply;

    // Offer taps whenever this reply is the frame's question — the first ask, and
    // the re-prompt after an unusable answer. Without the re-prompt case the
    // officer is told to "reply with a number from 1 to 2" having only ever been
    // shown buttons.
    //
    // The echo rides on the interactive body too: a button message replaces the
    // text bubble entirely, so prefixing only `outText` would drop the transcript
    // on exactly the turns where it matters most.
    const isRetry = String(result.decision.frame || '').startsWith('retry');
    const offer = (result.decision.route === 'agent' || isRetry)
      ? pendingInteractive(result.pending, isRetry ? outText : undefined)
      : null;
    if (offer && echo && !isRetry) offer.body = echo + offer.body;

    const sent = await reply(app, officer, outText, {
      language: result.language,
      interactive: offer,
      voice: turn.wasVoice,
      voiceText: result.reply
    });

    if (sent.ok) {
      // A frame we just opened needs the id of the message that asked the question,
      // so a tap on it can be checked for staleness on the next turn.
      if (sent.promptMsgId) {
        const frame = frames.getFrame(result.pending);
        if (frame) frame.context = { ...(frame.context || {}), promptMsgId: sent.promptMsgId };
      }
    } else {
      // The question never reached the officer, so nothing they send next is an
      // answer to it. Leaving the frame open would resolve their fresh request
      // against a prompt they never saw.
      frames.clearFrame(result.pending);
    }

    // Ordering matters: LastSeenAt decides whether a later proactive alert may be
    // free-form or must use a template, and it is stamped together with the
    // conversational state in one write.
    await officers.touchOfficer(app, officer, result.pending);

    // Completed even when the SEND failed, deliberately. A retry would re-run the
    // whole turn, and a turn that already enrolled a photo would enrol it twice —
    // a silent duplicate write is worse than a lost reply the officer can see did
    // not arrive. The failure is in the decision log; the officer re-sends.
    await officers.completeMessage(app, event.msgId);

    logDecision(officer, event, result, sent, lock);

    if (result.usedBiometrics || result.wrote || result.injectionFlags.length) {
      await officers.logMessage(app, {
        direction: 'audit', phone, officerId: officer.officerId, type: 'action',
        body: JSON.stringify({
          route: result.decision.route,
          biometric: result.usedBiometrics,
          wrote: result.wrote,
          undoToken: result.undoToken || null,
          injection: result.injectionFlags,
          tools: result.invoked,
          queries: result.executed.map((x) => x.zcql).slice(0, 5)
        }).slice(0, 4000)
      });
    }
    return { answered: true, route: result.decision.route, steps: result.decision.steps || 0 };
  } catch (e) {
    // Unexpected failure. Tell the officer something, then decide whether a retry is
    // safe — which depends entirely on whether the agent had started.
    //
    // Before the agent: nothing has been written, so give the claim back and ask for
    // a retry. That covers a roster read, a lock, or a media fetch falling over.
    //
    // After the agent: the turn may already have enrolled a photo or changed a
    // subscription, and re-running it would do that twice. A silent duplicate write
    // is worse than a turn the officer can see failed and re-send themselves.
    //
    // The language is re-derived from the raw message rather than falling back to the
    // roster preference. An officer who wrote Kannada and got an English apology has
    // been failed twice.
    console.error('wa turn failed', phone, 'agentStarted=' + agentStarted, String((e && e.message) || e));
    const failLang = lang.resolveLanguage({
      text: [event.text, event.caption].filter(Boolean).join(' '),
      preference: officer.language
    }).language;
    await reply(app, officer, pack(failLang).engineError, { language: failLang }).catch(() => {});

    if (agentStarted) await officers.completeMessage(app, event.msgId);
    else await officers.releaseMessage(app, event.msgId);

    return { error: String((e && e.message) || e).slice(0, 200), retry: !agentStarted };
  } finally {
    if (lock.held) await officers.releaseTurnLock(app, phone);
  }
}

/**
 * One structured line per turn. This is the only thing that makes the channel
 * debuggable after the fact: which route handled the message, which language was
 * chosen and why, how many tool calls it took, and whether anything was gated.
 */
function logDecision(officer, event, result, sent, lock) {
  console.log('WA_DECISION ' + JSON.stringify({
    msg: String(event.msgId || '').slice(-12),
    officer: officer.officerId || officer.phone,
    role: officer.role,
    type: event.type,
    lang: result.language,
    langSrc: result.decision.languageSource,
    route: result.decision.route,
    frame: result.decision.frame || null,
    steps: result.decision.steps || 0,
    tools: result.invoked.map((t) => t.tool),
    wrote: result.wrote || false,
    biometric: result.usedBiometrics || false,
    gate: result.decision.writeGate || null,
    grounding: result.decision.grounding || null,
    rewritten: result.decision.rewritten || null,
    injection: result.decision.injection || 0,
    send: sent.ok ? (sent.via || 'text') : 'fail:' + sent.kind,
    lock: lock.held ? 'held' : (lock.contended ? 'contended' : 'degraded')
  }));
}

/**
 * A frame with three or fewer options is worth sending as tap buttons: an officer
 * with one hand on a torch should not have to open a keyboard to type "2". More
 * than three exceeds Meta's cap, and the numbered text the frame already renders
 * handles those.
 */
function pendingInteractive(pending, body) {
  const frame = frames.getFrame(pending);
  if (!frame || !Array.isArray(frame.options) || frame.options.length < 2 || frame.options.length > 3) return null;
  return {
    body: body || frame.prompt,
    buttons: frame.options.map((o, i) => ({ id: 'pick:' + (i + 1), title: o.label }))
  };
}

/**
 * Turn a message into what the agent consumes: text plus, optionally, an image.
 * This is where voice notes, locations, taps and documents become text.
 */
async function buildTurn(app, officer, event, pending, language) {
  const m = pack(language || officer.language);
  const turn = { text: event.text || '', imageCaption: event.caption || '', image: null };

  // An interactive tap. Routed on its id, never its title: a localized title
  // changes with the officer's language and would break their own buttons.
  if (event.replyId) {
    const frame = frames.getFrame(pending);
    const promptId = frame && frame.context && frame.context.promptMsgId;
    if (promptId && event.contextMsgId && event.contextMsgId !== promptId) {
      // A tap on a question we have since moved past. Acting on it would resolve
      // the wrong frame with the officer's old intent.
      return { refusal: m.tapStale };
    }
    const pick = String(event.replyId).match(/^pick:(\d{1,2})$/);
    turn.text = pick ? pick[1] : String(event.replyId);
    return turn;
  }

  if (event.location) {
    const near = nearestDistrict(event.location.lat, event.location.lng);
    turn.text = [
      turn.text,
      near ? m.locationNote(near.district + ', ' + near.state, near.km) : m.locationUnmatched
    ].filter(Boolean).join('\n');
    return turn;
  }

  if (event.type === 'audio' || event.type === 'voice') {
    if (!event.mediaId) return { refusal: m.mediaDownloadFailed };
    try {
      const media = await wa.fetchMedia(event.mediaId, { maxBytes: MEDIA_LIMIT });
      const { speechToText } = require('../voice');
      // No language hint: officers mix Kannada and English, so let it auto-detect.
      const stt = await speechToText({ buffer: media.buffer, mime: media.mime || 'audio/ogg', filename: 'voice.ogg' });
      const said = String(stt.text || '').trim();
      if (!said) return { refusal: m.voiceUnclear };
      turn.text = said;
      turn.sttLanguage = stt.language || null;
      turn.wasVoice = true;
      // Echo the transcript so the officer can see what was heard. A wrong
      // transcription that is never shown looks like the bot answering a
      // different question for no reason.
      turn.transcript = said;
      return turn;
    } catch (e) {
      if (e && e.status === 413) return { refusal: m.mediaTooLarge };
      return { refusal: m.voiceFailed };
    }
  }

  if (event.mediaId && (event.type === 'image' || event.type === 'document')) {
    const mime = String(event.mediaMime || '');
    if (!/image\/(jpeg|jpg|png|webp)/i.test(mime) && !/pdf/i.test(mime)) {
      return { refusal: m.unsupportedType(mime || null) };
    }
    try {
      const media = await wa.fetchMedia(event.mediaId, { maxBytes: MEDIA_LIMIT });
      turn.image = { buffer: media.buffer, mime: media.mime || mime };
      return turn;
    } catch (e) {
      return { refusal: e && e.status === 413 ? m.mediaTooLarge : m.mediaDownloadFailed };
    }
  }

  if (!turn.text && !turn.imageCaption) return { refusal: m.unsupportedType(event.type || null) };
  return turn;
}

/**
 * A number that is not on the roster gets a single, information-free notice, at
 * most once an hour. It must be told something — an officer awaiting registration
 * needs to know why nothing comes back — but it learns nothing about the system
 * and cannot be used to bill us for replies.
 */
async function rejectUnknown(app, phone, event) {
  await officers.logMessage(app, {
    direction: 'in', msgId: 'unauth_' + event.msgId, phone, type: 'unauthorized',
    body: String(event.text || event.caption || event.type || '').slice(0, 400), status: 'rejected'
  });
  const key = 'wa_unauth_' + phone;
  try {
    const seg = app.cache().segment();
    const seen = await seg.getValue(key);
    if (seen && (seen.cache_value || seen.value || seen)) return { rejected: true, silent: true };
    await seg.put(key, '1', 1);
  } catch (_) { /* if the cache is down, replying once more is acceptable */ }
  // Both languages: we have no idea which one this number reads, and an officer
  // waiting on registration should not have to guess why nothing comes back.
  await wa.sendText(phone, pack('en').unregistered + '\n\n' + pack('kn').unregistered);
  return { rejected: true };
}

/* ------------------------------ outbound ------------------------------ */

/**
 * Send the reply and record it.
 *
 * Interactive first when the turn offers a tappable choice, falling back to the
 * text the frame already rendered if Meta would reject the payload — the fallback
 * always fits, so there is no path where a rejected button leaves the officer
 * without the question.
 */
async function reply(app, officer, text, { language, interactive, voice, voiceText } = {}) {
  let res;
  let via = 'text';
  let promptMsgId = null;

  if (interactive) {
    const check = wa.validateButtons(interactive.body, interactive.buttons);
    if (check.valid) {
      res = await wa.sendButtons(officer.phone, interactive.body, interactive.buttons);
      if (res.ok) { via = 'buttons'; promptMsgId = res.ids[0] || null; }
    }
  }
  if (!res || !res.ok) {
    res = await wa.sendText(officer.phone, text);
    via = 'text';
    if (res.ok && interactive) promptMsgId = res.ids[0] || null;
  }

  await officers.logMessage(app, {
    direction: 'out', msgId: res.ids && res.ids[0], phone: officer.phone,
    officerId: officer.officerId, type: via, body: text,
    status: res.ok ? 'sent' : (res.kind + (res.partial ? ':partial' : ''))
  });

  // Mirror the officer's modality: a voice note usually means their hands are
  // busy. Text goes first and stays authoritative — an FIR number has to be
  // readable — and the audio is a convenience that is skipped when it would be
  // useless (a long dossier) or when the synthesis fails.
  if (voice && res.ok && process.env.WA_VOICE_REPLY !== 'off') {
    const spoken = speakable(voiceText || text);
    if (spoken && spoken.length <= 600) {
      try {
        const { textToSpeech } = require('../voice');
        const tts = await textToSpeech({ text: spoken, language: language === 'kn' ? 'kn' : 'en' });
        const audio = await wa.sendAudio(officer.phone, Buffer.from(tts.audio, 'base64'), { mime: tts.mime });
        if (audio.ok) via += '+voice';
      } catch (_) { /* the text reply already went out */ }
    }
  }

  return { ...res, via, promptMsgId };
}

/** Strip WhatsApp markup and structure that a synthesiser would read aloud badly. */
function speakable(text) {
  return String(text || '')
    .replace(/[*_~`]/g, '')
    .replace(/^\s*-\s+/gm, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ', ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

module.exports = { parseWebhook, normalizeMessage, acceptWebhook, processEvent, buildTurn, speakable, pendingInteractive };
