// Voice I/O via Sarvam AI (server-side). MediaRecorder captures mic audio → /voice/stt
// (saarika); /voice/tts (bulbul) returns mp3 we play back. High-quality Kannada + English.
// (Catalyst/Zia has no speech model, so Sarvam is the one justified third party for voice.)
import { api } from '../api';

export function isRecordingSupported() {
  return typeof navigator !== 'undefined' &&
    navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function' &&
    typeof window !== 'undefined' && 'MediaRecorder' in window;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onloadend = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

/**
 * Start mic recording. Returns a controller: { stop() } which stops recording,
 * transcribes via Sarvam, and calls onText(transcript).
 * State flow via onState: 'recording' -> 'transcribing' -> 'idle'.
 */
export async function startRecording({ language, role, onText, onState, onError } = {}) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const preferred = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');
    const mr = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined);
    const chunks = [];
    mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    mr.start();
    onState && onState('recording');

    return {
      stop: () => {
        mr.onstop = async () => {
          stream.getTracks().forEach((t) => t.stop());
          onState && onState('transcribing');
          try {
            const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
            const base64 = await blobToBase64(blob);
            const { text } = await api.stt({ audio: base64, mime: (mr.mimeType || 'audio/webm').split(';')[0], language, role });
            onText && onText((text || '').trim());
          } catch (e) {
            onError && onError(e);
          } finally {
            onState && onState('idle');
          }
        };
        try { mr.stop(); } catch (_) { onState && onState('idle'); }
      }
    };
  } catch (e) {
    onError && onError(e);
    onState && onState('idle');
    return { stop: () => {} };
  }
}

let currentAudio = null;
export function stopAudio() {
  if (currentAudio) { try { currentAudio.pause(); } catch (_) {} currentAudio = null; }
}

/** Speak text via Sarvam TTS and play it. */
export async function speak({ text, language, role }) {
  if (!text || !text.trim()) return;
  try {
    const { audio, mime } = await api.tts({ text, language, role });
    stopAudio();
    currentAudio = new Audio(`data:${mime || 'audio/mpeg'};base64,${audio}`);
    currentAudio.play().catch(() => {});
  } catch (_) { /* non-fatal */ }
}
