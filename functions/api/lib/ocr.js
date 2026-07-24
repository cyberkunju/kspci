'use strict';

/**
 * OCR-based FIR ingestion (the differentiator) — now fully on Zoho Catalyst.
 * Scanned FIR (image/PDF) -> Catalyst **Zia OCR** (native, 9 international + 10 Indian
 * languages incl. Kannada) -> text -> LLM (Zoho QuickML GLM-4.7-Flash) structures it into
 * FIR fields -> inserted into the Data Store so it becomes queryable by the same
 * conversational + analytics pipeline.
 *
 * Zia OCR: app.zia().extractOpticalCharacters(fileStream, { language, modelType }) -> { text, confidence }
 *   Allowed formats: jpg, jpeg, png, tiff, bmp, pdf. Size <= 20 MB. Files are processed
 *   one-time and never stored/trained on (Catalyst privacy compliance).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chatLLM } = require('./llm');

// Map UI language to a Zia OCR language code. Omit to auto-detect (handles mixed EN+KN FIRs).
function ziaLang(l) {
  if (!l) return null;
  const s = String(l).toLowerCase();
  if (s.startsWith('kn')) return 'kan';   // Kannada
  if (s.startsWith('hi')) return 'hin';   // Hindi
  if (s.startsWith('en')) return 'eng';   // English
  return null;
}

// Run Catalyst Zia OCR end-to-end and return the extracted text.
async function runZiaOcr(app, { fileBase64, filename = 'fir.png', language }) {
  const tmp = os.tmpdir();
  const inPath = path.join(tmp, `ocr_${Date.now()}_${String(filename).replace(/[^\w.\-]/g, '_')}`);
  fs.writeFileSync(inPath, Buffer.from(fileBase64, 'base64'));

  const zia = app.zia();
  const lang = ziaLang(language);

  const extract = (opts) => zia.extractOpticalCharacters(fs.createReadStream(inPath), opts);

  let res;
  try {
    // Try with the requested language first; if that fails, retry with auto-detect.
    try {
      res = await extract(lang ? { language: lang, modelType: 'OCR' } : { modelType: 'OCR' });
    } catch (e) {
      if (lang) res = await extract({ modelType: 'OCR' });
      else throw e;
    }
  } finally {
    try { fs.unlinkSync(inPath); } catch (_) {}
  }

  const text = (res && (res.text || res.recognized_text || '')) || '';
  const confidence = res && (res.confidence != null ? res.confidence : null);
  return { text, confidence, engine: 'catalyst-zia-ocr' };
}

// Structure the OCR text into FIR fields via the LLM (grounded to the extracted text).
async function structureFir(app, text) {
  const messages = [
    { role: 'system', content:
      'You extract structured fields from an OCR-scanned Indian police FIR. Return ONLY a JSON object ' +
      'with keys: DistrictName, StationName, CrimeSubHead, CrimeHead, Gravity, CaseCategory, ' +
      'IncidentDate (YYYY-MM-DD or ""), ComplainantName, AccusedNames (array of strings), ' +
      'ActsSections (string), BriefFacts (2-3 sentence summary). Use "" or [] when unknown. ' +
      'Do not invent values not supported by the text.' },
    { role: 'user', content: 'FIR OCR TEXT:\n' + String(text).slice(0, 6000) }
  ];
  const r = await chatLLM(app, { messages, maxTokens: 700 });
  const m = (r.content || '').match(/\{[\s\S]*\}/);
  try { return m ? JSON.parse(m[0]) : {}; } catch { return {}; }
}

// Insert the ingested FIR into the Data Store so it's queryable everywhere.
async function insertIngestedCase(app, structured, text) {
  const ds = app.datastore();
  const caseId = 900000000 + (Date.now() % 100000000);
  const crimeNo = 'OCR' + Date.now();
  const dt = (structured.IncidentDate || '').match(/^\d{4}-\d{2}-\d{2}/) ? structured.IncidentDate : new Date().toISOString().slice(0, 10);
  const row = {
    CaseMasterID: caseId, CrimeNo: crimeNo, CaseNo: crimeNo.slice(-9),
    CrimeRegisteredDate: dt, Year: Number(dt.slice(0, 4)), CrimeMonth: Number(dt.slice(5, 7)),
    IncidentDate: dt + ' 00:00:00',
    DistrictName: structured.DistrictName || 'Unknown', StationName: structured.StationName || 'Unknown',
    latitude: 0, longitude: 0,
    CaseCategory: structured.CaseCategory || 'FIR', Gravity: structured.Gravity || 'Non-Heinous',
    CrimeHead: structured.CrimeHead || 'Unclassified', CrimeSubHead: structured.CrimeSubHead || 'Unclassified',
    CaseStatus: 'Under Investigation', CourtName: '', OfficerName: 'OCR-Ingested',
    ActsSections: structured.ActsSections || '',
    AccusedCount: Array.isArray(structured.AccusedNames) ? structured.AccusedNames.length : 0,
    VictimCount: 0, BriefFacts: (structured.BriefFacts || text || '').slice(0, 9000)
  };
  await ds.table('Cases').insertRow(row);

  if (Array.isArray(structured.AccusedNames) && structured.AccusedNames.length) {
    const accused = structured.AccusedNames.filter(Boolean).slice(0, 10).map((name, i) => ({
      AccusedMasterID: caseId * 100 + i, CaseMasterID: caseId, CrimeNo: crimeNo,
      AccusedName: String(name).slice(0, 120), AgeYear: 0, Gender: '', PersonID: 'A' + (i + 1),
      RingID: 0, DistrictName: row.DistrictName, CrimeSubHead: row.CrimeSubHead
    }));
    try { await ds.table('Accused').insertRows(accused); } catch (_) {}
  }
  return { caseId, crimeNo };
}

async function ingestFir(app, { fileBase64, filename, language, insert = true }) {
  const ocr = await runZiaOcr(app, { fileBase64, filename, language });
  if (!ocr.text) return { ...ocr, structured: {}, inserted: null, note: 'no text extracted' };
  const structured = await structureFir(app, ocr.text);
  let inserted = null;
  if (insert) { try { inserted = await insertIngestedCase(app, structured, ocr.text); } catch (e) { inserted = { error: String(e.message || e) }; } }
  return { engine: ocr.engine, confidence: ocr.confidence, text: ocr.text, structured, inserted };
}

module.exports = { ingestFir, runZiaOcr, structureFir };
