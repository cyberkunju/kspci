import { useEffect, useRef, useState } from 'react';
import { api, ROLES } from './api';
import EvidencePanel from './components/EvidencePanel';
import Composer from './components/Composer';
import Analytics from './components/Analytics';
import EarlyWarning from './components/EarlyWarning';
import CaseSupport from './components/CaseSupport';
import Ingest from './components/Ingest';
import { exportConversationPdf } from './lib/pdf';
import { speak } from './lib/voice';
import {
  AppShell, SideNav, SideNavHeading, SideNavItem, SideNavSection, TopNav,
  Stack, StackItem, Grid, Heading, Text, Button, IconButton, Badge, Selector,
  SegmentedControl, SegmentedControlItem, ClickableCard, EmptyState, Spinner, Icon,
  ChatLayout, ChatMessageList, ChatMessage, ChatMessageBubble,
  ShieldCheck, MessagesSquare, ChartNoAxesCombined, Radar, Search, FileText,
  Plus, Download, Network, Layers, Volume2, TriangleAlert, Sparkles, UserRound,
} from './ui';

const NAV = [
  { id: 'chat', label: 'Ask AI', icon: MessagesSquare, title: 'Conversational Crime Intelligence' },
  { id: 'analytics', label: 'Analytics', icon: ChartNoAxesCombined, title: 'Crime Analytics & Intelligence' },
  { id: 'forecast', label: 'Early Warning', icon: Radar, title: 'Predictive Early-Warning Engine' },
  { id: 'casesupport', label: 'Case Support', icon: Search, title: 'Investigator Decision Support' },
  { id: 'ingest', label: 'Ingest FIR', icon: FileText, title: 'FIR Ingestion (OCR)' },
];

const SUGGESTIONS = [
  { cat: 'Pattern discovery', q: 'Which 5 districts have the most cases and how many each?' },
  { cat: 'Offender profiling', q: 'List the top 10 highest-risk repeat offenders with their risk scores' },
  { cat: 'Criminal networks', q: 'Show the strongest co-accused links by number of shared cases' },
  { cat: 'Financial crime', q: 'Find the 10 largest suspicious financial transactions' },
  { cat: 'Crime trends', q: 'Break down cases by crime head' },
  { cat: 'Sociological insight', q: 'Which occupations appear most among complainants?' },
];

function formatText(t) {
  const parts = String(t).split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) =>
    p.startsWith('**') && p.endsWith('**')
      ? <strong key={i}>{p.slice(2, -2)}</strong>
      : <span key={i}>{p}</span>);
}

let uid = 0;
const newId = () => `m${++uid}_${Date.now()}`;
const cap = (r) => r[0].toUpperCase() + r.slice(1);

export default function App() {
  const [role, setRole] = useState('investigator');
  const [view, setView] = useState('chat');
  const [language, setLanguage] = useState('en');
  const [sessions, setSessions] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [evidence, setEvidence] = useState(null);
  const [evidenceOpen, setEvidenceOpen] = useState(false);

  const active = sessions.find((s) => s.localId === activeId);
  const messages = active ? active.messages : [];
  const navMeta = NAV.find((n) => n.id === view) || NAV[0];

  function startSession() {
    const localId = newId();
    setSessions((prev) => [{ localId, serverId: null, title: 'New conversation', messages: [] }, ...prev]);
    setActiveId(localId);
    setEvidence(null);
    return localId;
  }
  function patchSession(localId, patch) {
    setSessions((prev) => prev.map((s) => s.localId === localId ? { ...s, ...patch(s) } : s));
  }

  async function send(question) {
    let localId = activeId;
    if (!localId) localId = startSession();
    const userMsg = { id: newId(), role: 'user', text: question };
    patchSession(localId, (s) => ({
      messages: [...s.messages, userMsg],
      title: s.messages.length === 0 ? question.slice(0, 42) : s.title,
    }));
    setLoading(true);
    try {
      const cur = sessions.find((s) => s.localId === localId);
      const resp = await api.chat({ question, sessionId: cur ? cur.serverId : null, language, role });
      const botMsg = {
        id: newId(), role: 'bot', text: resp.answer || '(no answer)',
        citations: resp.citations || [], zcql: resp.zcql, rationale: resp.rationale,
        rows: resp.rows || [], reasoning: resp.reasoning,
      };
      patchSession(localId, (s) => ({ serverId: resp.sessionId || s.serverId, messages: [...s.messages, botMsg] }));
      if (resp.zcql) setEvidence({ zcql: resp.zcql, rationale: resp.rationale, citations: resp.citations, rows: resp.rows, reasoning: resp.reasoning });
    } catch (e) {
      patchSession(localId, (s) => ({ messages: [...s.messages, { id: newId(), role: 'bot', text: e.message, error: true }] }));
    } finally {
      setLoading(false);
    }
  }

  const sideNav = (
    <SideNav
      header={
        <SideNavHeading
          icon={<span className="brand-mark"><Icon icon={ShieldCheck} size="md" color="accent" /></span>}
          heading="KSP Intelligence"
          subheading="Karnataka State Police"
        />
      }
      topContent={
        <Button
          label="New investigation" variant="primary" width="100%" icon={<Icon icon={Plus} size="sm" />}
          onClick={() => { setView('chat'); startSession(); }}
        />
      }
      footer={
        <div className="sidenav-role">
          <Selector
            label="Access role" startIcon={<Icon icon={UserRound} size="sm" />}
            options={ROLES.map((r) => ({ value: r, label: cap(r) }))}
            value={role} onChange={(v) => setRole(v || 'investigator')} width="100%"
          />
        </div>
      }
    >
      <SideNavSection title="Workspace">
        {NAV.map((n) => (
          <SideNavItem
            key={n.id} label={n.label} icon={<Icon icon={n.icon} size="sm" />}
            isSelected={view === n.id} onClick={() => setView(n.id)}
          />
        ))}
      </SideNavSection>
      <SideNavSection title="Conversations">
        {sessions.length === 0 && (
          <div className="sidenav-empty"><Text type="supporting" color="tertiary">No conversations yet</Text></div>
        )}
        {sessions.map((s) => (
          <SideNavItem
            key={s.localId} label={s.title} icon={<Icon icon={MessagesSquare} size="sm" />}
            isSelected={view === 'chat' && s.localId === activeId}
            onClick={() => { setView('chat'); setActiveId(s.localId); setEvidence(null); }}
          />
        ))}
      </SideNavSection>
    </SideNav>
  );

  const topNav = (
    <TopNav
      label="KSP Crime Intelligence"
      startContent={
        <Stack direction="horizontal" gap={2} vAlign="center" className="topnav-title">
          <Heading level={5} maxLines={1}>{navMeta.title}</Heading>
          {view === 'chat' && <span className="hide-md"><Badge variant="info" label="grounded · explainable · bilingual" /></span>}
        </Stack>
      }
      endContent={
        <Stack direction="horizontal" gap={2} vAlign="center">
          <SegmentedControl label="Language" value={language} onChange={setLanguage} size="sm">
            <SegmentedControlItem value="en" label="EN" />
            <SegmentedControlItem value="kn" label="ಕನ್ನಡ" />
          </SegmentedControl>
          {view === 'chat' && (
            <IconButton
              icon={<Icon icon={Download} size="sm" />} label="Export conversation as PDF"
              variant="secondary" isDisabled={messages.length === 0}
              onClick={() => exportConversationPdf({ messages, role, language })}
            />
          )}
          <span className="hide-sm"><Badge variant="neutral" label={cap(role)} /></span>
        </Stack>
      }
    />
  );

  return (
    <AppShell variant="elevated" height="fill" contentPadding={0} topNav={topNav} sideNav={sideNav}>
      {view === 'analytics' ? (
        <div className="scroll-view"><Analytics role={role} /></div>
      ) : view === 'forecast' ? (
        <div className="scroll-view"><EarlyWarning role={role} language={language} /></div>
      ) : view === 'casesupport' ? (
        <div className="scroll-view"><CaseSupport role={role} language={language} /></div>
      ) : view === 'ingest' ? (
        <div className="scroll-view">
          <Ingest role={role} language={language}
            onAskAbout={(cn) => { setView('chat'); send('Show all details of the case with CrimeNo ' + cn); }} />
        </div>
      ) : (
        <Stack direction="horizontal" gap={0} height="100%" vAlign="stretch" className="chat-split">
          <StackItem size="fill">
            <ChatLayout
              density="spacious"
              composer={<Composer onSend={send} disabled={loading} language={language} role={role} />}
              emptyState={<Welcome onPick={send} />}
            >
              {messages.length > 0 && (
                <ChatMessageList isStreaming={loading}>
                  {messages.map((m) => (
                    <ChatMessage
                      key={m.id}
                      sender={m.role === 'user' ? 'user' : 'assistant'}
                      avatar={<span className={`msg-avatar ${m.role}`}><Icon icon={m.role === 'user' ? UserRound : ShieldCheck} size="sm" /></span>}
                      name={m.role === 'user' ? 'You' : 'KSP Intelligence'}
                    >
                      <ChatMessageBubble
                        variant={m.role === 'user' ? 'filled' : 'ghost'}
                        metadata={m.role === 'bot' && !m.error ? (
                          <Stack direction="horizontal" gap={1.5} wrap="wrap" vAlign="center">
                            {(m.citations || []).length > 0 && <Badge variant="info" icon={<Icon icon={Network} size="xsm" />} label={`${m.citations.length} cited`} />}
                            {m.zcql && <Badge variant="neutral" icon={<Icon icon={Layers} size="xsm" />} label="ZCQL" />}
                            <Button label="Speak" size="sm" variant="ghost" icon={<Icon icon={Volume2} size="sm" />} onClick={() => speak({ text: m.text, language, role })} />
                            {(m.rows || []).length > 0 && (
                              <Button label="Evidence" size="sm" variant="ghost" icon={<Icon icon={ChartNoAxesCombined} size="sm" />}
                                onClick={() => { setEvidence({ zcql: m.zcql, rationale: m.rationale, citations: m.citations, rows: m.rows, reasoning: m.reasoning }); setEvidenceOpen(true); }} />
                            )}
                          </Stack>
                        ) : undefined}
                      >
                        <span className={m.error ? 'bubble-error' : ''}>
                          {m.error && <Icon icon={TriangleAlert} size="sm" color="error" />} {formatText(m.text)}
                        </span>
                      </ChatMessageBubble>
                    </ChatMessage>
                  ))}
                  {loading && (
                    <ChatMessage sender="assistant" name="KSP Intelligence"
                      avatar={<span className="msg-avatar bot"><Icon icon={ShieldCheck} size="sm" /></span>}>
                      <ChatMessageBubble variant="ghost">
                        <Stack direction="horizontal" gap={2} vAlign="center">
                          <Spinner size="sm" /><Text type="supporting" color="secondary">Analysing the crime database…</Text>
                        </Stack>
                      </ChatMessageBubble>
                    </ChatMessage>
                  )}
                </ChatMessageList>
              )}
            </ChatLayout>
          </StackItem>
          <EvidencePanel evidence={evidence} open={evidenceOpen} onClose={() => setEvidenceOpen(false)} />
        </Stack>
      )}
    </AppShell>
  );
}

function Welcome({ onPick }) {
  return (
    <div className="welcome-wrap">
      <Stack gap={3} hAlign="center" maxWidth={760}>
        <Badge variant="info" icon={<Icon icon={Sparkles} size="xsm" />} label="Agentic · grounded · bilingual" />
        <Heading level={1} type="display-2" justify="center">Query the crime database in plain language</Heading>
        <Text type="large" color="secondary" justify="center">
          Natural-language access to FIRs, accused, victims, networks, hotspots and risk — grounded in data,
          every answer traceable to source records. English &amp; ಕನ್ನಡ, voice-enabled.
        </Text>
        <Grid columns={{ minWidth: 260, max: 2 }} gap={3} width="100%">
          {SUGGESTIONS.map((s, i) => (
            <ClickableCard key={i} label={s.q} onClick={() => onPick(s.q)}>
              <Stack gap={1.5}>
                <Text type="supporting" color="accent" weight="semibold">{s.cat.toUpperCase()}</Text>
                <Text type="body">{s.q}</Text>
              </Stack>
            </ClickableCard>
          ))}
        </Grid>
      </Stack>
    </div>
  );
}
