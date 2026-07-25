'use strict';

/**
 * Speech for Indian languages — Sarvam AI.
 *
 * Catalyst/Zia has no developer speech model, so this is the one third-party
 * dependency in the stack. Extracted from index.js because the WhatsApp channel
 * needs the same transcription path for voice notes: a field officer on a bike
 * dictates far more readily than they type, and duplicating the call in two
 * places would let the two drift.
 */

const SARVAM = 'https://api.sarvam.ai';

/** Sarvam wants BCP-47; the app carries 'en' / 'kn'. */
const sarvamLang = (l) => (String(l || '').toLowerCase().startsWith('kn') ? 'kn-IN' : 'en-IN');

const timeoutMs = () => Number(process.env.SARVAM_TIMEOUT_MS || 30000);

async function call(path, { body, headers }) {
  const key = process.env.SARVAM_API_KEY || '';
  if (!key) throw new Error('SARVAM_API_KEY is not configured');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs());
  try {
    const res = await fetch(`${SARVAM}${path}`, {
      method: 'POST',
      headers: { 'api-subscription-key': key, ...(headers || {}) },
      body,
      signal: ctrl.signal
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error('sarvam ' + res.status);
      err.detail = json;
      err.status = res.status;
      throw err;
    }
    return json;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('SPEECH_TIMEOUT');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Transcribe audio. Pass no language to let Sarvam auto-detect, which is what a
 * bilingual force needs — officers switch between Kannada and English mid-sentence.
 */
async function speechToText({ buffer, mime = 'audio/webm', language, filename = 'audio.webm' }) {
  const form = new FormData();
  form.append('model', process.env.SARVAM_STT_MODEL || 'saarika:v2.5');
  form.append('language_code', language ? sarvamLang(language) : 'unknown');
  form.append('file', new Blob([buffer], { type: mime }), filename);
  const j = await call('/speech-to-text', { body: form });
  return { text: String((j && j.transcript) || ''), language: (j && j.language_code) || null };
}

async function textToSpeech({ text, language }) {
  const j = await call('/text-to-speech', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: String(text || '').slice(0, 2500),
      target_language_code: sarvamLang(language),
      speaker: process.env.SARVAM_TTS_SPEAKER || 'ritu',
      model: process.env.SARVAM_TTS_MODEL || 'bulbul:v3',
      output_audio_codec: 'mp3'
    })
  });
  const audios = j && j.audios;
  if (!Array.isArray(audios) || !audios[0]) {
    const err = new Error('tts_failed');
    err.detail = j;
    throw err;
  }
  return { audio: audios[0], mime: 'audio/mpeg' };
}

module.exports = { speechToText, textToSpeech, sarvamLang };
