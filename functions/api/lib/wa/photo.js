'use strict';

/**
 * Image intelligence for the field channel — Catalyst Zia only.
 *
 * Two paths, chosen by what is actually in the picture:
 *   face present     -> Zia Face Analytics (attributes) then Zia Facial Comparison
 *                       against the enrolled reference gallery
 *   no face          -> Zia OCR (document / FIR / notice) then identifier lookup
 *
 * Important limits, stated plainly because they shape the whole feature:
 *
 *  - Zia Facial Comparison is 1:1 (compareFace(a, b) -> {confidence, matched}).
 *    There is no 1:N search and no embedding index, so identification means N
 *    comparisons. Candidates are therefore narrowed by the attributes Face
 *    Analytics returns (gender, age band) and by district before comparing, and
 *    the count is hard-capped. This is the difference between a 4-second answer
 *    and a 4-minute one.
 *
 *  - The crime database contains no photographs. The gallery only holds what
 *    officers enrol in the field, so a fresh deployment matches nothing. That is
 *    reported honestly rather than dressed up.
 *
 *  - A comparison is a LEAD, never an identification. Zia sets matched=true at a
 *    confidence of only 0.5, which is nowhere near sufficient to put a name to a
 *    person in a policing context, so results are banded and every reply says the
 *    match needs human verification.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runZiaOcr } = require('../ocr');

const CANDIDATE_CAP = () => Math.min(Number(process.env.WA_FACE_CANDIDATES || 12), 40);
const CONCURRENCY = () => Math.min(Number(process.env.WA_FACE_CONCURRENCY || 3), 6);
const BUCKET = () => process.env.WA_PHOTO_BUCKET || 'ksp-field-photos';

// Confidence bands. Zia's own matched flag flips at 0.50; we refuse to call
// anything below 0.70 a candidate at all, and never call anything a match.
const STRONG = 0.85;
const POSSIBLE = 0.70;

const dtNow = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const genId = (p) => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function flatten(row) {
  const out = {};
  for (const k of Object.keys(row)) {
    const v = row[k];
    if (v && typeof v === 'object') Object.assign(out, v);
    else out[k] = v;
  }
  return out;
}
const q = async (app, query) => ((await app.zcql().executeZCQLQuery(query)) || []).map(flatten);
const esc = (s) => String(s == null ? '' : s).replace(/'/g, '');

/* ------------------------------ temp files ------------------------------ */

// The Zia SDK is driven with read streams (the same pattern lib/ocr.js uses), so
// buffers are staged on the function's ephemeral disk and always cleaned up.
function writeTemp(buffer, ext = '.jpg') {
  const p = path.join(os.tmpdir(), `wa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  fs.writeFileSync(p, buffer);
  return p;
}
function rm(p) { try { if (p) fs.unlinkSync(p); } catch (_) { /* ignore */ } }

function extFor(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('png')) return '.png';
  if (m.includes('webp')) return '.webp';
  return '.jpg';
}

const isPdf = (mime) => /pdf/i.test(String(mime || ''));

/**
 * Extension for the OCR path, which accepts more formats than the face path.
 *
 * This matters more than it looks: lib/ocr.js names its temp file from this, and
 * Zia decides how to read the file from that name. A PDF written as `field.jpg`
 * either fails or returns nothing, and the officer is told their document was
 * unreadable when in fact we mislabelled it.
 */
function docExtFor(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('pdf')) return '.pdf';
  if (m.includes('tiff')) return '.tiff';
  if (m.includes('bmp')) return '.bmp';
  return extFor(mime);
}

/* ------------------------------ object storage ------------------------------ */

async function putPhoto(app, key, buffer) {
  const bucket = app.stratus().bucket(BUCKET());
  await bucket.putObject(key, buffer);
  return key;
}

/**
 * Park the turn's photo so a follow-up message can still act on it.
 *
 * Meta's media URL expires in five minutes and the download requires our bearer
 * token, so "send me the photo again" is the only alternative — and an officer who
 * has already walked away from the subject cannot comply. Written under a
 * `scratch/` prefix so a storage lifecycle rule can expire it independently of
 * the enrolled gallery.
 */
async function stashTurnPhoto(app, image) {
  const key = `scratch/${genId('tmp')}${docExtFor(image && image.mime)}`;
  await putPhoto(app, key, image.buffer);
  return key;
}

/**
 * Read a parked photo back, then drop it. Returns null once it has expired.
 *
 * The delete matters: a frame is one-shot, so after this the object can never be
 * reached again, and without the delete every photo an officer ever sent through a
 * follow-up question stays in the bucket for good. A storage lifecycle rule on
 * `scratch/` is still worth having for the frames nobody ever answers.
 */
async function restoreTurnPhoto(app, key, mime) {
  if (!key) return null;
  let buffer;
  try {
    buffer = await getPhotoBuffer(app, key);
  } catch (_) {
    return null;
  }
  if (!buffer || !buffer.length) return null;
  try {
    await app.stratus().bucket(BUCKET()).deleteObject(key);
  } catch (_) { /* an orphaned scratch object is untidy, not a failure */ }
  return { buffer, mime: mime || 'image/jpeg' };
}

async function getPhotoBuffer(app, key) {
  const bucket = app.stratus().bucket(BUCKET());
  const stream = await bucket.getObject(key);
  if (Buffer.isBuffer(stream)) return stream;
  const chunks = [];
  await new Promise((resolve, reject) => {
    stream.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return Buffer.concat(chunks);
}

/* ------------------------------ Zia face analytics ------------------------------ */

/**
 * Detect faces and read attributes. Doubles as the router: zero faces means the
 * image is a document, so it goes down the OCR path instead.
 */
async function analyseFace(app, buffer, mime) {
  // Zia's face endpoints take images. Streaming a PDF at them produces an opaque
  // SDK error; saying so plainly lets the agent route the officer to OCR instead.
  if (isPdf(mime)) {
    const err = new Error('a PDF cannot be analysed as a photograph — read it as a document instead');
    err.notAnImage = true;
    throw err;
  }
  const p = writeTemp(buffer, extFor(mime));
  try {
    const res = await app.zia().analyseFace(fs.createReadStream(p), { mode: 'moderate', age: true, gender: true, emotion: false });
    const faces = Array.isArray(res && res.faces) ? res.faces : [];
    const count = Number((res && res.faces_count) != null ? res.faces_count : faces.length) || 0;
    // Largest face by bounding-box area is the subject of a stop-and-check photo.
    let primary = null;
    let best = -1;
    for (const f of faces) {
      const c = (f && f.co_ordinates) || [];
      const area = c.length >= 4 ? Math.abs((Number(c[2]) - Number(c[0])) * (Number(c[3]) - Number(c[1]))) : 0;
      if (area > best) { best = area; primary = f; }
    }
    return {
      count,
      gender: readPrediction(primary && primary.gender),
      age: readAge(primary && primary.age),
      confidence: primary && Number(primary.confidence)
    };
  } finally {
    rm(p);
  }
}

function readPrediction(attr) {
  const v = attr && (attr.prediction || attr.value);
  if (!v) return null;
  const s = String(v).toLowerCase();
  if (s.startsWith('m')) return 'M';
  if (s.startsWith('f')) return 'F';
  return null;
}
function readAge(attr) {
  if (attr == null) return null;
  const v = typeof attr === 'object' ? (attr.prediction != null ? attr.prediction : attr.value) : attr;
  const n = Number(String(v).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/**
 * One 1:1 comparison. Errors are swallowed into a null score: a single unreadable
 * reference photo must not abort the whole gallery sweep.
 */
async function compareOne(app, subjectPath, candidate) {
  let refPath = null;
  try {
    const buf = await getPhotoBuffer(app, candidate.ObjectKey);
    refPath = writeTemp(buf, extFor(candidate.Mime));
    const res = await app.zia().compareFace(fs.createReadStream(subjectPath), fs.createReadStream(refPath));
    const confidence = Number(res && res.confidence);
    return {
      candidate,
      confidence: Number.isFinite(confidence) ? confidence : null,
      matched: String(res && res.matched) === 'true'
    };
  } catch (e) {
    return { candidate, confidence: null, matched: false, error: String((e && e.message) || e).slice(0, 120) };
  } finally {
    rm(refPath);
  }
}

/** Bounded-concurrency map — Zia calls are the slow part of an identification. */
async function pooled(items, worker, size) {
  const out = [];
  let cursor = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await worker(items[i]);
    }
  });
  await Promise.all(runners);
  return out;
}

/* ------------------------------ gallery ------------------------------ */

/**
 * Shortlist reference photos worth comparing against. Filtering on attributes
 * Zia already gave us is what makes a 1:1-only API usable: gender alone halves
 * the work, and an age window cuts it again.
 */
async function shortlist(app, { gender, age, district, personName }) {
  const where = [];
  if (personName) where.push(`PersonName='${esc(personName)}'`);
  if (gender) where.push(`Gender='${esc(gender)}'`);
  if (age) where.push(`AgeYear>=${Math.max(0, age - 12)}`, `AgeYear<=${age + 12}`);
  if (district) where.push(`DistrictName='${esc(district)}'`);

  const cap = CANDIDATE_CAP();
  const build = (clauses) =>
    `SELECT PhotoID, PersonName, PersonID, AccusedMasterID, CaseMasterID, CrimeNo, DistrictName, Gender, AgeYear, RingID, ObjectKey, Mime FROM PersonPhotos${clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''} ORDER BY CREATEDTIME DESC LIMIT ${cap}`;

  let rows = await q(app, build(where));

  // Widening is for noisy ATTRIBUTE estimates — a wrong gender or age guess must
  // not produce a false "no record". It must NOT happen when a specific person was
  // named: "is this Suresh Kumar" is a question about one person, and quietly
  // comparing against the whole gallery could return somebody else as a candidate.
  // In a policing context that is not a degraded answer, it is a different answer.
  if (personName) return rows;

  if (!rows.length && where.length) rows = await q(app, build(district ? [`DistrictName='${esc(district)}'`] : []));
  if (!rows.length && district) rows = await q(app, build([]));
  return rows;
}

async function galleryCount(app) {
  try {
    const r = await q(app, 'SELECT COUNT(ROWID) FROM PersonPhotos');
    const v = r[0] && (r[0]['COUNT(ROWID)'] ?? Object.values(r[0])[0]);
    return Number(v) || 0;
  } catch (_) {
    return 0;
  }
}

/* ------------------------------ public operations ------------------------------ */

/**
 * Identify a person from a field photo against the enrolled gallery.
 * Returns bands, not verdicts.
 */
async function identifyPerson(app, { buffer, mime, district, personName }) {
  const face = await analyseFace(app, buffer, mime);
  if (!face.count) {
    return { kind: 'no_face', face };
  }
  if (face.count > 1) {
    // Comparing a group shot picks up whichever face dominates the frame, which
    // is exactly how a misidentification happens. Ask for a better photo.
    return { kind: 'multiple_faces', face };
  }

  const enrolled = await galleryCount(app);
  if (!enrolled) return { kind: 'empty_gallery', face, enrolled: 0 };

  const candidates = await shortlist(app, { gender: face.gender, age: face.age, district, personName });
  if (!candidates.length) return { kind: 'no_candidates', face, enrolled };

  const subjectPath = writeTemp(buffer, extFor(mime));
  let results;
  try {
    results = await pooled(candidates, (c) => compareOne(app, subjectPath, c), CONCURRENCY());
  } finally {
    rm(subjectPath);
  }

  const ranked = results
    .filter((r) => r.confidence != null && r.confidence >= POSSIBLE)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3)
    .map((r) => ({
      person: r.candidate.PersonName,
      personId: r.candidate.PersonID || null,
      crimeNo: r.candidate.CrimeNo || null,
      caseId: r.candidate.CaseMasterID || null,
      district: r.candidate.DistrictName || null,
      ring: Number(r.candidate.RingID) || 0,
      confidence: Math.round(r.confidence * 1000) / 1000,
      band: r.confidence >= STRONG ? 'strong' : 'possible'
    }));

  return {
    kind: ranked.length ? 'candidates' : 'no_match',
    face,
    enrolled,
    compared: candidates.length,
    candidates: ranked
  };
}

/**
 * Add a reference photo to the gallery, attached to a person in a real case.
 * The whole face capability depends on this, so it is a first-class action, and
 * it is the only write the field channel can make besides its own audit rows.
 */
async function enrollPhoto(app, { buffer, mime, personName, crimeNo, officer }) {
  const name = String(personName || '').trim();
  if (!name) throw new Error('a person name is required to enrol a photo');

  const face = await analyseFace(app, buffer, mime);
  if (!face.count) throw new Error('no face was detected in that image');
  if (face.count > 1) throw new Error('that image contains more than one face — enrol a single-person photo');

  // Anchor the photo to a real record where possible so a later match carries
  // case context rather than just a name.
  let link = {};
  if (crimeNo) {
    const rows = await q(app,
      `SELECT CaseMasterID, CrimeNo, DistrictName, StateName FROM Cases WHERE CrimeNo='${esc(crimeNo)}' LIMIT 1`);
    if (!rows.length) throw new Error(`no case found with CrimeNo ${crimeNo}`);
    link = rows[0];
  }
  const accused = await q(app,
    `SELECT AccusedMasterID, PersonID, AgeYear, Gender, RingID, DistrictName FROM Accused WHERE AccusedName='${esc(name)}'${link.CaseMasterID ? ` AND CaseMasterID=${Number(link.CaseMasterID)}` : ''} LIMIT 1`);
  const a = accused[0] || {};

  const photoId = genId('pht');
  const key = `gallery/${photoId}${extFor(mime)}`;
  await putPhoto(app, key, buffer);

  const row = {
    PhotoID: photoId,
    PersonName: name.slice(0, 160),
    PersonID: String(a.PersonID || '').slice(0, 80),
    AccusedMasterID: Number(a.AccusedMasterID) || 0,
    CaseMasterID: Number(link.CaseMasterID || 0) || 0,
    CrimeNo: String(link.CrimeNo || crimeNo || '').slice(0, 80),
    DistrictName: String(a.DistrictName || link.DistrictName || (officer && officer.district) || '').slice(0, 80),
    StateName: String(link.StateName || (officer && officer.state) || '').slice(0, 80),
    // Prefer the recorded age/gender; fall back to Zia's estimate so the
    // shortlist filter still has something to work with.
    Gender: String(a.Gender || face.gender || '').slice(0, 4),
    AgeYear: Number(a.AgeYear) || face.age || 0,
    RingID: Number(a.RingID) || 0,
    ObjectKey: key,
    Mime: String(mime || 'image/jpeg').slice(0, 60),
    Source: 'field-enrolment',
    EnrolledBy: String((officer && officer.name) || '').slice(0, 120),
    EnrolledByPhone: String((officer && officer.phone) || '').slice(0, 20),
    CreatedAt: dtNow()
  };
  await app.datastore().table('PersonPhotos').insertRow(row);

  return {
    photoId, objectKey: key, person: row.PersonName, crimeNo: row.CrimeNo || null,
    linkedRecord: Boolean(a.AccusedMasterID), district: row.DistrictName || null
  };
}

/**
 * Reverse an enrolment.
 *
 * The gallery row goes first: while it exists the photo is a live comparison
 * target, and that is the part the officer wants undone. A failure to delete the
 * stored object after that leaves an orphan blob, which is untidy but harmless —
 * so it does not fail the undo.
 */
async function deleteEnrollment(app, { photoId, objectKey }) {
  const id = esc(photoId);
  if (!id) throw new Error('photoId is required to reverse an enrolment');
  const rows = await q(app, `SELECT ROWID, ObjectKey FROM PersonPhotos WHERE PhotoID='${id}' LIMIT 1`);
  if (!rows.length) return { removed: false, reason: 'already gone' };
  await app.datastore().table('PersonPhotos').deleteRow(rows[0].ROWID);
  const key = objectKey || rows[0].ObjectKey;
  if (key) {
    try { await app.stratus().bucket(BUCKET()).deleteObject(key); } catch (_) { /* orphaned blob, not a failed undo */ }
  }
  return { removed: true, photoId };
}

/** OCR path: a photographed document, FIR, notice or plate — or a shared PDF. */
async function readDocument(app, { buffer, mime, language }) {
  const ocr = await runZiaOcr(app, {
    fileBase64: buffer.toString('base64'),
    filename: 'field' + docExtFor(mime),
    language
  });
  const text = String(ocr.text || '').trim();
  return { text: text.slice(0, 4000), confidence: ocr.confidence, engine: ocr.engine, identifiers: extractIdentifiers(text) };
}

/**
 * Pull the identifiers worth a database lookup out of OCR text. Deliberately
 * narrow: these patterns are handed to the agent as *candidates* to search, not
 * treated as facts.
 */
function extractIdentifiers(text) {
  const t = String(text || '');
  const uniq = (a) => [...new Set(a)].slice(0, 8);
  return {
    // Indian registration plates, with or without separators.
    vehicles: uniq((t.match(/\b[A-Z]{2}[\s-]?\d{1,2}[\s-]?[A-Z]{1,3}[\s-]?\d{1,4}\b/g) || []).map((v) => v.replace(/[\s-]/g, ''))),
    firNumbers: uniq(t.match(/\b\d{1,5}\s*\/\s*(?:19|20)\d{2}\b/g) || []),
    crimeNumbers: uniq(t.match(/\b(?:OCR|FIR|CR)[A-Z0-9-]{4,}\b/gi) || []),
    sections: uniq(t.match(/\b(?:BNS|IPC|NDPS|POCSO)\s*[\d/()A-Za-z.\s-]{1,20}/g) || []).map((s) => s.trim()),
    dates: uniq(t.match(/\b\d{1,2}[-/.]\d{1,2}[-/.](?:19|20)?\d{2}\b/g) || [])
  };
}

module.exports = {
  identifyPerson, enrollPhoto, deleteEnrollment, readDocument, analyseFace, extractIdentifiers,
  putPhoto, getPhotoBuffer, stashTurnPhoto, restoreTurnPhoto, galleryCount, STRONG, POSSIBLE
};
