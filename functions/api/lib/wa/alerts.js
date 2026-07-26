'use strict';

/**
 * Proactive early-warning push to field officers' handsets.
 *
 * Driven by a Catalyst cron calling POST /whatsapp/alerts/dispatch. Reads the
 * live forecast from the predictive engine, works out who should hear about which
 * district, and pushes at most one message per officer per district per horizon
 * per severity.
 *
 * Two constraints from Meta shape the delivery:
 *
 *  - Outside the 24-hour customer service window (i.e. the officer has not messaged
 *    us today) a business-initiated message would have to be an approved template,
 *    which is billable. This deployment does not send templates at all: the alert is
 *    **deferred**, not downgraded and not dropped. The window is decided per officer
 *    from LastSeenAt.
 *
 *  - Duplicate suppression is not optional. A cron that re-sends the same 3am
 *    alert because the last run half-failed destroys trust in the channel
 *    faster than a missed alert does. Every send is keyed and checked against
 *    the WaMessages ledger before it goes out.
 *
 * Note on subscriptions: officers are opted OUT by default. An alert only goes to
 * someone who has districts on their roster row or has subscribed over WhatsApp.
 * Blanket-notifying every officer of every flagged district is how a warning
 * system becomes noise that gets muted.
 */

const wa = require('./client');
const officers = require('./officers');
const { chatLLM } = require('../llm');

const RANK = { watch: 1, elevated: 2, critical: 3 };
const SEND_CAP = () => Number(process.env.WA_ALERT_MAX_SENDS || 200);

/** Districts this officer wants: explicit subscription, else their own posting. */
function watchedDistricts(officer) {
  if (officer.alertDistricts.length) return officer.alertDistricts;
  return officer.district ? [officer.district] : [];
}

function wants(officer, alert) {
  const threshold = RANK[officer.alertSeverity] || 0;
  if (!threshold) return false; // 'none' or unrecognised -> opted out
  if ((RANK[alert.severity] || 0) < threshold) return false;
  const watched = watchedDistricts(officer);
  if (!watched.length) return false;
  return watched.some((d) => d.toLowerCase() === String(alert.district).toLowerCase()
    || String(alert.district).toLowerCase().includes(d.toLowerCase()));
}

/**
 * One AI advisory line per district, generated once and reused for every officer
 * watching that district. Per-officer generation would multiply LLM cost for
 * identical content. Falls back to a plain factual line, because an alert that
 * arrives without the advisory is still an alert.
 */
async function advisoryFor(app, alert, cache) {
  const key = alert.district + '|' + alert.severity;
  if (cache.has(key)) return cache.get(key);

  let line = `${alert.severity === 'critical' ? 'Sharp' : 'Rising'} deviation from the 12-month baseline (${alert.baseline} to ${alert.predicted}).`;
  try {
    const out = await chatLLM(app, {
      messages: [
        {
          role: 'system',
          content: 'You brief police field supervisors. Given one district forecast signal, write ONE sentence, at most 22 words, stating what to watch and one concrete proactive step (patrol timing, visibility, coordination). No preamble, no district name, no statistics restated, no enforcement action against individuals.'
        },
        {
          role: 'user',
          content: `Severity ${alert.severity}. Predicted next month ${alert.predicted} cases against a baseline of ${alert.baseline} (${alert.trendPct >= 0 ? '+' : ''}${alert.trendPct}%, z=${alert.z}).`
        }
      ],
      maxTokens: 90
    });
    const text = String((out && out.content) || '').replace(/\s+/g, ' ').trim();
    if (text) line = text.slice(0, 240);
  } catch (_) { /* keep the factual fallback */ }

  cache.set(key, line);
  return line;
}

function freeFormBody(alert, advisory, horizon) {
  return [
    `*${alert.severity.toUpperCase()} — ${alert.district}*`,
    `Forecast for ${horizon}: *${alert.predicted}* cases vs baseline ${alert.baseline} (${alert.trendPct >= 0 ? '+' : ''}${alert.trendPct}%, z=${alert.z}).`,
    advisory,
    '',
    '_Decision support for deployment planning only — not grounds for action against any individual. Reply for detail, or send "alerts off" to unsubscribe._'
  ].join('\n');
}

/**
 * Run one dispatch cycle.
 * @param {boolean} opts.dryRun  compute and report without sending
 * @param {string}  opts.only    restrict to a single officer's phone (see flushAlertsFor)
 */
async function dispatchAlerts(app, { dryRun = false, only = null } = {}) {
  const engine = require('../backtest');
  // Read the batch-scored snapshot rather than recomputing. Recomputing the national panel here
  // exceeds ZCQL's processing ceiling past ~1M rows in Cases, and even where it succeeds an
  // officer's push has to say the same thing the dashboard says.
  const ew = await engine.earlyWarningPreferSnapshot(app);
  if (ew.error) return { error: ew.error };

  const alerts = (ew.alerts || []).filter((a) => RANK[a.severity]);
  const wanted = only ? officers.normalizePhone(only) : null;
  const roster = (await officers.alertRecipients(app))
    .filter((o) => !wanted || o.phone === wanted);
  const report = {
    horizon: ew.horizon, alerts: alerts.length, officers: roster.length,
    sent: 0, skippedDuplicate: 0, skippedUnsubscribed: 0, deferredWindowClosed: 0, failed: 0,
    detail: [], dryRun
  };

  const advisoryCache = new Map();

  for (const officer of roster) {
    const matches = alerts.filter((a) => wants(officer, a));
    if (!matches.length) { report.skippedUnsubscribed++; continue; }

    const inWindow = officers.withinServiceWindow(officer);

    for (const alert of matches.slice(0, 3)) { // never more than 3 pushes per officer per cycle
      const key = `alert_${officer.officerId || officer.phone}_${alert.district}_${ew.horizon}_${alert.severity}`.replace(/\s+/g, '_');
      if (await officers.alertAlreadySent(app, key)) { report.skippedDuplicate++; continue; }

      // Window shut: hold the alert, do not downgrade it and do not mark it done.
      //
      // Checked before the advisory so a deferred alert costs no model call. Nothing
      // is written to the ledger either, which is the whole point — the dedupe key
      // stays unclaimed so the next cycle after the officer messages us delivers it.
      // Writing a "blocked" row here would silently retire a genuine warning.
      if (!inWindow) {
        report.deferredWindowClosed++;
        report.detail.push({
          phone: officer.phone, district: alert.district, severity: alert.severity,
          deferred: 'outside the 24h service window; will send once the officer messages'
        });
        continue;
      }

      const advisory = await advisoryFor(app, alert, advisoryCache);
      if (dryRun) {
        report.detail.push({ phone: officer.phone, district: alert.district, severity: alert.severity, via: 'free-form', advisory });
        continue;
      }

      const res = await wa.sendText(officer.phone, freeFormBody(alert, advisory, ew.horizon));

      if (res.ok) {
        // Write the ledger row under the dedupe key, so this exact alert can never
        // be sent to this officer twice.
        await officers.logMessage(app, {
          direction: 'alert', msgId: key, phone: officer.phone, officerId: officer.officerId,
          type: 'alert-text',
          body: `${alert.severity} ${alert.district} ${alert.predicted} vs ${alert.baseline} :: ${advisory}`,
          status: 'sent'
        });
        report.sent++;
      } else {
        report.failed++;
        report.detail.push({ phone: officer.phone, district: alert.district, error: res.kind + ': ' + res.message });
        // Nothing is recorded on failure, including a window Meta says is shut while
        // LastSeenAt said otherwise — its clock is the one that counts, and the alert
        // simply has not been delivered yet. A ledger row here would claim the dedupe
        // key and retire a warning that never arrived.
        if (res.kind === 'windowClosed') report.deferredWindowClosed++;
      }
      if (report.sent >= SEND_CAP()) {
        report.detail.push({ note: `send cap ${SEND_CAP()} reached; remaining alerts deferred to the next cycle` });
        return report;
      }
    }
  }
  return report;
}

/**
 * Deliver whatever this one officer is still owed, now that they are demonstrably
 * reachable.
 *
 * This is what makes free-form-only alerting actually work. A cron can only reach an
 * officer whose 24-hour window happens to be open when it fires; everyone else is
 * deferred to a later cycle, and with a daily cron that can mean waiting until tomorrow
 * morning for a warning that was ready today. But an officer who has just messaged us
 * has, by definition, an open window — so the cheapest reliable trigger is the officer
 * themselves.
 *
 * Called after a turn is complete, so it costs the officer nothing: their reply has
 * already been sent. Dedupe is unchanged, so an alert delivered by the cron is not
 * repeated here and vice versa.
 */
async function flushAlertsFor(app, officer) {
  if (!officer || !officer.phone) return { sent: 0 };
  return dispatchAlerts(app, { only: officer.phone });
}

module.exports = { dispatchAlerts, flushAlertsFor, wants, watchedDistricts, freeFormBody };
