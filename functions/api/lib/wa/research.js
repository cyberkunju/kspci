'use strict';

/**
 * Delivering a finished research run to a field officer over WhatsApp.
 *
 * This module exists because of one arithmetic problem. A standard research run takes 35
 * to 70 seconds and a deep run up to five minutes; an Advanced I/O function is killed at
 * 30. There is no way to answer inside the turn that asked, and the previous answer to
 * that — a cut-down `quick` mode reading eight pages — was answering a different question
 * from the one the officer asked.
 *
 * So the turn starts a real run and ends. The engine, which is a container with no
 * request ceiling, POSTs the finished result back to `/research/callback`, and this
 * module turns it into messages.
 *
 * Two constraints shape the formatting:
 *
 *   * WhatsApp caps a text message at 4096 characters, and a research result is far
 *     larger than that. So the officer gets a summary message and a sources message,
 *     chunked by the client's own splitter, rather than one truncated wall.
 *   * Delivery may arrive outside Meta's 24-hour service window if the officer sent
 *     nothing since. That is checked, and an undeliverable result is recorded rather
 *     than thrown away silently — the desk UI still has it.
 */

const client = require('./client');
const officers = require('./officers');
const lang = require('./lang');
const { messages } = require('./copy');

//: How many sources to name in the message. The full list is in the exported report; a
//: phone is for the answer, not the appendix.
const MAX_LINKS = 6;

/**
 * Where the engine should POST a finished run.
 *
 * `RESEARCH_CALLBACK_URL` when set. Otherwise derived from `WA_PROCESS_URL`, which every
 * deployment with the WhatsApp channel already has: the two routes live in the same
 * function, so the host is necessarily the same one, and asking an operator to configure
 * the same origin twice is how the two drift apart.
 *
 * Returns '' when neither is available. The caller must treat that as "cannot run
 * research on this channel" rather than starting a run whose result has nowhere to go —
 * a run nobody receives is worse than a refusal, because the officer waits for it.
 */
function callbackUrl() {
  const explicit = String(process.env.RESEARCH_CALLBACK_URL || '').trim();
  if (explicit) return explicit;
  const process_url = String(process.env.WA_PROCESS_URL || '').trim();
  if (!process_url) return '';
  try {
    const u = new URL(process_url);
    // WA_PROCESS_URL ends in the wa-process route; the callback is a sibling under the
    // same function mount, so replace the last path segment rather than guessing a prefix.
    u.pathname = u.pathname.replace(/\/[^/]*$/, '/research/callback');
    u.search = '';
    return u.toString();
  } catch (_) {
    return '';
  }
}

/**
 * Render the result as WhatsApp messages.
 *
 * Deliberately not markdown: WhatsApp renders `*bold*` and `_italic_` and nothing else,
 * so anything richer arrives as literal asterisks.
 */
function format(result, { subject, language = 'en' } = {}) {
  // Strings come from the pack rather than from a kn/en boolean. That boolean predated
  // Hindi and silently rendered a Hindi officer's report in English — the one failure the
  // copy pack exists to prevent, in the longest message the channel sends.
  const m = messages(language);
  const r = result || {};
  const counts = r.counts || {};
  const bands = counts.by_attribution || {};
  const findings = r.findings || [];

  // The sources the summary actually cites come first, in marker order, so that "[S3]"
  // in the prose above is item S3 in the list below.
  //
  // This used to number the list 1, 2, 3 by attribution band — a second ordering, in the
  // same message, with no relation to the markers. Asked "what is the sixth source", the
  // model had "[S6]" in the summary and a "6." in the list pointing at a different
  // document, and answered confidently about the wrong one. Observed live.
  const cited = findings.filter((f) => f.marker)
    .sort((a, b) => (Number(a.marker.slice(1)) || 0) - (Number(b.marker.slice(1)) || 0));
  const rest = findings
    .filter((f) => !f.marker && (f.attribution === 'confirmed' || f.attribution === 'probable'));
  const fallback = findings.filter((f) => !f.marker && f.attribution === 'possible');
  const shown = [...cited, ...(cited.length || rest.length ? rest : fallback)]
    .slice(0, MAX_LINKS);
  // An engine older than the marker field returns none, and then the list is numbered
  // plainly as before rather than being left unlabelled.
  const labelled = shown.some((f) => f.marker);

  const head = r.summary_kind === 'no_match'
    ? m.researchHeadNoMatch(subject)
    : m.researchHead(subject);

  const stats = m.researchStats({
    candidates: counts.candidates || 0,
    readable: counts.readable || 0,
    confirmed: bands.confirmed || 0,
    probable: bands.probable || 0,
    possible: bands.possible || 0
  });

  const first = [
    head,
    '',
    (r.summary || m.researchNoSummary),
    '',
    `_${stats}${r.partial ? m.researchPartial : ''}_`
  ].join('\n');

  // Records are shown separately from sources, always. A message that blends what our
  // file says with what a newspaper says is unusable as either.
  const recordLines = (r.records || []).slice(0, 6);
  const second = shown.length || recordLines.length
    ? [
      recordLines.length
        ? m.researchRecords + '\n' + recordLines.map((x) => `• ${x}`).join('\n') + '\n'
        : '',
      shown.length ? m.researchSources : '',
      ...shown.map((f, i) => (
        `${labelled ? (f.marker || '—') : String(i + 1)}. ${f.title || f.url}\n`
        + `   ${f.outlet || ''}${f.published ? ' · ' + String(f.published).slice(0, 10) : ''}`
        + ` · ${(m.researchBand || {})[f.attribution] || f.attribution}\n`
        + `   ${f.url}`
      )),
      '',
      `_${m.researchDisclaimer}_`
    ].filter(Boolean).join('\n')
    : '';

  return [first, second].filter((s) => s && s.trim());
}

/**
 * Send a finished run to the officer who asked for it.
 *
 * Idempotent by the run id: the engine retries a failed callback once, and an officer
 * receiving the same report twice would reasonably conclude the tool is broken.
 */
async function deliver(app, { result, context = {}, error = '', runId = '' }) {
  const phone = officers.normalizePhone(context.phone || '');
  if (!phone) return { delivered: false, reason: 'no phone in callback context' };

  const dedupeKey = `research:${runId || (result && result.subject) || phone}`;
  try {
    if (await officers.alertAlreadySent(app, dedupeKey)) {
      return { delivered: false, reason: 'already delivered' };
    }
  } catch (_) { /* a dedupe lookup failure must not block the only delivery */ }

  // Three languages, resolved through the same normaliser the rest of the channel uses.
  // A hard-coded `=== 'kn' ? kn : en` silently delivered Hindi officers an English report.
  const language = lang.normalize(context.language) || 'en';
  const subject = context.subject || (result && result.subject) || 'subject';

  const parts = (error || !result)
    ? [messages(language).researchFailed(subject)]
    : format(result, { subject, language });

  // Outside Meta's 24-hour service window a free-form message is rejected. Say so rather
  // than letting the send fail opaquely; the result is not lost, it is in the desk UI.
  let inWindow = true;
  try {
    const officer = await officers.getOfficer(app, phone);
    inWindow = officer ? officers.withinServiceWindow(officer) : true;
  } catch (_) { /* assume in-window; a failed send is recorded below */ }
  if (!inWindow) {
    await record(app, dedupeKey, phone, 'rejected',
      'outside the 24-hour service window; result available in the desk workspace');
    return { delivered: false, reason: 'outside the service window' };
  }

  let sent = 0;
  const failures = [];
  for (const message of parts) {
    for (const chunk of client.chunkText(message)) {
      try {
        await client.sendText(phone, chunk, { previewUrl: false });
        sent += 1;
      } catch (e) {
        failures.push(String((e && e.message) || e).slice(0, 120));
      }
    }
  }

  if (sent) {
    // The report itself goes into the ledger as an outbound turn, not just an audit line
    // saying one was sent. It is the longest thing this channel ever tells an officer and
    // it is full of numbered sources, so "tell me more about the third link" is the
    // obvious next message — and `recentTurns` only sees `in`/`out` rows. Logged as one
    // row under the dedupe key, so it remains the record that suppresses a repeat
    // delivery as well as the context for a follow-up.
    await officers.logMessage(app, {
      msgId: dedupeKey, direction: 'out', phone, type: 'research-result',
      body: parts.join('\n\n'), status: 'sent'
    });
  } else {
    await record(app, dedupeKey, phone, 'failed',
      `research delivery failed for ${subject}: ${failures.join('; ').slice(0, 300)}`);
  }
  return { delivered: sent > 0, parts: sent, failures };
}

async function record(app, key, phone, status, body) {
  try {
    await officers.logMessage(app, {
      msgId: key, direction: 'alert', phone, type: 'research-result', body, status
    });
  } catch (_) { /* the ledger is an audit aid, not a precondition for delivery */ }
}

module.exports = { deliver, format, callbackUrl, MAX_LINKS };
