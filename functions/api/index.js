'use strict';

/**
 * KSP Crime AI — Advanced I/O API function
 * Runs behind Catalyst API Gateway. Exposes the conversational + analytics API.
 *
 * Route map (built out across phases):
 *   GET  /                       health
 *   GET  /health                 detailed health + catalyst context
 *   POST /chat                   conversational query (RAG + text-to-ZCQL, grounded)   [Phase 1]
 *   GET  /chat/:sessionId        multi-turn history                                    [Phase 1]
 *   POST /chat/:sessionId/pdf    export conversation as PDF (SmartBrowz)               [Phase 1]
 *   POST /voice/stt              speech-to-text (Zia)                                  [Phase 1]
 *   POST /voice/tts              text-to-speech (Zia)                                  [Phase 1]
 *   GET  /network/:accusedId     criminal network graph (junction traversal)          [Phase 2]
 *   GET  /trends                 crime trend + hotspot aggregation                     [Phase 2]
 *   GET  /offender/:id/risk      AutoML risk score + factors                          [Phase 2/3]
 *   POST /ingest/ocr             scanned FIR OCR ingestion (Zia OCR)                   [Phase 3]
 */

const express = require('express');
const catalyst = require('zcatalyst-sdk-node');
const fs = require('fs');
const path = require('path');
const { parseCsv } = require('./lib/csv');
const { handleChat, runZcql } = require('./lib/chat');
const { modelLabel } = require('./lib/llm');

// datetime helper for Data Store (YYYY-MM-DD HH:mm:ss)
const dtNow = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const genId = (p) => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const app = express();
app.use(express.json({ limit: '10mb' }));

const SEED_DIR = path.join(__dirname, 'seed');
const SEED_TABLES = [
  'Cases', 'Accused', 'Victims', 'Complainants',
  'Arrests', 'CoAccusedLinks', 'OffenderRisk', 'FinancialTxns'
];

// --- Catalyst context on every request ---
app.use((req, _res, next) => {
  try {
    req.catalystApp = catalyst.initialize(req);
  } catch (e) {
    req.catalystApp = null;
  }
  next();
});

// --- RBAC roles (mapped to Catalyst Authentication user roles) ---
const ROLES = ['investigator', 'analyst', 'supervisor', 'policymaker', 'admin'];

// Placeholder role guard — wired to Catalyst Auth user role in Phase 1.
function requireRole(...allowed) {
  return (req, res, next) => {
    const role = (req.headers['x-user-role'] || 'investigator').toLowerCase();
    if (!ROLES.includes(role)) return res.status(400).json({ error: 'unknown role' });
    if (allowed.length && !allowed.includes(role)) {
      return res.status(403).json({ error: 'forbidden for role', role });
    }
    req.userRole = role;
    next();
  };
}

// --- Health ---
app.get('/', (_req, res) => res.status(200).json({ service: 'ksp-crime-ai', status: 'ok' }));

// Warm the GLM model so first real query is fast. Client pings on load + periodically.
app.post('/warmup', async (req, res) => {
  const started = Date.now();
  try {
    const { chatLLM } = require('./lib/llm');
    await chatLLM(req.catalystApp || catalyst.initialize(req), { messages: [{ role: 'user', content: 'ping' }], maxTokens: 1 });
    res.json({ warm: true, ms: Date.now() - started });
  } catch (e) {
    res.json({ warm: false, ms: Date.now() - started, note: String((e && e.message) || e) });
  }
});

// ---- Voice: Sarvam AI STT + TTS ----
// Catalyst/Zia has no speech model, so voice uses Sarvam (saarika STT + bulbul TTS),
// the one justified third-party (LLM = Zoho GLM, OCR = Zia are fully native).
const SARVAM = 'https://api.sarvam.ai';
const sarvamLang = (l) => (l === 'kn' ? 'kn-IN' : 'en-IN');

app.post('/voice/stt', requireRole(), async (req, res) => {
  try {
    const { audio, mime = 'audio/webm', language } = req.body || {};
    if (!audio) return res.status(400).json({ error: 'audio (base64) required' });
    const buf = Buffer.from(audio, 'base64');
    const form = new FormData();
    form.append('model', process.env.SARVAM_STT_MODEL || 'saarika:v2.5');
    form.append('language_code', language ? sarvamLang(language) : 'unknown');
    form.append('file', new Blob([buf], { type: mime }), 'audio.webm');
    const r = await fetch(`${SARVAM}/speech-to-text`, {
      method: 'POST',
      headers: { 'api-subscription-key': process.env.SARVAM_API_KEY || '' },
      body: form
    });
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ error: 'stt_failed', detail: j });
    res.json({ text: j.transcript || '', language: j.language_code || null });
  } catch (e) {
    res.status(500).json({ error: 'stt_error', message: String((e && e.message) || e) });
  }
});

app.post('/voice/tts', requireRole(), async (req, res) => {
  try {
    const { text, language } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });
    const r = await fetch(`${SARVAM}/text-to-speech`, {
      method: 'POST',
      headers: { 'api-subscription-key': process.env.SARVAM_API_KEY || '', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: text.slice(0, 2500),
        target_language_code: sarvamLang(language),
        speaker: process.env.SARVAM_TTS_SPEAKER || 'ritu',
        model: process.env.SARVAM_TTS_MODEL || 'bulbul:v3',
        output_audio_codec: 'mp3'
      })
    });
    const j = await r.json();
    const audios = j && j.audios;
    if (!r.ok || !Array.isArray(audios) || !audios[0]) return res.status(502).json({ error: 'tts_failed', detail: j });
    res.json({ audio: audios[0], mime: 'audio/mpeg' });
  } catch (e) {
    res.status(500).json({ error: 'tts_error', message: String((e && e.message) || e) });
  }
});

app.get('/health', (req, res) => {
  res.status(200).json({
    service: 'ksp-crime-ai',
    status: 'ok',
    catalyst: Boolean(req.catalystApp),
    time: new Date().toISOString(),
    phase: 'foundation'
  });
});

// ============================ ADMIN: SDK-based data seeder ============================
// Loads synthetic CSVs (bundled in seed/) into Data Store via the SDK — no interactive
// prompts, no 5k CLI cap workaround needed beyond dev-env limits. Batched by the caller.
function adminGuard(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// List seed tables + row counts available to load.
app.get('/admin/seed', adminGuard, (_req, res) => {
  const info = SEED_TABLES.map((t) => {
    const f = path.join(SEED_DIR, t + '.csv');
    const exists = fs.existsSync(f);
    return { table: t, rows: exists ? parseCsv(fs.readFileSync(f, 'utf8')).length : 0, exists };
  });
  res.json({ tables: info });
});

// Insert one batch of a table's seed data. Body: { table, offset=0, limit=100 }.
app.post('/admin/seed', adminGuard, async (req, res) => {
  try {
    const { table, offset = 0, limit = 100 } = req.body || {};
    if (!SEED_TABLES.includes(table)) return res.status(400).json({ error: 'unknown table', table });
    const file = path.join(SEED_DIR, table + '.csv');
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'seed file missing', table });

    const all = parseCsv(fs.readFileSync(file, 'utf8'));
    const slice = all.slice(offset, offset + limit);
    if (!slice.length) return res.json({ table, inserted: 0, offset, next: null, total: all.length });

    const adminApp = catalyst.initialize(req, { scope: 'admin' });
    const ds = adminApp.datastore();
    const t = ds.table(table);
    await t.insertRows(slice);

    const consumed = offset + slice.length;
    res.json({ table, inserted: slice.length, offset, next: consumed < all.length ? consumed : null, total: all.length });
  } catch (e) {
    res.status(500).json({ error: 'seed_failed', message: String(e && e.message || e) });
  }
});

// Insert a client-supplied batch of rows (loader parses CSV locally; no server-side
// file parsing — scales to any dataset size without per-request parse cost).
app.post('/admin/insert', adminGuard, async (req, res) => {
  try {
    const { table, rows } = req.body || {};
    if (!SEED_TABLES.includes(table)) return res.status(400).json({ error: 'unknown table', table });
    if (!Array.isArray(rows) || !rows.length) return res.json({ table, inserted: 0 });
    const adminApp = catalyst.initialize(req, { scope: 'admin' });
    await adminApp.datastore().table(table).insertRows(rows);
    res.json({ table, inserted: rows.length });
  } catch (e) {
    res.status(500).json({ error: 'insert_failed', message: String(e && e.message || e) });
  }
});

// Row counts per table (verification).
app.get('/admin/status', adminGuard, async (req, res) => {
  try {
    const adminApp = catalyst.initialize(req, { scope: 'admin' });
    const zcql = adminApp.zcql();
    const out = {};
    for (const t of SEED_TABLES) {
      try {
        const r = await zcql.executeZCQLQuery(`SELECT COUNT(ROWID) FROM ${t}`);
        const obj = r && r[0] && r[0][t];
        out[t] = obj ? Number(Object.values(obj)[0]) : 0;
      } catch (_) { out[t] = 'table_missing'; }
    }
    res.json({ counts: out });
  } catch (e) {
    res.status(500).json({ error: 'status_failed', message: String(e && e.message || e) });
  }
});

// --- Stubs (return 501 until implemented, so the contract is deployable now) ---
const notYet = (name) => (_req, res) =>
  res.status(501).json({ error: 'not_implemented', endpoint: name });

// ---- Conversational core: grounded RAG/text-to-ZCQL + audit trail ----
app.post('/chat', requireRole(), async (req, res) => {
  try {
    const { question, language = 'en' } = req.body || {};
    let { sessionId } = req.body || {};
    if (!question || !question.trim()) return res.status(400).json({ error: 'question required' });
    const role = req.userRole;
    const userId = req.headers['x-user-id'] || 'demo-user';

    const adminApp = catalyst.initialize(req, { scope: 'admin' });
    const ds = adminApp.datastore();

    // Session: create if new
    let history = [];
    if (!sessionId) {
      sessionId = genId('sess');
      try {
        await ds.table('ChatSessions').insertRow({
          SessionID: sessionId, UserId: userId, Role: role, Language: language,
          Title: question.slice(0, 80), CreatedAt: dtNow()
        });
      } catch (_) { /* non-fatal */ }
    } else {
      // pull recent turns for multi-turn context
      try {
        const prior = await adminApp.zcql().executeZCQLQuery(
          `SELECT QueryText, AnswerText FROM AuditLog WHERE SessionID='${sessionId}' ORDER BY CREATEDTIME DESC LIMIT 3`);
        history = (prior || []).map((r) => r.AuditLog || r).reverse()
          .flatMap((h) => [
            { role: 'user', content: h.QueryText || '' },
            { role: 'assistant', content: (h.AnswerText || '').slice(0, 400) }
          ]);
      } catch (_) { /* ignore */ }
    }

    const result = await handleChat(adminApp, { question, sessionId, role, language, history });

    // Audit trail (explainability + governance)
    try {
      await ds.table('AuditLog').insertRow({
        AuditID: genId('aud'), SessionID: sessionId, UserId: userId, Role: role,
        QueryText: question, GeneratedZCQL: result.zcql || '',
        CitedRecordIDs: (result.citations || []).map((c) => c.id).join(', ').slice(0, 60000),
        ReasoningPath: (result.rationale || '') + (result.reasoning ? ' | ' + result.reasoning : ''),
        ModelUsed: modelLabel(), AnswerText: result.answer || '',
        CreatedAt: dtNow()
      });
    } catch (_) { /* non-fatal */ }

    res.json({
      sessionId, answer: result.answer, zcql: result.zcql, rationale: result.rationale,
      citations: result.citations, rowCount: result.rowCount, rows: result.rows.slice(0, 50),
      reasoning: result.reasoning, role, language
    });
  } catch (e) {
    res.status(500).json({ error: 'chat_failed', message: String((e && e.message) || e) });
  }
});

app.get('/chat/:sessionId', requireRole(), async (req, res) => {
  try {
    const adminApp = catalyst.initialize(req, { scope: 'admin' });
    const rows = await adminApp.zcql().executeZCQLQuery(
      `SELECT QueryText, AnswerText, GeneratedZCQL, CitedRecordIDs, ReasoningPath, CREATEDTIME FROM AuditLog WHERE SessionID='${req.params.sessionId}' ORDER BY CREATEDTIME ASC LIMIT 100`);
    res.json({ sessionId: req.params.sessionId, turns: (rows || []).map((r) => r.AuditLog || r) });
  } catch (e) {
    res.status(500).json({ error: 'history_failed', message: String((e && e.message) || e) });
  }
});
app.post('/chat/:sessionId/pdf', requireRole(), notYet('chat-pdf'));

// ---- OCR-based FIR ingestion (Catalyst Zia OCR -> LLM structure -> reviewed Data Store write) ----
app.post('/ingest/ocr', requireRole('investigator', 'analyst', 'supervisor', 'admin'), async (req, res) => {
  try {
    const { ingestFir } = require('./lib/ocr');
    const { fileBase64, filename, language } = req.body || {};
    if (typeof fileBase64 !== 'string' || !fileBase64) {
      return res.status(400).json({ error: 'fileBase64 required' });
    }
    // 10 MB decoded file limit. Base64 expands data by roughly 4/3.
    if (fileBase64.length > Math.ceil(10 * 1024 * 1024 * 4 / 3) + 4) {
      return res.status(413).json({ error: 'file_too_large', message: 'FIR scans must be 10 MB or smaller.' });
    }
    const adminApp = catalyst.initialize(req, { scope: 'admin' });
    // Extraction is deliberately read-only. Database writes only happen through /ingest/confirm.
    const out = await ingestFir(adminApp, { fileBase64, filename, language, insert: false });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: 'ocr_failed', message: String((e && e.message) || e) });
  }
});

app.post('/ingest/confirm', requireRole('investigator', 'analyst', 'supervisor', 'admin'), async (req, res) => {
  try {
    const { insertIngestedCase } = require('./lib/ocr');
    const { structured, text = '' } = req.body || {};
    if (!structured || typeof structured !== 'object' || Array.isArray(structured)) {
      return res.status(400).json({ error: 'structured FIR fields required' });
    }
    const requiredFields = ['DistrictName', 'StationName', 'CrimeHead'];
    const missingFields = requiredFields.filter((field) => (
      typeof structured[field] !== 'string' || !structured[field].trim()
    ));
    if (missingFields.length) {
      return res.status(400).json({
        error: 'required_fir_fields_missing',
        message: 'District, police station, and crime head are required.',
        fields: missingFields,
      });
    }
    const adminApp = catalyst.initialize(req, { scope: 'admin' });
    const inserted = await insertIngestedCase(adminApp, structured, typeof text === 'string' ? text : '');
    res.status(201).json({ inserted });
  } catch (e) {
    res.status(500).json({ error: 'fir_insert_failed', message: String((e && e.message) || e) });
  }
});

// ============================ Analytics & visualization ============================
function analyticsRoute(fn) {
  return async (req, res) => {
    try {
      const analytics = require('./lib/analytics');
      const adminApp = catalyst.initialize(req, { scope: 'admin' });
      const data = await analytics[fn](adminApp, { ...req.query });
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: fn + '_failed', message: String((e && e.message) || e) });
    }
  };
}

app.get('/analytics/overview', requireRole(), analyticsRoute('overview'));
app.get('/analytics/hotspots', requireRole(), analyticsRoute('hotspots'));
app.get('/analytics/trends', requireRole(), analyticsRoute('trends'));
app.get('/analytics/network', requireRole('analyst', 'supervisor', 'policymaker', 'admin'), analyticsRoute('network'));
app.get('/analytics/offenders', requireRole('analyst', 'supervisor', 'policymaker', 'admin'), analyticsRoute('offenders'));
app.get('/analytics/financial', requireRole('analyst', 'supervisor', 'policymaker', 'admin'), analyticsRoute('financial'));
app.get('/analytics/sociology', requireRole(), analyticsRoute('sociology'));
app.get('/analytics/moneytrail', requireRole('analyst', 'supervisor', 'policymaker', 'admin'), analyticsRoute('moneytrail'));

// ---- Investigator Decision Support (framework #6) ----
app.get('/investigator/case', requireRole(), async (req, res) => {
  try {
    const { investigator } = { investigator: require('./lib/investigator') };
    const adminApp = catalyst.initialize(req, { scope: 'admin' });
    const data = await investigator.caseSupport(adminApp, { crimeNo: req.query.crimeNo, caseId: req.query.caseId, language: req.query.language });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'investigator_failed', message: String((e && e.message) || e) });
  }
});

// ============================ Predictive / Early-warning engine (feature #7) ============================
function forecastRoute(fn) {
  return async (req, res) => {
    try {
      const engine = require('./lib/backtest');
      const adminApp = catalyst.initialize(req, { scope: 'admin' });
      // level=state|district and state=<name> mirror the hotspot map's drill-down. District
      // is the default because state x month is the one backtested configuration that loses
      // to seasonal-naive outright (MASE 1.083 against district's 0.787) — 36 units by 36
      // periods is too little signal. See ml/RESULTS.md.
      const data = await engine[fn](adminApp, {
        ...req.query,
        level: req.query.level === 'state' ? 'state' : 'district',
        state: req.query.state || null,
      });
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: fn + '_failed', message: String((e && e.message) || e) });
    }
  };
}

app.get('/analytics/forecast', requireRole(), forecastRoute('computeForecast'));
app.get('/analytics/earlywarning', requireRole(), forecastRoute('computeEarlyWarning'));
app.get('/analytics/backtest', requireRole('analyst', 'supervisor', 'policymaker', 'admin'), forecastRoute('computeBacktest'));
app.get('/analytics/watchlist', requireRole('analyst', 'supervisor', 'policymaker', 'admin'), forecastRoute('computeWatchlist'));

// LLM analyst brief — narrates the forecast + early-warning into an actionable brief.
app.get('/analytics/brief', requireRole(), async (req, res) => {
  try {
    const engine = require('./lib/backtest');
    const { chatLLM } = require('./lib/llm');
    const adminApp = catalyst.initialize(req, { scope: 'admin' });
    const language = (req.query.language === 'kn') ? 'kn' : 'en';
    const [fc, ew] = await Promise.all([engine.computeForecast(adminApp), engine.computeEarlyWarning(adminApp)]);
    if (fc.error) return res.status(400).json(fc);
    const top = fc.forecasts.slice(0, 8).map((f) => `${f.district}: predicted ${f.predicted} (baseline ${f.baseline}, ${f.trendPct >= 0 ? '+' : ''}${f.trendPct}%, 90% CI ${f.low}-${f.high})`).join('\n');
    const crit = ew.alerts.slice(0, 6).map((a) => `${a.district} [${a.severity}] z=${a.z} trend ${a.trendPct}%`).join('\n');
    const sys = `You are a senior crime-intelligence analyst for the Karnataka State Police. Write a crisp, decision-ready early-warning brief for police leadership based ONLY on the forecast data provided. Be specific, cite districts and numbers, recommend concrete proactive deployment actions, and add a one-line fairness caveat (decision-support, exposure-normalized, not automated enforcement). ${language === 'kn' ? 'Write the brief in Kannada.' : 'Write in English.'} Keep it under 220 words.`;
    const usr = `Forecast horizon: ${fc.horizon}\nEnsemble accuracy (MAE): ${fc.accuracy && fc.accuracy.mae}\nModel weights: ${JSON.stringify(fc.weights)}\n\nTop predicted districts next month:\n${top}\n\nEarly-warning flags (${ew.critical} critical, ${ew.elevated} elevated):\n${crit}`;
    const out = await chatLLM(adminApp, { messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }], maxTokens: 700 });
    res.json({ horizon: fc.horizon, brief: out.content, critical: ew.critical, elevated: ew.elevated, model: modelLabel() });
  } catch (e) {
    res.status(500).json({ error: 'brief_failed', message: String((e && e.message) || e) });
  }
});

// Admin: clear tables before a fresh re-seed (guarded).
app.post('/admin/reset', adminGuard, async (req, res) => {
  try {
    const tables = Array.isArray(req.body && req.body.tables) && req.body.tables.length ? req.body.tables : SEED_TABLES;
    const adminApp = catalyst.initialize(req, { scope: 'admin' });
    const zcql = adminApp.zcql();
    const out = {};
    const countRows = async (t) => {
      const r = await zcql.executeZCQLQuery(`SELECT COUNT(ROWID) FROM ${t}`);
      const obj = r && r[0] && r[0][t]; return obj ? Number(Object.values(obj)[0]) : 0;
    };
    for (const t of tables) {
      if (!SEED_TABLES.includes(t)) { out[t] = 'skipped'; continue; }
      try {
        let iters = 0, deleted = 0;
        while (iters++ < 400) {
          const before = await countRows(t);
          if (before === 0) break;
          await zcql.executeZCQLQuery(`DELETE FROM ${t}`);
          const after = await countRows(t);
          deleted += (before - after);
          if (after >= before) break; // no progress -> stop
        }
        out[t] = `cleared (${deleted} rows, ${iters} passes)`;
      } catch (e) { out[t] = 'error: ' + String((e && e.message) || e).slice(0, 120); }
    }
    res.json({ reset: out });
  } catch (e) {
    res.status(500).json({ error: 'reset_failed', message: String((e && e.message) || e) });
  }
});

// --- 404 ---
app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

module.exports = app;
