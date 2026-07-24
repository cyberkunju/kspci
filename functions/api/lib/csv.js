'use strict';

/**
 * Minimal RFC-4180 CSV parser (handles quoted fields, commas, newlines, escaped quotes).
 * Returns array of objects keyed by the header row.
 */
function parseCsv(text) {
  const rows = [];
  let field = '';
  let record = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      record.push(field); field = '';
    } else if (c === '\n') {
      record.push(field); rows.push(record); field = ''; record = [];
    } else if (c === '\r') {
      // ignore; handled by \n
    } else field += c;
  }
  if (field.length || record.length) { record.push(field); rows.push(record); }

  if (!rows.length) return [];
  const header = rows[0];
  return rows.slice(1)
    .filter((r) => r.length && !(r.length === 1 && r[0] === ''))
    .map((r) => Object.fromEntries(header.map((h, idx) => [h, r[idx] ?? ''])));
}

module.exports = { parseCsv };
