// API client for the KSP Crime AI backend (Catalyst Advanced I/O function via API Gateway).
const BASE = '/server/api';

async function req(path, { method = 'GET', body, role, userId, signal } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (role) headers['x-user-role'] = role;
  if (userId) headers['x-user-id'] = userId;
  const res = await fetch(BASE + path, {
    method, headers, signal, body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.message || data.error || `Request failed (${res.status})`);
    error.status = res.status;
    error.code = data.error;
    throw error;
  }
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
  // level=district returns all 640 districts; level=state rolls up to 36 states/UTs.
  hotspots: (role, level) => req(`/analytics/hotspots${level ? `?level=${level}` : ''}`, { role }),
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
  extractOcr: ({ fileBase64, filename, language, role }) =>
    req('/ingest/ocr', { method: 'POST', role, body: { fileBase64, filename, language } }),
  confirmIngest: ({ structured, text, role }) =>
    req('/ingest/confirm', { method: 'POST', role, body: { structured, text } }),

  // Open-source research. A run outlives a single request, so it is started and
  // polled; the function proxies to the AppSail engine and supplies the anchors.
  researchHealth: (role) => req('/research/health', { role }),
  // Two modes: 'standard' (about a minute) and 'deep' (up to five). Both outlive a
  // single request, so a run is started and polled.
  researchStart: ({ subject, kind, purpose, question, mode, crimeNo, role, userId }) =>
    req('/research', { method: 'POST', role, userId, body: { subject, kind, purpose, question, mode, crimeNo } }),
  researchPoll: (id, role) => req(`/research/${encodeURIComponent(id)}`, { role }),
  researchCancel: (id, role) => req(`/research/${encodeURIComponent(id)}`, { method: 'DELETE', role }),
};

export const ROLES = ['investigator', 'analyst', 'supervisor', 'policymaker', 'admin'];
