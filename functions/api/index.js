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
 *
 *   WhatsApp field-officer channel (lib/wa/*):
 *   GET  /whatsapp/webhook           Meta subscription handshake
 *   POST /whatsapp/webhook           inbound messages (HMAC-verified, fast ack)
 *   POST /whatsapp/process           internal: run one turn through the field agent
 *   POST /whatsapp/alerts/dispatch   internal: cron-driven early-warning push
 *   GET  /whatsapp/health            channel configuration diagnostics
 *   GET/POST /admin/officers         officer roster (admin-key guarded)
 */

const express = require('express');
const catalyst = require('zcatalyst-sdk-node');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parseCsv } = require('./lib/csv');
const { handleChat, runZcql } = require('./lib/chat');
const { modelLabel } = require('./lib/llm');

// datetime helper for Data Store (YYYY-MM-DD HH:mm:ss)
const dtNow = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const genId = (p) => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const app = express();
// Meta signs the WhatsApp webhook over the RAW request bytes, so keep a copy
// before parsing — re-serializing the parsed object changes whitespace and key
// order and the HMAC no longer matches.
app.use(express.json({
  limit: '10mb',
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));

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

// ---- Voice: Sarvam AI STT + TTS (lib/voice.js) ----
// Catalyst/Zia has no speech model, so voice uses Sarvam (saarika STT + bulbul TTS),
// the one justified third-party (LLM = Zoho GLM, OCR = Zia are fully native).
// The WhatsApp channel transcribes voice notes through the same module.
app.post('/voice/stt', requireRole(), async (req, res) => {
  try {
    const { audio, mime = 'audio/webm', language } = req.body || {};
    if (!audio) return res.status(400).json({ error: 'audio (base64) required' });
    const { speechToText } = require('./lib/voice');
    const out = await speechToText({ buffer: Buffer.from(audio, 'base64'), mime, language });
    res.json(out);
  } catch (e) {
    res.status(e && e.status === 400 ? 400 : 502).json({
      error: 'stt_failed', message: String((e && e.message) || e), detail: e && e.detail
    });
  }
});

app.post('/voice/tts', requireRole(), async (req, res) => {
  try {
    const { text, language } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });
    const { textToSpeech } = require('./lib/voice');
    res.json(await textToSpeech({ text, language }));
  } catch (e) {
    res.status(502).json({ error: 'tts_failed', message: String((e && e.message) || e), detail: e && e.detail });
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
/**
 * Constant-time secret comparison. Used by every shared-key guard so they match
 * the discipline the webhook's HMAC check already follows — a `!==` on a secret
 * returns early on the first differing byte, and there is no reason to hand out
 * that signal when the fix is three lines.
 */
function secretMatches(supplied, expected) {
  if (!expected) return false;
  const a = Buffer.from(String(supplied == null ? '' : supplied));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function adminGuard(req, res, next) {
  if (!secretMatches(req.headers['x-admin-key'], process.env.ADMIN_KEY)) {
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

/**
 * Run a read-only ZCQL query. Admin-only, SELECT-only.
 *
 * Exists because there is no other way to see what the Data Store actually answers at scale: an
 * analytics endpoint failing with "Error occurred during query processing" says nothing about
 * which of its six queries failed, and the console's ZCQL console cannot be scripted.
 *
 * Deliberately narrow. Only SELECT is accepted, and anything containing a statement separator or
 * a mutating keyword is rejected rather than escaped — this is a diagnostic tool, so the safe
 * behaviour is to refuse anything it does not need to support.
 */
app.post('/admin/zcql', adminGuard, async (req, res) => {
  try {
    const sql = String((req.body && req.body.query) || '').trim();
    if (!/^select\s/i.test(sql)) return res.status(400).json({ error: 'only SELECT is allowed' });
    if (/;|\b(insert|update|delete|drop|alter|create|truncate)\b/i.test(sql)) {
      return res.status(400).json({ error: 'query rejected', reason: 'mutation or statement separator' });
    }
    const adminApp = catalyst.initialize(req, { scope: 'admin' });
    const started = Date.now();
    const rows = await adminApp.zcql().executeZCQLQuery(sql);
    res.json({ ms: Date.now() - started, count: (rows || []).length, rows: (rows || []).slice(0, 50) });
  } catch (e) {
    res.status(400).json({ error: 'zcql_failed', message: String((e && e.message) || e) });
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
// Routes that have a batch-scored snapshot. The others stay live: watchlist and backtest are
// cheap enough, and a snapshot for them would be cache for its own sake.
const SNAPSHOT_ROUTES = { computeForecast: 'forecast', computeEarlyWarning: 'earlywarning' };

function forecastRoute(fn) {
  return async (req, res) => {
    try {
      const engine = require('./lib/backtest');
      const adminApp = catalyst.initialize(req, { scope: 'admin' });
      // level=state|district and state=<name> mirror the hotspot map's drill-down. District
      // is the default because state x month is the one backtested configuration that loses
      // to seasonal-naive outright (MASE 1.083 against district's 0.787) — 36 units by 36
      // periods is too little signal. See ml/RESULTS.md.
      const opts = {
        ...req.query,
        level: req.query.level === 'state' ? 'state' : 'district',
        state: req.query.state || null,
      };

      // Serve the batch-scored snapshot when one exists. These routes otherwise fit a model
      // inside the request, which does not survive national scale inside a 25-second ceiling.
      // A missing or stale snapshot falls through to live computation, so this is additive:
      // `?fresh=1` forces the live path for debugging and for verifying a refresh.
      const snapRoute = SNAPSHOT_ROUTES[fn];
      if (snapRoute && req.query.fresh !== '1') {
        const store = require('./lib/forecastStore');
        const snap = await store.readSnapshot(adminApp, snapRoute, opts,
          { maxAgeHours: Number(req.query.maxAgeHours) || 168 });
        if (snap) return res.json(snap);
      }

      const data = await engine[fn](adminApp, opts);
      res.json({ ...data, cached: false });
    } catch (e) {
      res.status(500).json({ error: fn + '_failed', message: String((e && e.message) || e) });
    }
  };
}

app.get('/analytics/forecast', requireRole(), forecastRoute('computeForecast'));
app.get('/analytics/earlywarning', requireRole(), forecastRoute('computeEarlyWarning'));
app.get('/analytics/backtest', requireRole('analyst', 'supervisor', 'policymaker', 'admin'), forecastRoute('computeBacktest'));
app.get('/analytics/watchlist', requireRole('analyst', 'supervisor', 'policymaker', 'admin'), forecastRoute('computeWatchlist'));

/**
 * Recompute the forecast snapshots that the read routes serve.
 *
 * Admin-only and intentionally manual: the forecast changes when new cases are loaded, not on a
 * clock, so tying it to a schedule would either recompute identical answers or serve stale ones
 * between runs. Call it after a load. Each scope is written independently and failures are
 * reported per scope rather than aborting the run, because a national refresh that dies on one
 * state should still leave the other scopes correct.
 */
/**
 * Delete a whole forecast scope, ignoring StateName.
 *
 * Needed because the per-state refresh deletes only its own state's rows, which cannot clear
 * two kinds of stale row: those written by an earlier national run before StateName existed
 * (StateName is null, so no state filter matches them), and duplicates left when a request times
 * out on the client but its inserts land afterwards. Rebuilding a scope from empty is cheap —
 * a few hundred rows — and is the only way to be certain it holds exactly one row per unit.
 */
app.post('/admin/forecast/purge', adminGuard, async (req, res) => {
  try {
    const store = require('./lib/forecastStore');
    const adminApp = catalyst.initialize(req, { scope: 'admin' });
    const level = req.body && req.body.level === 'state' ? 'state' : 'district';
    const routes = Object.values(SNAPSHOT_ROUTES);
    const out = {};
    for (const route of routes) {
      const scope = store.scopeKey(route, { level, state: null });
      out[route] = {
        rows: await store.clearScope(adminApp, store.TABLE, scope),
        meta: await store.clearScope(adminApp, store.META_TABLE, scope),
      };
    }
    res.json({ level, purged: out });
  } catch (e) {
    res.status(500).json({ error: 'purge_failed', message: String((e && e.message) || e) });
  }
});

/**
 * Repair a scope: drop duplicate units, keeping the newest row per unit.
 *
 * An insert can fail at the client after succeeding at the server, so its retry writes a second
 * copy. Exactly-once delivery is not available here, so the snapshot is made self-healing.
 */
app.post('/admin/forecast/dedupe', adminGuard, async (req, res) => {
  try {
    const store = require('./lib/forecastStore');
    const adminApp = catalyst.initialize(req, { scope: 'admin' });
    const level = req.body && req.body.level === 'state' ? 'state' : 'district';
    const out = {};
    for (const route of Object.values(SNAPSHOT_ROUTES)) {
      out[route] = await store.dedupeScope(adminApp, store.scopeKey(route, { level, state: null }));
    }
    res.json({ level, result: out });
  } catch (e) {
    res.status(500).json({ error: 'dedupe_failed', message: String((e && e.message) || e) });
  }
});

/**
 * Store a forecast payload computed elsewhere.
 *
 * Why this exists. Assembling the national district-month panel and scoring it takes ~45s, past
 * a Function's execution ceiling, which is why the in-Catalyst refresh has to work one state at a
 * time. But a per-state model loses the thing that makes the gradient-boosted model strong —
 * pooling across all 640 districts — and it shows: per-state scoring lands at MASE 0.95 against
 * the pooled model's 0.79 on the same data.
 *
 * Nothing requires the scoring to happen inside Catalyst. This endpoint accepts a payload scored
 * by the same engine package running anywhere, so the served forecast is the strong pooled one
 * and the write costs a few hundred rows.
 */
app.post('/admin/forecast/put', adminGuard, async (req, res) => {
  try {
    const store = require('./lib/forecastStore');
    const adminApp = catalyst.initialize(req, { scope: 'admin' });
    const { route, payload } = req.body || {};
    const level = req.body && req.body.level === 'state' ? 'state' : 'district';
    if (!Object.values(SNAPSHOT_ROUTES).includes(route)) {
      return res.status(400).json({ error: 'unknown route', route, allowed: Object.values(SNAPSHOT_ROUTES) });
    }
    if (!payload || !(Array.isArray(payload.forecasts) || Array.isArray(payload.alerts))) {
      return res.status(400).json({ error: 'payload must carry forecasts[] or alerts[]' });
    }
    const result = await store.writeSnapshot(adminApp, route, { level, state: null }, payload);
    res.json({ route, level, result });
  } catch (e) {
    res.status(500).json({ error: 'put_failed', message: String((e && e.message) || e) });
  }
});

app.post('/admin/forecast/refresh', adminGuard, async (req, res) => {
  const started = Date.now();
  try {
    const engine = require('./lib/backtest');
    const store = require('./lib/forecastStore');
    const adminApp = catalyst.initialize(req, { scope: 'admin' });
    const level = req.body && req.body.level === 'state' ? 'state' : 'district';
    const state = (req.body && req.body.state) || null;
    // A national district forecast takes the engine ~28s, past this function's 25s ceiling. So
    // when a state is given, the run computes that state and writes its slice into the shared
    // national scope. Loop the 36 states (datastore/refresh-forecast.js does) to build the
    // national snapshot without any single call approaching the limit.
    const partial = state && req.body && req.body.partial !== false ? state : null;
    const opts = { level, state };

    const results = {};
    for (const [fn, route] of Object.entries(SNAPSHOT_ROUTES)) {
      try {
        const payload = await engine[fn](adminApp, opts);
        results[route] = await store.writeSnapshot(adminApp, route, opts, payload, { partialState: partial });
      } catch (e) {
        // Per-route, so a failure in early-warning still leaves a correct forecast snapshot.
        results[route] = { error: String((e && e.message) || e) };
      }
    }
    res.json({ level, state, partial: !!partial, results, elapsedMs: Date.now() - started });
  } catch (e) {
    res.status(500).json({ error: 'refresh_failed', message: String((e && e.message) || e), elapsedMs: Date.now() - started });
  }
});

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

// ============================ WhatsApp field-officer channel ============================
// Meta WhatsApp Cloud API webhook + the internal endpoints its async processing and
// alert cron call back into. See lib/wa/* and documentation/15-whatsapp-field-bot.md.
//
// These routes are deliberately NOT behind requireRole: a field message carries no
// role header. Authorization is the Officers roster (lib/wa/officers.js), and the
// webhook itself is authenticated by Meta's HMAC signature.

// Webhook subscription handshake.
app.get('/whatsapp/webhook', (req, res) => {
  const { verifyChallenge } = require('./lib/wa/client');
  const challenge = verifyChallenge(req.query);
  if (!challenge) return res.sendStatus(403);
  res.status(200).type('text/plain').send(challenge);
});

// Inbound messages. Meta redelivers anything it does not see acknowledged quickly,
// so this answers 200 as soon as the message is authenticated and claimed, and the
// slow work runs in a job (or inline when job scheduling is unconfigured).
app.post('/whatsapp/webhook', async (req, res) => {
  const { verifySignature } = require('./lib/wa/client');
  if (!verifySignature(req.rawBody, req.headers['x-hub-signature-256'])) {
    return res.status(403).json({ error: 'bad_signature' });
  }
  const { acceptWebhook } = require('./lib/wa/inbound');
  // The work is awaited BEFORE responding, always.
  //
  // Acknowledging first and finishing afterwards looks like the obvious way to keep
  // the webhook fast, but a serverless instance can be frozen the moment the
  // response is written — and the part that would be lost is the job submission,
  // i.e. the officer's message. With a job pool configured this path only claims the
  // id and submits the job, so it returns in well under a second anyway. Without
  // one it processes inline and takes longer; Meta may then redeliver, but the id is
  // claimed exactly once, so the redelivery is discarded rather than answered twice.
  let accepted = null;
  try {
    const adminApp = catalyst.initialize(req, { scope: 'admin' });
    accepted = await acceptWebhook(adminApp, req.body);
    if (accepted && accepted.error) console.error('wa webhook partial failure:', accepted.error);
  } catch (e) {
    console.error('wa webhook failed:', String((e && e.message) || e));
  }
  // Always 200. A non-2xx makes Meta redeliver, and a redelivery cannot help with a
  // failure on our side — it only re-enters a code path that just failed.
  //
  // The body reports counts only — how many events arrived, how many were queued,
  // deduplicated or handled inline — and never message content. Meta ignores it, but
  // it is the only way to tell from outside whether the queue is actually carrying
  // turns or whether every one is silently falling back inline, and this endpoint is
  // HMAC-gated so no unauthenticated caller ever sees it.
  if (!res.headersSent) res.status(200).json(accepted || { received: 0 });
});

// Internal: process one normalized turn. Called by the Catalyst job, never by Meta.
// Fails closed — without WA_INTERNAL_KEY nobody may drive officer conversations.
function internalGuard(req, res, next) {
  if (!secretMatches(req.headers['x-wa-internal-key'], process.env.WA_INTERNAL_KEY)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

app.post('/whatsapp/process', internalGuard, async (req, res) => {
  try {
    const { processEvent } = require('./lib/wa/inbound');
    const event = req.body && req.body.event;
    if (!event || !event.from) return res.status(400).json({ error: 'event required' });
    const adminApp = catalyst.initialize(req, { scope: 'admin' });
    const out = await processEvent(adminApp, event);
    // processEvent decides whether a retry is safe. It is safe only when the failure
    // happened before the agent ran, because a turn that already enrolled a photo
    // would enrol it twice on the second attempt. A 500 is what makes the job pool
    // try again, so it is sent only when processEvent asked for it.
    res.status(out && out.retry ? 500 : 200).json(out);
  } catch (e) {
    res.status(500).json({ error: 'wa_process_failed', message: String((e && e.message) || e) });
  }
});

// Internal: proactive early-warning push. Wired to a Catalyst cron.
app.post('/whatsapp/alerts/dispatch', internalGuard, async (req, res) => {
  try {
    const { dispatchAlerts } = require('./lib/wa/alerts');
    const adminApp = catalyst.initialize(req, { scope: 'admin' });
    const dryRun = req.query.dryRun === 'true' || (req.body && req.body.dryRun === true);
    res.json(await dispatchAlerts(adminApp, { dryRun }));
  } catch (e) {
    res.status(500).json({ error: 'wa_alerts_failed', message: String((e && e.message) || e) });
  }
});

/**
 * Whether the installed SDK actually exposes a namespace.
 *
 * Probed against the prototype so it costs nothing and needs no request context.
 */
function hasSdkNamespace(name) {
  try {
    const proto = catalyst.initialize && Object.getPrototypeOf(catalyst);
    if (proto && typeof proto[name] === 'function') return true;
  } catch (_) { /* fall through */ }
  try {
    require.resolve('zcatalyst-sdk-node/lib/' + (name === 'jobScheduling' ? 'job-scheduling' : name));
    return true;
  } catch (_) {
    return false;
  }
}

// Channel diagnostics. Reports whether each piece is configured, never the values.
//
// Admin-guarded, because the answers are useful to the wrong person too: row counts
// for a police roster and gallery are operational intelligence, and
// `webhookSignature: false` tells a caller the webhook is forgeable.
app.get('/whatsapp/health', adminGuard, async (req, res) => {
  const set = (k) => Boolean(process.env[k]);
  const out = {
    channel: 'whatsapp-field-officer',
    graphVersion: process.env.WA_GRAPH_VERSION || 'v25.0',
    sdk: (() => { try { return require('zcatalyst-sdk-node/package.json').version; } catch (_) { return 'unknown'; } })(),
    configured: {
      send: set('WA_PHONE_NUMBER_ID') && set('WA_ACCESS_TOKEN'),
      webhookSignature: set('WA_APP_SECRET'),
      webhookVerifyToken: set('WA_VERIFY_TOKEN'),
      // Config alone is not enough to answer this. Job Scheduling and Stratus arrived
      // in zcatalyst-sdk-node 3.x, and on 2.x the calls simply are not there: photo
      // enrolment throws and the webhook silently falls back to inline forever. Both
      // were configured and reported healthy while neither could work, so the
      // namespaces are probed rather than assumed.
      asyncJobs: set('WA_JOBPOOL') && set('WA_PROCESS_URL') && hasSdkNamespace('jobScheduling'),
      objectStore: hasSdkNamespace('stratus'),
      internalKey: set('WA_INTERNAL_KEY'),
      // Templates are off by policy: this deployment sends free-form only, inside the
      // 24-hour service window, and an alert for a closed window is deferred rather
      // than downgraded. The refusal is enforced in lib/wa/client.js sendTemplate, so
      // this reports the actual switch rather than whether a template name is set.
      templatesEnabled: String(process.env.WA_ALLOW_TEMPLATES || '').toLowerCase() === 'true',
      photoBucket: process.env.WA_PHOTO_BUCKET || 'ksp-field-photos'
    }
  };
  // Resolve the job pool for real. `enqueue` deliberately swallows its failure and
  // falls back inline — losing the queue must not lose an officer's message — which
  // also means a broken queue is invisible. This is a read, creates no job, and
  // exercises the same namespace and credentials that submitJob would.
  if (out.configured.asyncJobs) {
    try {
      const adminApp = catalyst.initialize(req, { scope: 'admin' });
      const pool = await adminApp.jobScheduling().getJobpool(process.env.WA_JOBPOOL);
      out.jobPool = pool ? 'resolved' : 'not found';
    } catch (e) {
      out.jobPool = 'error: ' + String((e && e.message) || e).slice(0, 200);
    }
  }

  // The WABA id, learned from whichever callback arrived first. Reported here because
  // it gates message-template management and cannot be read from the Graph API with a
  // system-user token.
  try {
    const adminApp = catalyst.initialize(req, { scope: 'admin' });
    out.wabaId = (await require('./lib/wa/inbound').knownWabaId(adminApp))
      || 'not seen yet — arrives on the first Meta callback';
  } catch (_) { /* diagnostic only */ }

  try {
    const adminApp = catalyst.initialize(req, { scope: 'admin' });
    const zcql = adminApp.zcql();
    for (const t of ['Officers', 'WaMessages', 'PersonPhotos']) {
      try {
        const r = await zcql.executeZCQLQuery(`SELECT COUNT(ROWID) FROM ${t}`);
        const obj = r && r[0] && r[0][t];
        out[t] = obj ? Number(Object.values(obj)[0]) : 0;
      } catch (_) { out[t] = 'table_missing'; }
    }
  } catch (_) { out.datastore = 'unavailable'; }
  res.json(out);
});

// Officer roster management (admin-key guarded, same as the seeder).
app.get('/admin/officers', adminGuard, async (req, res) => {
  try {
    const adminApp = catalyst.initialize(req, { scope: 'admin' });
    const rows = await adminApp.zcql().executeZCQLQuery('SELECT * FROM Officers ORDER BY CREATEDTIME DESC LIMIT 300');
    const { shapeOfficer } = require('./lib/wa/officers');
    res.json({ officers: (rows || []).map((r) => shapeOfficer(r.Officers || r)) });
  } catch (e) {
    res.status(500).json({ error: 'officers_failed', message: String((e && e.message) || e) });
  }
});

// Register or update officers. Accepts one object or an array for bulk onboarding.
app.post('/admin/officers', adminGuard, async (req, res) => {
  try {
    const { upsertOfficer } = require('./lib/wa/officers');
    const adminApp = catalyst.initialize(req, { scope: 'admin' });
    const input = Array.isArray(req.body) ? req.body : [req.body || {}];
    if (input.length > 200) return res.status(400).json({ error: 'at most 200 officers per request' });
    const results = [];
    for (const o of input) {
      try { results.push(await upsertOfficer(adminApp, o)); }
      catch (e) { results.push({ phone: o && o.phone, error: String((e && e.message) || e) }); }
    }
    res.status(201).json({ results });
  } catch (e) {
    res.status(500).json({ error: 'officer_upsert_failed', message: String((e && e.message) || e) });
  }
});

// Deregister an officer. Body: { phone, purgeLedger?: true }.
//
// Revoking access day-to-day is POST with { active: false } — the roster lookup
// refuses an inactive row and the row remains as the record that this number held
// access. This route is for a number that should never have been registered, where
// an inactive row would leave a live police roster listing a number nobody owns.
app.delete('/admin/officers', adminGuard, async (req, res) => {
  try {
    const { deleteOfficer } = require('./lib/wa/officers');
    const adminApp = catalyst.initialize(req, { scope: 'admin' });
    const body = req.body || {};
    const out = await deleteOfficer(adminApp, {
      phone: body.phone,
      purgeLedger: body.purgeLedger === true
    });
    // 404 only when nothing at all was found for this number, so a ledger-only purge
    // of a never-registered caller reports success rather than "not found".
    const removedSomething = out.deleted || Number(out.ledgerRowsPurged || 0) > 0;
    res.status(removedSomething ? 200 : 404).json(out);
  } catch (e) {
    res.status(400).json({ error: 'officer_delete_failed', message: String((e && e.message) || e) });
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
