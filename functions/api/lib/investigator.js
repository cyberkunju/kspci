'use strict';

/**
 * Investigator Decision Support (framework #6).
 * Given a CrimeNo, assembles a 360° case dossier from the Data Store:
 *   - full case record + accused / victims / complainant / arrests
 *   - investigation timeline (incident → registration → arrests → current status)
 *   - similar past cases (same modus operandi + district) with their outcomes,
 *     plus statewide disposition stats for that crime type (conviction/chargesheet rate)
 *   - an LLM-generated case summary + concrete investigative leads (grounded, cited)
 */

const { chatLLM, modelLabel } = require('./llm');

function flatten(row) {
  const out = {};
  for (const k of Object.keys(row)) {
    const v = row[k];
    if (v && typeof v === 'object') Object.assign(out, v);
    else out[k] = v;
  }
  return out;
}
const countOf = (r) => Number(r['COUNT(ROWID)'] ?? r.cnt ?? 0);
const esc = (s) => String(s == null ? '' : s).replace(/'/g, "");

async function q(app, query) {
  const res = await app.zcql().executeZCQLQuery(query);
  return (res || []).map(flatten);
}

async function caseSupport(app, { crimeNo, caseId, language = 'en' } = {}) {
  // 1) locate the case
  let cases = [];
  if (crimeNo) cases = await q(app, `SELECT * FROM Cases WHERE CrimeNo='${esc(crimeNo)}' LIMIT 1`);
  if (!cases.length && caseId) cases = await q(app, `SELECT * FROM Cases WHERE CaseMasterID=${Number(caseId) || 0} LIMIT 1`);
  if (!cases.length) return { error: 'case_not_found', crimeNo, caseId };
  const c = cases[0];
  const cid = Number(c.CaseMasterID);

  // 2) related entities
  const [accused, victims, complainants, arrests] = await Promise.all([
    q(app, `SELECT AccusedName, AgeYear, Gender, RingID FROM Accused WHERE CaseMasterID=${cid} LIMIT 30`),
    q(app, `SELECT VictimName, AgeYear, Gender FROM Victims WHERE CaseMasterID=${cid} LIMIT 30`),
    q(app, `SELECT ComplainantName, AgeYear, Gender, Occupation FROM Complainants WHERE CaseMasterID=${cid} LIMIT 10`),
    q(app, `SELECT AccusedName, ArrestType, ArrestDate, IOName FROM Arrests WHERE CaseMasterID=${cid} LIMIT 30`)
  ]);

  // 3) similar past cases (same MO + district) + statewide disposition for this crime type
  const sub = esc(c.CrimeSubHead), dist = esc(c.DistrictName);
  const [similar, disposition] = await Promise.all([
    q(app, `SELECT CrimeNo, DistrictName, CaseStatus, CrimeRegisteredDate, BriefFacts FROM Cases WHERE CrimeSubHead='${sub}' AND DistrictName='${dist}' ORDER BY CrimeRegisteredDate DESC LIMIT 12`),
    q(app, `SELECT CaseStatus, COUNT(ROWID) FROM Cases WHERE CrimeSubHead='${sub}' GROUP BY CaseStatus LIMIT 20`)
  ]);
  const dispTotal = disposition.reduce((s, r) => s + countOf(r), 0) || 1;
  const dispositionStats = disposition.map((r) => ({ status: r.CaseStatus, count: countOf(r), pct: Math.round((countOf(r) / dispTotal) * 100) }))
    .sort((a, b) => b.count - a.count);
  const convicted = dispositionStats.find((d) => d.status === 'Convicted');
  const chargesheeted = dispositionStats.find((d) => d.status === 'Chargesheet Filed');

  // 4) timeline
  const timeline = [];
  if (c.IncidentDate) timeline.push({ date: String(c.IncidentDate).slice(0, 10), event: 'Incident occurred', kind: 'incident' });
  if (c.CrimeRegisteredDate) timeline.push({ date: c.CrimeRegisteredDate, event: `FIR ${c.CrimeNo} registered at ${c.StationName}`, kind: 'fir' });
  arrests.forEach((a) => timeline.push({ date: a.ArrestDate, event: `${a.ArrestType}: ${a.AccusedName} (IO ${a.IOName})`, kind: 'arrest' }));
  timeline.push({ date: '', event: `Current status: ${c.CaseStatus}`, kind: 'status' });
  timeline.sort((a, b) => String(a.date).localeCompare(String(b.date)));

  // 5) LLM case summary + investigative leads (grounded)
  const ctx = {
    case: { CrimeNo: c.CrimeNo, head: c.CrimeHead, sub: c.CrimeSubHead, gravity: c.Gravity, district: c.DistrictName,
      station: c.StationName, acts: c.ActsSections, status: c.CaseStatus, registered: c.CrimeRegisteredDate, facts: c.BriefFacts },
    accused: accused.map((a) => `${a.AccusedName} (${a.Gender}, ${a.AgeYear}${a.RingID ? ', ring ' + a.RingID : ''})`),
    victims: victims.map((v) => `${v.VictimName} (${v.Gender}, ${v.AgeYear})`),
    arrests: arrests.map((a) => `${a.ArrestType} ${a.AccusedName}`),
    similarOutcomes: `${dispTotal} similar '${c.CrimeSubHead}' cases statewide — convicted ${convicted ? convicted.pct : 0}%, chargesheeted ${chargesheeted ? chargesheeted.pct : 0}%`
  };
  const sys = `You are a senior investigating officer's decision-support assistant for the Karnataka State Police. ` +
    `Using ONLY the provided case data, produce: (1) a crisp 3-4 sentence case summary, and (2) 3-5 concrete, ` +
    `prioritized investigative leads/next steps grounded in the facts, accused, ring links, and how similar cases ` +
    `were historically resolved. Be specific and practical. ${language === 'kn' ? 'Respond in Kannada.' : 'Respond in English.'} ` +
    `Return under 200 words. End with a one-line note that this is decision-support, not a directive.`;
  let brief = '';
  try {
    const out = await chatLLM(app, { messages: [{ role: 'system', content: sys }, { role: 'user', content: JSON.stringify(ctx) }], maxTokens: 650 });
    brief = out.content || '';
  } catch (e) { brief = ''; }

  return {
    case: c,
    accused, victims, complainants, arrests,
    timeline,
    similarCases: similar.map((s) => ({ crimeNo: s.CrimeNo, district: s.DistrictName, status: s.CaseStatus, date: s.CrimeRegisteredDate })),
    dispositionStats,
    outcomeInsight: { crimeType: c.CrimeSubHead, totalSimilar: dispTotal, convictionRate: convicted ? convicted.pct : 0, chargesheetRate: chargesheeted ? chargesheeted.pct : 0 },
    brief,
    model: modelLabel()
  };
}

module.exports = { caseSupport };
