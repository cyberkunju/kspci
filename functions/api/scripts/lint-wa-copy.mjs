/**
 * Guard against the one regression that quietly ruins a bilingual channel: an
 * English reply inlined at a call site instead of taken from the message pack.
 *
 * The check is deliberately narrow rather than a general banned-phrase sweep. A
 * broad scan of every string literal in lib/wa would flag the system prompt (which
 * is English on purpose, because it addresses the model) and the blank-refusal
 * DETECTORS in agent.js (which must contain the phrases they detect). Both would
 * be false positives, and a lint with false positives gets disabled.
 *
 * So it flags exactly one shape: a string literal passed as the message argument
 * to a send. That is the only way an unlocalized reply can reach an officer.
 *
 *   node scripts/lint-wa-copy.mjs
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = new URL('../lib/wa/', import.meta.url).pathname;
const EXEMPT = new Set(['copy.js']);

/**
 * A literal in the message slot of a send. Matches `sendText(x, 'literal'`,
 * `reply(a, b, 'literal'`, `sendButtons(x, "literal"`, and template literals,
 * which are just as unlocalized as a quoted string.
 */
const OFFENDERS = [
  { name: 'sendText', re: /\bsendText\s*\(\s*[^,()]+,\s*(['"`])/g },
  { name: 'sendButtons', re: /\bsendButtons\s*\(\s*[^,()]+,\s*(['"`])/g },
  { name: 'reply', re: /\breply\s*\(\s*[^,()]+,\s*[^,()]+,\s*(['"`])/g }
];

let failures = 0;

for (const file of readdirSync(DIR).filter((f) => f.endsWith('.js')).sort()) {
  if (EXEMPT.has(file)) continue;
  const source = readFileSync(join(DIR, file), 'utf8');
  const lines = source.split('\n');

  for (const { name, re } of OFFENDERS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source))) {
      const line = source.slice(0, m.index).split('\n').length;
      console.error(
        `${file}:${line}  ${name}() is passed a literal string.\n` +
        `    ${lines[line - 1].trim()}\n` +
        '    Officer-facing text must come from lib/wa/copy.js so it exists in both languages.'
      );
      failures++;
    }
  }
}

if (failures) {
  console.error(`\n${failures} unlocalized reply${failures === 1 ? '' : 's'} found.`);
  process.exit(1);
}
console.log('wa copy lint: no unlocalized officer-facing strings');
