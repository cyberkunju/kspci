// Generates a minimal valid single-page PDF FIR for testing OCR ingestion.
const fs = require('fs');
const lines = [
  'KARNATAKA STATE POLICE',
  'First Information Report (FIR)',
  '',
  'District: Bengaluru City',
  'Police Station: Koramangala PS',
  'FIR No / Crime No: 104430006202600457',
  'Date of Registration: 2026-05-14',
  'Acts and Sections: IPC 392 (Robbery), IPC 34',
  'Complainant: Suresh Gowda, age 42, Business',
  'Accused: 1. Ravi Shetty   2. Imran Bhat',
  'Crime Head: Property Offences - Robbery',
  '',
  'Brief Facts: On the night of 13th May 2026, two men on a',
  'motorcycle intercepted the complainant near 5th Block',
  'Koramangala, threatened him with a knife, and robbed a gold',
  'chain and cash of Rs 45,000. CCTV footage collected.',
  'Investigation is in progress.'
];
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
let content = 'BT /F1 13 Tf 50 760 Td 16 TL\n';
lines.forEach((l, i) => { content += (i ? 'T* ' : '') + '(' + esc(l) + ') Tj\n'; });
content += 'ET';

const objs = [];
objs.push('<</Type/Catalog/Pages 2 0 R>>');
objs.push('<</Type/Pages/Kids[3 0 R]/Count 1>>');
objs.push('<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>');
objs.push('<</Length ' + Buffer.byteLength(content) + '>>\nstream\n' + content + '\nendstream');
objs.push('<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>');

let pdf = '%PDF-1.4\n';
const offsets = [];
objs.forEach((o, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'; });
const xrefPos = Buffer.byteLength(pdf);
pdf += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n';
offsets.forEach((off) => { pdf += String(off).padStart(10, '0') + ' 00000 n \n'; });
pdf += 'trailer\n<</Size ' + (objs.length + 1) + '/Root 1 0 R>>\nstartxref\n' + xrefPos + '\n%%EOF';

fs.writeFileSync(__dirname + '/../test_fir.pdf', Buffer.from(pdf, 'latin1'));
console.log('wrote test_fir.pdf', Buffer.byteLength(pdf), 'bytes');
