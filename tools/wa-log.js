'use strict';

/**
 * Print the recent WhatsApp turns for one officer, newest last.
 *
 * `status` rows — Meta's delivery receipts — are filtered out by default, because there
 * are three of them per outbound message and they bury the conversation. Pass `--all` to
 * see them.
 *
 *   node tools/wa-log.js                       # last 12 turns, any officer
 *   node tools/wa-log.js 918330040958 20       # one officer, more history
 *   node tools/wa-log.js 918330040958 20 --full  # untruncated bodies
 *
 * Reads through /admin/zcql with the admin key from the gitignored
 * functions/api/catalyst-config.json.
 */

const path = require('node:path');

const CONFIG = path.join(__dirname, '..', 'functions', 'api', 'catalyst-config.json');
const BASE = String(process.env.KSP_API || 'https://ksp.cyberkunju.com/server/api');

function adminKey() {
  const raw = require(CONFIG);
  const vars = (raw.deployment && raw.deployment.env_variables) || raw.env_variables || raw;
  if (!vars.ADMIN_KEY) throw new Error(`${CONFIG} has no ADMIN_KEY`);
  return vars.ADMIN_KEY;
}

async function zcql(query) {
  const res = await fetch(BASE + '/admin/zcql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey() },
    body: JSON.stringify({ query })
  });
  const body = await res.json();
  if (!res.ok || body.error) {
    throw new Error(`${res.status} ${body.message || body.error || 'query failed'}`);
  }
  // ZCQL nests each row under its table name.
  return (body.rows || []).map((r) => Object.assign({}, ...Object.values(r)));
}

async function main() {
  const argv = process.argv.slice(2);
  const full = argv.includes('--full');
  const all = argv.includes('--all');
  const rest = argv.filter((a) => !a.startsWith('--'));
  const phone = rest[0] && /^\d{10,15}$/.test(rest[0]) ? rest[0] : '';
  const limit = Number(rest[phone ? 1 : 0] || 12);

  // Over-fetch when receipts are being hidden. Meta sends up to three per outbound
  // message, so a small limit can be filled entirely by receipts and show nothing at
  // all — hence the floor rather than a bare multiplier.
  const where = phone ? ` WHERE Phone='${phone.replace(/'/g, '')}'` : '';
  const fetchRows = all ? limit : Math.min(Math.max(limit * 4, 40), 200);
  const rows = await zcql(
    'SELECT CREATEDTIME, Phone, Direction, MsgType, Status, Body FROM WaMessages'
    + `${where} ORDER BY CREATEDTIME DESC LIMIT ${fetchRows}`);

  const turns = rows.filter((r) => all || r.Direction !== 'status').slice(0, limit).reverse();
  if (!turns.length) {
    console.log('no turns found');
    return;
  }
  for (const t of turns) {
    const arrow = t.Direction === 'in' ? '→' : t.Direction === 'out' ? '←' : '·';
    const tag = t.MsgType && t.MsgType !== 'text' ? ` [${t.MsgType}]` : '';
    const body = String(t.Body == null ? '' : t.Body);
    console.log(`\n${t.CREATEDTIME}  ${arrow} ${t.Phone}${tag}`
      + (t.Status ? `  (${t.Status})` : ''));
    console.log(full ? body : body.slice(0, 700) + (body.length > 700 ? ' …' : ''));
  }
}

main().catch((e) => {
  console.error(String((e && e.message) || e));
  process.exit(1);
});
