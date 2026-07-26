'use strict';

/**
 * How far the case records reach.
 *
 * The first live turn produced "No cases in Hoshiarpur this year (2026). The database
 * shows 0 records for that district in 2026." Every word is true of the table and the
 * sentence is indefensible to an officer: the records stop in June 2025, so that zero
 * is the end of the data, not the absence of crime in their district.
 *
 * Held as configuration, not measured per turn. The honest measurement is a grouped
 * aggregate over all of `Cases`, which is both the expensive kind of query at this
 * scale (see DEVELOPMENT.md §11) and pointless to repeat on a channel where the answer
 * changes only when data is loaded.
 *
 * One machine-readable value serves both uses — the prompt sentence and the numeric
 * comparison the tool layer needs — so there is no second setting to drift out of step
 * with the first.
 *
 *   DATA_WINDOW=2023-07..2025-06
 */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function parse(raw) {
  const m = String(raw || '').match(/^(\d{4})-(\d{1,2})\s*\.\.\s*(\d{4})-(\d{1,2})$/);
  if (!m) return null;
  const [, y1, m1, y2, m2] = m.map(Number);
  if (m1 < 1 || m1 > 12 || m2 < 1 || m2 > 12 || y2 < y1) return null;
  return { startYear: y1, startMonth: m1, endYear: y2, endMonth: m2 };
}

/** The configured window, or null when unset or malformed. */
function dataWindow() {
  return parse(process.env.DATA_WINDOW);
}

/** "July 2023 to June 2025" */
function prose(w = dataWindow()) {
  if (!w) return null;
  return `${MONTHS[w.startMonth - 1]} ${w.startYear} to ${MONTHS[w.endMonth - 1]} ${w.endYear}`;
}

/**
 * Years mentioned in a query that fall outside the window.
 *
 * Deliberately crude — any four-digit year-looking literal in the text. A false
 * positive costs one extra clarifying sentence in an observation the model is already
 * reading; a false negative costs the wrong answer above.
 */
function yearsOutsideWindow(text, w = dataWindow()) {
  if (!w) return [];
  const years = new Set();
  for (const m of String(text || '').matchAll(/\b(19|20)\d{2}\b/g)) {
    const y = Number(m[0]);
    if (y < w.startYear || y > w.endYear) years.add(y);
  }
  return Array.from(years);
}

/**
 * The note to attach to a query that reaches outside the covered period.
 *
 * Returned as part of the observation rather than left to the system prompt. The model
 * demonstrably reads the prompt — asked directly, it reports the coverage correctly —
 * and still answered "no cases this year" from a query for 2026. An instruction it has
 * to remember at the right moment is not a control; a note sitting in the data it is
 * reasoning over is.
 *
 * Keyed on the filter, not on whether the result looked empty. The first version tested
 * for zero rows and never fired once, because the model asked `COUNT(ROWID)` — which
 * returns one row containing zero. Row count says nothing about whether an answer is
 * substantively empty, and every aggregate in this schema has that shape.
 */
function outOfWindowNote(zcql) {
  const w = dataWindow();
  if (!w) return null;
  const outside = yearsOutsideWindow(zcql, w);
  if (!outside.length) return null;
  return `This query filtered on ${outside.join(', ')}, which the records do not cover — they run ${prose(w)}. `
    + 'Whatever it returned (including a count of zero) describes the absence of DATA, not the absence of cases. '
    + 'Do NOT report it as "no cases". Re-query inside the covered period and tell the officer which period you are reporting.';
}

module.exports = { dataWindow, prose, yearsOutsideWindow, outOfWindowNote };
