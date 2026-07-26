'use strict';

/**
 * Per-turn language resolution for the field channel.
 *
 * The failure this exists to prevent: an officer writes Kannada, the bot answers
 * English. That single defect is what makes a bilingual tool feel foreign, and
 * it is not fixed by a preference column — officers switch language mid-thread
 * ("ಈ ಪ್ರಕರಣದ ಸ್ಥಿತಿ ಏನು" then "status of FIR 4021/2026"), so the language must be
 * decided per turn, not per officer.
 *
 * Three layers, in order of trust:
 *
 *  1. SCRIPT. Any Kannada codepoint is decisive. Nothing overrides it.
 *  2. LEXICON. Romanized Kannada function words ("yaaru", "elli", "beku").
 *     Officers type these on an English keyboard constantly.
 *  3. MORPHOLOGY. Kannada case/verb suffixes on unknown words ("mysurinalli",
 *     "kodbeku"). This layer DETECTS but is deliberately not counted toward the
 *     per-officer prior, because suffix matching also fires on English words and
 *     a poisoned prior is far more damaging than one wrongly-detected turn.
 *
 * And two guards that decide who wins when layers disagree:
 *
 *  - FAIL TOWARD THE OFFICER. When the turn itself is inconclusive, lean on a
 *    decaying prior of the officer's recent turns rather than defaulting to
 *    English. Defaulting to English is the cardinal sin; being wrong in the
 *    officer's own language is a nuisance.
 *  - REVERSE GUARD. A prior must never drag an obviously English turn into
 *    Kannada. "any history on Suresh Kumar" from a Kannada-leaning officer is
 *    English, full stop. That requires the prior to be beatable by clear
 *    English evidence, which is what ENGLISH_MARKERS does.
 */

/** Kannada block. One codepoint from here settles the turn. */
const KANNADA_SCRIPT = /[\u0C80-\u0CFF]/;

/**
 * Romanized Kannada function words, verbs and question words — the tokens that
 * carry grammar rather than content. Content words are excluded on purpose: a
 * place name or a person's name says nothing about the language of the sentence,
 * and "Mysuru" appears in English requests constantly.
 */
const KN_LEXICON = new Set([
  // question words
  'yaaru', 'yaru', 'yenu', 'enu', 'yen', 'elli', 'ellidhe', 'yavaga', 'yavudu', 'yavaru',
  'hege', 'eshtu', 'estu', 'yake', 'yaake', 'yarige', 'yarna', 'yavaganda',
  // copula / existence
  'ide', 'idhe', 'ideya', 'idheya', 'illa', 'illave', 'ilva', 'ittu', 'itu', 'iddare', 'iddaru',
  'agide', 'aagide', 'aytu', 'aaytu', 'aagilla', 'aagbeku',
  // modality / request
  'beku', 'bekagide', 'bekagitthu', 'beda', 'madi', 'maadi', 'kodu', 'kodi', 'kotti',
  'nodi', 'noodi', 'heli', 'helu', 'kalisi', 'kalsi', 'thogo', 'togo', 'barsi', 'baralla',
  // common verbs / adverbs
  // Deliberately absent: 'gotta' (English "you gotta check"), 'togo' (Togo),
  // 'matte' (matte finish), 'bedi' (a common Indian surname). Each one is a
  // real English or proper-noun collision, and one false Kannada detection is
  // worse than one missed romanized word.
  'gottilla', 'gothilla', 'sari', 'saria', 'tappu', 'hogi', 'hogu', 'bandide',
  'bantu', 'sikkide', 'sikkilla', 'tegedu', 'nodbeku', 'kelu', 'keli', 'helbeku',
  // pronouns / determiners / connectives
  'nanu', 'naanu', 'navu', 'neevu', 'nivu', 'avanu', 'avaru', 'ivanu', 'idu', 'adu', 'adhu',
  'yella', 'ella', 'ellaru', 'swalpa', 'jasti', 'kammi', 'mattu', 'adare', 'aadare',
  'yaake', 'andre', 'anta', 'antha', 'alli', 'illi', 'ega', 'eega', 'nintre', 'yavdu',
  // policing register that officers romanize
  'prakarana', 'aparadha', 'dhaklu', 'tanikhe', 'sthiti', 'vivara', 'hesaru', 'jille', 'jilla'
]);

/**
 * Strong English evidence. These are function words that a Kannada sentence has
 * no reason to contain, so their presence is what lets an English turn beat a
 * Kannada-leaning prior.
 *
 * Function words only. Domain nouns are deliberately excluded even though they
 * are always written in English — "district", "case", "FIR" and "section" appear
 * inside Kannada sentences by design (see copy.js), so counting them as English
 * evidence would flip genuine Kannada turns.
 */
const ENGLISH_MARKERS = new Set([
  'the', 'is', 'are', 'was', 'were', 'has', 'have', 'had', 'do', 'does', 'did', 'be', 'been',
  'what', 'who', 'whose', 'where', 'when', 'why', 'how', 'which',
  'show', 'give', 'send', 'check', 'find', 'get', 'tell', 'need', 'want', 'pull',
  'any', 'all', 'this', 'that', 'these', 'those', 'and', 'or', 'but', 'not',
  'on', 'in', 'of', 'for', 'with', 'from', 'about', 'against', 'please',
  'to', 'at', 'by', 'as', 'it', 'its', 'into', 'over', 'under', 'after', 'before',
  'can', 'could', 'will', 'would', 'should', 'may', 'must', 'than', 'then', 'there', 'here',
  'status', 'history', 'details', 'record', 'records', 'previous', 'prior', 'last',
  'me', 'my', 'his', 'her', 'their', 'him', 'them', 'you', 'your'
]);

/**
 * Kannada agglutinative suffixes, applied only to tokens of 6+ characters.
 *
 * Deliberately absent: '-ige'. English has too many six-letter-plus words ending
 * that way — privilege, prestige, oblige, vestige — and "privilege" turns up in
 * legal prose, which is exactly the wrong place to guess Kannada.
 */
const KN_SUFFIXES = [
  'alli', 'inda', 'annu', 'avaru', 'avanu', 'agide',
  'beku', 'bekagide', 'ilva', 'ideya', 'ttide', 'thide', 'uttide'
];

/**
 * Tokens that are neither numbers, identifiers, nor police shorthand — i.e. the
 * words that actually carry the language of a sentence. FIR numbers, CrimeNos,
 * vehicle plates and bare digits are language-neutral and must not be counted;
 * "FIR 4021/2026" is not evidence of English.
 */
function proseTokens(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z\u0C80-\u0CFF]+/)
    .filter((t) => t.length >= 2 && !NEUTRAL.has(t));
}

const NEUTRAL = new Set([
  'fir', 'crimeno', 'crime', 'no', 'ocr', 'ipc', 'bns', 'ndps', 'pocso',
  'ps', 'psi', 'si', 'sho', 'dysp', 'sp', 'ig', 'dgp', 'ka', 'ok', 'okay',
  'hi', 'hello', 'thanks', 'ty', 'pls', 'plz', 'sir', 'madam', 'yes', 'no'
]);

/**
 * Analyse one message body.
 * Returns { language, source, confidence, signals } where language may be null
 * when the turn carries no usable evidence either way (a bare FIR number, a
 * one-word "ok", an empty photo caption).
 */
function analyzeLanguage(text) {
  const body = String(text == null ? '' : text);
  const signals = { script: false, lexicon: 0, morphology: 0, english: 0, prose: 0 };

  if (!body.trim()) return { language: null, source: 'empty', confidence: 0, signals };

  if (KANNADA_SCRIPT.test(body)) {
    signals.script = true;
    return { language: 'kn', source: 'script', confidence: 1, signals };
  }

  const tokens = proseTokens(body);
  signals.prose = tokens.length;

  for (const t of tokens) {
    if (KN_LEXICON.has(t)) signals.lexicon++;
    else if (ENGLISH_MARKERS.has(t)) signals.english++;
    else if (t.length >= 6 && KN_SUFFIXES.some((s) => t.endsWith(s))) signals.morphology++;
  }

  // Lexicon evidence with no competing English function words is conclusive.
  if (signals.lexicon >= 1 && signals.lexicon >= signals.english) {
    return { language: 'kn', source: 'lexicon', confidence: signals.lexicon >= 2 ? 0.9 : 0.7, signals };
  }

  // Morphology is recall, not proof. It needs TWO suffix hits in a genuine
  // sentence and no English function words at all. One hit was enough to make
  // "privilege granted here" read as Kannada, which is the kind of confident
  // wrongness that is worse than saying nothing.
  if (signals.morphology >= 2 && signals.english === 0 && signals.prose >= 3) {
    return { language: 'kn', source: 'morphology', confidence: 0.55, signals };
  }

  // Two markers, not one. A single English function word inside an otherwise
  // romanized-Kannada message ("mysuru district nalli enide") is normal
  // code-mixing, and calling that English is the cardinal sin in miniature.
  if (signals.english >= 2) {
    return { language: 'en', source: 'markers', confidence: 0.9, signals };
  }

  return { language: null, source: 'inconclusive', confidence: 0, signals };
}

/* ------------------------------ per-officer prior ------------------------------ */

const PRIOR_WINDOW = 12;

/**
 * The officer's recent language mix, most recent first. Only turns whose
 * language was established by SCRIPT or LEXICON are recorded — morphology is
 * recall-oriented and would poison the prior with false Kannada.
 */
function updatePrior(prior, analysis) {
  const list = Array.isArray(prior) ? prior.filter((x) => x === 'kn' || x === 'en') : [];
  if (!analysis || !analysis.language) return list.slice(0, PRIOR_WINDOW);
  if (analysis.source !== 'script' && analysis.source !== 'lexicon' && analysis.source !== 'markers') {
    return list.slice(0, PRIOR_WINDOW);
  }
  return [analysis.language, ...list].slice(0, PRIOR_WINDOW);
}

/**
 * Decaying vote over the prior. Recent turns count more, so an officer who has
 * just switched to English is not dragged back by yesterday's Kannada.
 */
function priorLean(prior) {
  const list = Array.isArray(prior) ? prior : [];
  let kn = 0;
  let en = 0;
  for (let i = 0; i < list.length && i < PRIOR_WINDOW; i++) {
    const w = 1 / (1 + i * 0.35);
    if (list[i] === 'kn') kn += w;
    else if (list[i] === 'en') en += w;
  }
  const total = kn + en;
  if (!total) return { language: null, strength: 0 };
  return kn > en
    ? { language: 'kn', strength: kn / total }
    : { language: 'en', strength: en / total };
}

/**
 * Decide the language for this turn, and the prior to persist.
 *
 * @param {object}   o
 * @param {string}   o.text        the officer's message (already transcribed if voice)
 * @param {string}   o.sttLanguage language the speech engine reported, if any
 * @param {string[]} o.prior       the officer's recent turn languages, newest first
 * @param {string}   o.preference  the officer's roster Language column
 */
function resolveLanguage({ text, sttLanguage, prior, preference } = {}) {
  const analysis = analyzeLanguage(text);
  const nextPrior = updatePrior(prior, analysis);

  if (analysis.language) {
    return { language: analysis.language, source: analysis.source, analysis, prior: nextPrior };
  }

  // A voice note transcribed as Kannada is direct evidence even when the
  // romanized transcript reads as neutral.
  if (String(sttLanguage || '').toLowerCase().startsWith('kn')) {
    return { language: 'kn', source: 'stt', analysis, prior: ['kn', ...nextPrior].slice(0, PRIOR_WINDOW) };
  }

  // Inconclusive turn: fail toward the officer, not toward English.
  const lean = priorLean(nextPrior);
  if (lean.language && lean.strength >= 0.6) {
    return { language: lean.language, source: 'prior', analysis, prior: nextPrior };
  }

  const pref = String(preference || 'en').toLowerCase() === 'kn' ? 'kn' : 'en';
  return { language: pref, source: 'preference', analysis, prior: nextPrior };
}

module.exports = {
  analyzeLanguage, resolveLanguage, updatePrior, priorLean, proseTokens,
  PRIOR_WINDOW, KN_LEXICON, ENGLISH_MARKERS
};
