import { useRef, useState } from 'react';
import { api } from '../api';
import {
  Grid, Stack, Heading, Text, Badge, Button, Banner, Spinner, Icon,
  FileUp, Upload, MessagesSquare, FileText,
} from '../ui';
import { VizCard } from './Cards';

// OCR-based FIR ingestion (the differentiator): upload a scanned FIR (image/PDF) →
// Catalyst Zia OCR (EN + Kannada, native Catalyst) → LLM structures the fields →
// inserted into the Data Store so it's instantly queryable by the chat & analytics.
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

const FIELDS = [
  ['DistrictName', 'District'], ['StationName', 'Police station'], ['CrimeHead', 'Crime head'],
  ['CrimeSubHead', 'Crime sub-head'], ['IncidentDate', 'Incident date'], ['ComplainantName', 'Complainant'],
  ['ActsSections', 'Acts & sections'], ['Gravity', 'Gravity'], ['CaseCategory', 'Category'],
];

export default function Ingest({ role, language, onAskAbout }) {
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  const run = async () => {
    if (!file) return;
    setBusy(true); setError(null); setResult(null);
    try {
      const fileBase64 = await fileToBase64(file);
      const out = await api.ingestOcr({ fileBase64, filename: file.name, language, role });
      setResult(out);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const s = result?.structured || {};

  return (
    <div className="view view-narrow">
      <Stack gap={1} className="view-head">
        <Heading level={3}>Ingest a scanned FIR</Heading>
        <Text type="body" color="secondary">
          Upload a scanned FIR (image or PDF). Catalyst Zia OCR reads it — in English or Kannada — then it's
          structured and added to the crime database, instantly queryable by the AI and analytics.
        </Text>
      </Stack>

      <div className="ingest-drop" onClick={() => inputRef.current?.click()}>
        <input ref={inputRef} type="file" accept="image/*,application/pdf" style={{ display: 'none' }}
          onChange={(e) => { setFile(e.target.files[0]); setResult(null); setError(null); }} />
        <Stack gap={2} hAlign="center">
          <Icon icon={FileUp} size="lg" color="accent" />
          <Text type="body" weight="semibold">{file ? file.name : 'Click to choose a FIR image or PDF'}</Text>
          {file && <Text type="supporting" color="success">{Math.round(file.size / 1024)} KB · ready</Text>}
        </Stack>
      </div>

      <Stack direction="horizontal" gap={2} vAlign="center">
        <Button label={busy ? 'Reading with Zia OCR…' : 'Extract & ingest'} variant="primary"
          isDisabled={!file} isLoading={busy} icon={<Icon icon={Upload} size="sm" />} onClick={run} />
        {busy && <Text type="supporting" color="tertiary">OCR + structuring can take up to a minute for a scanned page…</Text>}
      </Stack>

      {error && <Banner status="error" title={error} />}

      {result && (
        <Stack gap={3}>
          {result.inserted && result.inserted.crimeNo && (
            <Banner status="success" title={`Added to the crime database as ${result.inserted.crimeNo}`}
              endContent={<Button label="Ask the AI about this FIR" variant="secondary" size="sm"
                icon={<Icon icon={MessagesSquare} size="sm" />} onClick={() => onAskAbout && onAskAbout(result.inserted.crimeNo)} />} />
          )}
          <Grid columns={{ minWidth: 360, max: 2 }} gap={3}>
            <VizCard title="Extracted fields">
              <table className="kv-table">
                <tbody>
                  {FIELDS.map(([k, label]) => (
                    <tr key={k}><td className="kv-key"><Text type="supporting" color="secondary">{label}</Text></td><td><Text type="body">{s[k] || '—'}</Text></td></tr>
                  ))}
                  <tr><td className="kv-key"><Text type="supporting" color="secondary">Accused</Text></td><td><Text type="body">{(s.AccusedNames || []).join(', ') || '—'}</Text></td></tr>
                </tbody>
              </table>
              {s.BriefFacts && <><br /><Text type="body" color="secondary"><b>Brief facts:</b> {s.BriefFacts}</Text></>}
            </VizCard>
            <VizCard title="Raw OCR text" action={<Badge variant="info" icon={<Icon icon={FileText} size="xsm" />} label="Zia OCR" />}>
              <pre className="code-block ocr-raw">{result.text}</pre>
            </VizCard>
          </Grid>
        </Stack>
      )}
    </div>
  );
}
