import { useState } from 'react';
import { api } from '../api';
import {
  Grid, Stack, Text, Badge, Button, Banner, Icon, FileInput, TextInput, TextArea,
  Collapsible, FileSearch, Database, MessagesSquare, FileText, RefreshCw, CircleCheckBig,
} from '../ui';
import { PageHeader, VizCard } from './Cards';

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const FIELDS = [
  ['DistrictName', 'District'], ['StationName', 'Police station'], ['CrimeHead', 'Crime head'],
  ['CrimeSubHead', 'Crime sub-head'], ['IncidentDate', 'Incident date'], ['ComplainantName', 'Complainant'],
  ['ActsSections', 'Acts & sections'], ['Gravity', 'Gravity'], ['CaseCategory', 'Category'],
];

const REQUIRED_FIELDS = new Set(['DistrictName', 'StationName', 'CrimeHead']);

function formatConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 'OCR extracted';
  return `${Math.round(Math.max(0, Math.min(100, number <= 1 ? number * 100 : number)))}% OCR confidence`;
}

export default function Ingest({ role, language, onAskAbout }) {
  const [file, setFile] = useState(null);
  const [phase, setPhase] = useState('select');
  const [result, setResult] = useState(null);
  const [draft, setDraft] = useState({});
  const [error, setError] = useState(null);
  const isRestricted = role === 'policymaker';
  const busy = phase === 'extracting' || phase === 'saving';
  const hasRequiredFields = [...REQUIRED_FIELDS].every((key) => String(draft[key] || '').trim());

  const selectFile = (nextFile) => {
    setFile(nextFile);
    setResult(null);
    setDraft({});
    setError(null);
    setPhase('select');
  };

  const extract = async () => {
    if (!file) return;
    setPhase('extracting');
    setError(null);
    try {
      const fileBase64 = await fileToBase64(file);
      const output = await api.extractOcr({ fileBase64, filename: file.name, language, role });
      setResult(output);
      setDraft({ ...output.structured, AccusedNames: output.structured?.AccusedNames || [] });
      setPhase('review');
    } catch (e) {
      setError(e.message);
      setPhase('select');
    }
  };

  const confirm = async () => {
    if (!hasRequiredFields) return;
    setPhase('saving');
    setError(null);
    try {
      const output = await api.confirmIngest({ structured: draft, text: result?.text || '', role });
      setResult((current) => ({ ...current, inserted: output.inserted }));
      setPhase('complete');
    } catch (e) {
      setError(e.message);
      setPhase('review');
    }
  };

  const update = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
  const reset = () => { setFile(null); setResult(null); setDraft({}); setError(null); setPhase('select'); };

  return (
    <div className="view view-narrow">
      <PageHeader
        eyebrow="DOCUMENT INTAKE"
        title="Review every FIR before it enters the database"
        description="Extract English or Kannada scans with Zia OCR, verify the structured fields, then explicitly confirm the database write."
        badge="Human-in-the-loop"
      />

      <Stack direction="horizontal" gap={1.5} wrap="wrap" aria-label="Ingestion progress">
        <Badge variant={phase === 'select' || phase === 'extracting' ? 'info' : 'success'} label="1 · Select & extract" />
        <Badge variant={phase === 'review' || phase === 'saving' ? 'info' : phase === 'complete' ? 'success' : 'neutral'} label="2 · Review fields" />
        <Badge variant={phase === 'complete' ? 'success' : 'neutral'} label="3 · Confirm ingest" />
      </Stack>

      {isRestricted && (
        <Banner status="warning" title="The policymaker role is read-only. Switch to an operational role to ingest FIRs." />
      )}
      {error && <Banner status="error" title="This step could not be completed" description={error} />}

      {phase !== 'complete' && (
        <VizCard title="Source document" note="The selected file stays in this browser until you start extraction.">
          <FileInput
            label="FIR scan"
            value={file}
            onChange={selectFile}
            accept="image/*,.pdf,application/pdf"
            maxSize={10 * 1024 * 1024}
            mode="dropzone"
            description="PDF, PNG, or JPEG · maximum 10 MB · English or Kannada"
            placeholder="Drop an FIR scan here or choose a file"
            isDisabled={busy || isRestricted}
            disabledMessage={isRestricted ? 'This role cannot ingest FIRs.' : undefined}
            isLoading={phase === 'extracting'}
            status={file && phase === 'select' ? { type: 'success', message: `${file.name} is ready for extraction` } : undefined}
          />
          {phase === 'select' || phase === 'extracting' ? (
            <Stack direction="horizontal" gap={2} vAlign="center" wrap="wrap">
              <Button
                label={phase === 'extracting' ? 'Extracting fields…' : 'Extract fields'}
                variant="primary" isDisabled={!file || isRestricted} isLoading={phase === 'extracting'}
                icon={<Icon icon={FileSearch} size="sm" />} onClick={extract}
              />
              <Text type="supporting" color="tertiary">Extraction does not write to the crime database.</Text>
            </Stack>
          ) : null}
        </VizCard>
      )}

      {(phase === 'review' || phase === 'saving') && (
        <Stack gap={3}>
          <Banner
            status="warning"
            title="Verify the extracted fields"
            description="OCR can misread names, dates, and legal sections. Your confirmation creates a new case record."
          />
          <VizCard title="Structured FIR fields" action={<Badge variant="info" label={formatConfidence(result?.confidence)} />}>
            <Grid columns={{ minWidth: 260, max: 2 }} gap={3}>
              {FIELDS.map(([key, label]) => (
                <TextInput
                  key={key} label={label} value={draft[key] || ''} onChange={(value) => update(key, value)} width="100%"
                  isRequired={REQUIRED_FIELDS.has(key)}
                  status={REQUIRED_FIELDS.has(key) && !String(draft[key] || '').trim() ? { type: 'error', message: `${label} is required` } : undefined}
                />
              ))}
            </Grid>
            <TextInput
              label="Accused names" value={(draft.AccusedNames || []).join(', ')} width="100%"
              description="Separate multiple names with commas."
              onChange={(value) => update('AccusedNames', value.split(',').map((name) => name.trim()).filter(Boolean))}
            />
            <TextArea
              label="Brief facts" value={draft.BriefFacts || ''} onChange={(value) => update('BriefFacts', value)}
              description="Review for OCR mistakes and sensitive-data accuracy before ingesting." rows={5}
            />
          </VizCard>

          <Collapsible trigger={<Stack direction="horizontal" gap={1.5} vAlign="center"><Icon icon={FileText} size="sm" /><Text weight="semibold">Compare with raw OCR text</Text></Stack>} defaultIsOpen={false}>
            <pre className="code-block ocr-raw">{result?.text}</pre>
          </Collapsible>

          <Stack direction="horizontal" gap={2} vAlign="center" wrap="wrap" className="sticky-actions">
            <Button
              label={phase === 'saving' ? 'Adding case…' : 'Confirm & add case'} variant="primary"
              isDisabled={!hasRequiredFields} isLoading={phase === 'saving'} icon={<Icon icon={Database} size="sm" />} onClick={confirm}
            />
            <Button label="Start over" variant="secondary" isDisabled={phase === 'saving'} icon={<Icon icon={RefreshCw} size="sm" />} onClick={reset} />
            <Text type="supporting" color="tertiary">This action creates a new case and accused records.</Text>
          </Stack>
        </Stack>
      )}

      {phase === 'complete' && result?.inserted?.crimeNo && (
        <Stack gap={4} className="success-panel">
          {(result.inserted.warnings || []).map((warning) => (
            <Banner key={warning} status="warning" title="Case created with a follow-up needed" description={warning} />
          ))}
          <Icon icon={CircleCheckBig} size="lg" color="success" />
          <Stack gap={1}>
            <Text type="label" color="success">INGESTION COMPLETE</Text>
            <Text type="large" weight="bold">Case {result.inserted.crimeNo} is now available</Text>
            <Text color="secondary">The reviewed FIR is queryable in the assistant, analytics, and case-support workflows.</Text>
          </Stack>
          <Stack direction="horizontal" gap={2} wrap="wrap">
            <Button label="Ask AI about this FIR" variant="primary" icon={<Icon icon={MessagesSquare} size="sm" />} onClick={() => onAskAbout?.(result.inserted.crimeNo)} />
            <Button label="Ingest another FIR" variant="secondary" icon={<Icon icon={RefreshCw} size="sm" />} onClick={reset} />
          </Stack>
        </Stack>
      )}
    </div>
  );
}
