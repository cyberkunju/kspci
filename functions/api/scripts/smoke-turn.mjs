/**
 * End-to-end trace of a real turn, with the LLM and the Data Store stubbed.
 *
 * Unit tests prove the pieces; this proves the WIRING — that ordered dispatch,
 * the tool loop, the frame lifecycle, the write gate, grounding and the
 * deterministic commands actually compose into a turn. Run manually:
 *
 *   node scripts/smoke-turn.mjs
 *
 * It touches no network and no Catalyst resource, so it is safe anywhere.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Stub the LLM before anything requires it.
const llmPath = require.resolve('../lib/llm.js');

// One stable function, because agent.js destructures chatLLM at module load — the
// reference it captures cannot be swapped afterwards. Behaviour is steered through
// the closed-over `script` and `handler` instead.
let script = [];
let handler = null;
let lastMessages = null;
require.cache[llmPath] = {
  id: llmPath,
  filename: llmPath,
  loaded: true,
  exports: {
    chatLLM: async (_app, opts) => {
      lastMessages = (opts && opts.messages) || [];
      if (handler) return handler(lastMessages);
      return { content: script.shift() || 'done' };
    },
    modelLabel: () => 'stub'
  }
};
const setLLM = (fn) => { handler = fn; script = []; };

const agent = require('../lib/wa/agent');
const frames = require('../lib/wa/frames');
const officers = require('../lib/wa/officers');

const writes = [];
const cache = new Map();
const app = {
  zcql: () => ({
    executeZCQLQuery: async (qy) => {
      if (/FROM Accused/i.test(qy)) return [{ Accused: { AccusedName: 'Suresh Kumar', CrimeNo: '4021/2026', CaseMasterID: 7, DistrictName: 'Mysuru' } }];
      if (/FROM Cases/i.test(qy)) return [{ Cases: { CaseMasterID: 7, CrimeNo: '4021/2026', CaseStatus: 'Under Investigation', DistrictName: 'Mysuru' } }];
      if (/COUNT\(ROWID\)/i.test(qy)) return [{ 'COUNT(ROWID)': 0 }];
      return [];
    }
  }),
  datastore: () => ({
    table: (t) => ({
      updateRow: async (r) => { writes.push('update ' + t); return r; },
      insertRow: async (r) => { writes.push('insert ' + t); return r; }
    })
  }),
  cache: () => ({
    segment: () => ({
      getValue: async (k) => cache.get(k),
      put: async (k, v) => cache.set(k, v),
      delete: async (k) => cache.delete(k)
    })
  })
};

const officer = {
  officerId: 'off_1', rowId: '51589000000013024', phone: '919845012345',
  name: 'Suresh Rao', rank: 'PSI', role: 'investigator', state: 'Karnataka',
  district: 'Mysuru', station: 'Devaraja', language: 'en', active: true,
  alertDistricts: [], alertSeverity: 'critical'
};

let failures = 0;
function check(label, condition, detail) {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`);
  if (!condition) failures++;
}

// 1. A plain lookup: one tool call, then prose.
script = [
  '```act\n{"tool":"person_history","name":"Suresh Kumar"}\n```',
  'Suresh Kumar has 1 case in Mysuru — FIR 4021/2026, under investigation.'
];
let r = await agent.handleTurn(app, { officer, pending: {}, turn: { text: 'any history on Suresh Kumar' } });
check('lookup runs the tool and answers in English',
  r.decision.route === 'agent' && r.language === 'en' && r.invoked[0].tool === 'person_history',
  `tools=${r.invoked.map((t) => t.tool).join(',')}`);
check('an FIR the tool returned passes grounding', !r.decision.grounding, r.decision.grounding || 'clean');

// 2. Kannada in, Kannada out.
script = ['ಸುರೇಶ್ ಕುಮಾರ್ ವಿರುದ್ಧ 1 ಪ್ರಕರಣ ಇದೆ.'];
r = await agent.handleTurn(app, { officer, pending: {}, turn: { text: 'ಸುರೇಶ್ ಕುಮಾರ್ history ಇದೆಯಾ' } });
check('Kannada in is answered in Kannada', r.language === 'kn', 'source=' + r.decision.languageSource);

// 3. ask_choice opens a frame; the next turn resolves it into a full request.
script = ['```act\n{"tool":"ask_choice","question":"Which Suresh Kumar?","options":[{"label":"Mysuru","resolve":"history for Suresh Kumar in Mysuru"},{"label":"Ballari","resolve":"history for Suresh Kumar in Ballari"}]}\n```'];
r = await agent.handleTurn(app, { officer, pending: {}, turn: { text: 'history on Suresh' } });
check('ask_choice opens a frame and asks the question',
  Boolean(frames.getFrame(r.pending)) && r.reply.includes('Which Suresh Kumar?'));

setLLM(async () => ({ content: 'Nothing on record in Ballari.' }));
r = await agent.handleTurn(app, { officer, pending: r.pending, turn: { text: '2' } });
const seen = lastMessages[lastMessages.length - 1].content;
check('"2" resolves into the option\'s full request',
  seen === 'history for Suresh Kumar in Ballari' && frames.getFrame(r.pending) === null,
  `agent saw ${JSON.stringify(seen)}`);

// 4. A negated write must not enrol, even when the model tries.
setLLM(async () => ({ content: '```act\n{"tool":"enroll_photo","name":"Suresh Kumar"}\n```' }));
r = await agent.handleTurn(app, {
  officer,
  pending: {},
  turn: { text: '', imageCaption: "don't save this photo as Suresh Kumar", image: { buffer: Buffer.from('x'), mime: 'image/jpeg' } }
});
check('a negated caption blocks the write and audits the denial',
  r.decision.writeGate === 'negated' && r.wrote === false && r.invoked.some((t) => String(t.denied).startsWith('write_gate')),
  `denied=${r.invoked.map((t) => t.denied).join(',')}`);
check('a model that re-attempts a denied action is cut off, not left to burn the budget',
  r.invoked.length <= 3, `attempts=${r.invoked.length}`);

// 5. A fabricated FIR with no tool data behind it is refused.
setLLM(async () => ({ content: 'FIR 9999/2026 was closed in March.' }));
r = await agent.handleTurn(app, { officer, pending: {}, turn: { text: 'anything recent' } });
check('an ungrounded FIR is refused, not shown',
  String(r.decision.grounding || '').startsWith('refused') && !r.reply.includes('9999'),
  r.decision.grounding);

// 6. The deterministic paths survive a dead model.
setLLM(async () => { throw new Error('model down'); });
r = await agent.handleTurn(app, { officer, pending: {}, turn: { text: 'help' } });
check('help works with the model down', r.decision.route === 'help' && r.reply.length > 50);
r = await agent.handleTurn(app, { officer, pending: {}, turn: { text: 'stop' } });
check('opt-out works with the model down', r.decision.route === 'optout' && r.wrote === true);
r = await agent.handleTurn(app, { officer, pending: {}, turn: { text: 'status of FIR 4021/2026' } });
check('a dead model produces an error, never silence',
  r.decision.route === 'agent' && r.reply.length > 20, JSON.stringify(r.reply.slice(0, 40)));

// 7. Undo round trip.
const pending = {};
const token = officers.recordUndo(pending, {
  action: 'undo_alerts', payload: { districts: 'Mysuru', severity: 'critical' }, describe: 'the alert subscription change'
});
r = await agent.handleTurn(app, { officer, pending, turn: { text: 'undo ' + token } });
check('an undo code reverses without touching the model',
  r.decision.route === 'undo' && officers.findUndo(r.pending, token).used === true,
  JSON.stringify(r.reply));

console.log(`\nData Store writes during the trace: ${writes.join(', ') || '(none)'}`);
if (failures) {
  console.error(`\n${failures} smoke check${failures === 1 ? '' : 's'} failed`);
  process.exit(1);
}
console.log('all smoke checks passed');
