// API client for the KSP Crime AI backend (Catalyst Advanced I/O function via API Gateway).
const BASE = '/server/api';

async function req(path, { method = 'GET', body, role, userId } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (role) headers['x-user-role'] = role;
  if (userId) headers['x-user-id'] = userId;
  const res = await fetch(BASE + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
  health: () => req('/health'),
  warmup: () => req('/warmup', { method: 'POST' }).catch(() => ({ warm: false })),
  chat: ({ question, sessionId, language, role, userId }) =>
    req('/chat', { method: 'POST', role, userId, body: { question, sessionId, language } }),
  history: (sessionId, role) => req(`/chat/${sessionId}`, { role }),
  stt: ({ audio, mime, language, role }) =>
    req('/voice/stt', { method: 'POST', role, body: { audio, mime, language } }),
  tts: ({ text, language, role }) =>
    req('/voice/tts', { method: 'POST', role, body: { text, language } }),
  overview: (role) => req('/analytics/overview', { role }),
  hotspots: (role) => req('/analytics/hotspots', { role }),
  trends: (role) => req('/analytics/trends', { role }),
  network: (role, ring) => req(`/analytics/network${ring ? `?ring=${ring}` : ''}`, { role }),
  offenders: (role, band) => req(`/analytics/offenders${band ? `?band=${band}` : ''}`, { role }),
  financial: (role) => req('/analytics/financial', { role }),
  sociology: (role) => req('/analytics/sociology', { role }),
  moneytrail: (role) => req('/analytics/moneytrail', { role }),
  investigatorCase: ({ crimeNo, caseId, language, role }) =>
    req(`/investigator/case?${crimeNo ? 'crimeNo=' + encodeURIComponent(crimeNo) : 'caseId=' + (caseId || 1)}${language ? '&language=' + language : ''}`, { role }),
  forecast: (role) => req('/analytics/forecast', { role }),
  earlywarning: (role) => req('/analytics/earlywarning', { role }),
  backtest: (role) => req('/analytics/backtest', { role }),
  watchlist: (role) => req('/analytics/watchlist?limit=15', { role }),
  brief: (role, language) => req(`/analytics/brief${language ? `?language=${language}` : ''}`, { role }),
  ingestOcr: ({ fileBase64, filename, language, role }) =>
    req('/ingest/ocr', { method: 'POST', role, body: { fileBase64, filename, language, insert: true } }),
};

export const ROLES = ['investigator', 'analyst', 'supervisor', 'policymaker', 'admin'];
