'use strict';

/**
 * Deliver a synthetic-but-genuine inbound WhatsApp webhook to the deployed function.
 *
 * The point is that it is genuine where it matters: the payload has Meta's exact shape
 * and carries a real `X-Hub-Signature-256` computed with the app secret, so the request
 * goes through signature verification, the job pool, the agent, the tool gate, grounding
 * and the outbound send. The only thing faked is that Meta did not originate it — which
 * means the officer's handset really does receive the reply.
 *
 * This exists because every channel test up to now was an ad-hoc shell one-liner
 * reconstructing the HMAC from memory, and getting that wrong presents as a 401 that
 * looks like a code defect.
 *
 *   node tools/wa-send.js 918330040958 "status of FIR 118/2023"
 *   node tools/wa-send.js 918330040958 --button "English"       # a tap, not typed text
 *
 * Credentials come from the gitignored functions/api/catalyst-config.json, so nothing
 * secret is passed on a command line or stored here.
 */

const crypto = require('node:crypto');
const path = require('node:path');

const CONFIG = path.join(__dirname, '..', 'functions', 'api', 'catalyst-config.json');

function env() {
  const raw = require(CONFIG);
  const vars = (raw.deployment && raw.deployment.env_variables) || raw.env_variables || raw;
  const missing = ['WA_APP_SECRET', 'WA_PHONE_NUMBER_ID'].filter((k) => !vars[k]);
  if (missing.length) {
    throw new Error(`${CONFIG} is missing ${missing.join(', ')}`);
  }
  return vars;
}

function usage() {
  console.error('usage: node tools/wa-send.js <phone> [--button] <text>');
  process.exit(2);
}

async function main() {
  const argv = process.argv.slice(2);
  const isButton = argv.includes('--button');
  const rest = argv.filter((a) => a !== '--button');
  const [phone, ...words] = rest;
  const text = words.join(' ');
  if (!phone || !text) usage();

  const vars = env();
  const url = String(process.env.WA_WEBHOOK_URL
    || 'https://ksp.cyberkunju.com/server/api/whatsapp/webhook');

  // Meta's own shape. `entry[0].id` is the WABA id, which the function captures on any
  // callback because a system-user token cannot fetch it (see lib/wa/inbound.js).
  const wamid = 'wamid.TEST' + crypto.randomBytes(9).toString('hex').toUpperCase();
  const message = isButton
    ? {
      from: phone, id: wamid, timestamp: String(Math.floor(Date.now() / 1000)),
      type: 'interactive',
      interactive: { type: 'button_reply', button_reply: { id: 'opt_1', title: text } }
    }
    : {
      from: phone, id: wamid, timestamp: String(Math.floor(Date.now() / 1000)),
      type: 'text', text: { body: text }
    };

  const payload = {
    object: 'whatsapp_business_account',
    entry: [{
      id: vars.WA_WABA_ID || '2306127019919794',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '919400245958',
                      phone_number_id: vars.WA_PHONE_NUMBER_ID },
          contacts: [{ profile: { name: 'Field Test' }, wa_id: phone }],
          messages: [message]
        }
      }]
    }]
  };

  const body = JSON.stringify(payload);
  const signature = 'sha256=' + crypto
    .createHmac('sha256', vars.WA_APP_SECRET).update(body).digest('hex');

  const started = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature },
    body
  });
  const out = await res.text();
  console.log(`${res.status} in ${Date.now() - started}ms  wamid=${wamid}`);
  console.log(out.slice(0, 800));
  // Meta treats anything but 2xx as a delivery failure and retries, so a non-2xx here is
  // a real defect even though the officer may still have received a reply.
  if (!res.ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error(String((e && e.message) || e));
  process.exit(1);
});
