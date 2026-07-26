import { lazy, Suspense, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, ROLES } from './api';
import EvidencePanel from './components/EvidencePanel';
import Composer from './components/Composer';
import { exportConversationPdf } from './lib/pdf';
import { speak } from './lib/voice';
import {
  AppShell, SideNav, SideNavHeading, SideNavItem, SideNavSection, TopNav,
  Stack, Grid, Heading, Text, Button, IconButton, Badge, Selector,
  SegmentedControl, SegmentedControlItem, ClickableCard, Spinner, Skeleton, Icon,
  StatusDot, Banner, Markdown, ChatLayout, ChatMessageList, ChatMessage, ChatMessageBubble,
  ShieldCheck, MessagesSquare, ChartNoAxesCombined, Radar, Search, FileText,
  Plus, Download, Network, Layers, Volume2, TriangleAlert, Sparkles, UserRound,
  Database, LockKeyhole, Globe,
} from './ui';

const Analytics = lazy(() => import('./components/Analytics'));
const EarlyWarning = lazy(() => import('./components/EarlyWarning'));
const CaseSupport = lazy(() => import('./components/CaseSupport'));
const Ingest = lazy(() => import('./components/Ingest'));
const Research = lazy(() => import('./components/Research'));

const NAV = [
  { id: 'chat', path: '/chat', label: 'Ask AI', icon: MessagesSquare, title: 'Intelligence assistant' },
  { id: 'analytics', path: '/analytics', label: 'Analytics', icon: ChartNoAxesCombined, title: 'Crime analytics' },
  { id: 'forecast', path: '/early-warning', label: 'Early Warning', icon: Radar, title: 'Early warning' },
  { id: 'casesupport', path: '/case-support', label: 'Case Support', icon: Search, title: 'Case support' },
  { id: 'research', path: '/research', label: 'Open Sources', icon: Globe, title: 'Open-source research' },
  { id: 'ingest', path: '/ingest', label: 'Ingest FIR', icon: FileText, title: 'FIR ingestion' },
];

const SUGGESTIONS = [
  { cat: 'Pattern discovery', q: 'Which 5 districts have the most cases and how many each?' },
  { cat: 'Offender profiling', q: 'List the top 10 highest-risk repeat offenders with their risk scores' },
  { cat: 'Criminal networks', q: 'Show the strongest co-accused links by number of shared cases' },
  { cat: 'Financial crime', q: 'Find the 10 largest suspicious financial transactions' },
  { cat: 'Crime trends', q: 'Break down cases by crime head' },
  { cat: 'Sociological insight', q: 'Which occupations appear most among complainants?' },
];

let uid = 0;
const newId = () => `m${++uid}_${Date.now()}`;
const cap = (r) => r[0].toUpperCase() + r.slice(1);

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const [role, setRole] = useState('investigator');
  const [language, setLanguage] = useState('en');
  const [sessions, setSessions] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [evidence, setEvidence] = useState(null);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [serviceState, setServiceState] = useState('checking');

  const navMeta = NAV.find((item) => item.path === location.pathname) || NAV[0];
  const view = navMeta.id;
  const active = sessions.find((session) => session.localId === activeId);
  const messages = active ? active.messages : [];

  useEffect(() => {
    if (!NAV.some((item) => item.path === location.pathname)) navigate('/chat', { replace: true });
  }, [location.pathname, navigate]);

  useEffect(() => {
    let current = true;
    api.health()
      .then(() => current && setServiceState('online'))
      .catch(() => current && setServiceState('offline'));
    return () => { current = false; };
  }, []);

  function goTo(item) {
    navigate(item.path);
    setEvidenceOpen(false);
  }

  function startSession() {
    const localId = newId();
    setSessions((prev) => [{ localId, serverId: null, title: 'New conversation', messages: [] }, ...prev]);
    setActiveId(localId);
    setEvidence(null);
    navigate('/chat');
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
          onClick={startSession}
        />
      }
      footer={
        <Stack gap={2} className="sidenav-role">
          <Selector
            label="Working access context" startIcon={<Icon icon={UserRound} size="sm" />}
            options={ROLES.map((r) => ({ value: r, label: cap(r) }))}
            value={role} onChange={(v) => setRole(v || 'investigator')} width="100%"
          />
          <Stack direction="horizontal" gap={1} vAlign="center">
            <Icon icon={LockKeyhole} size="xsm" color="tertiary" />
            <Text type="supporting" color="tertiary">Demo role · API enforced</Text>
          </Stack>
        </Stack>
      }
    >
      <SideNavSection title="Workspace">
        {NAV.map((n) => (
          <SideNavItem
            key={n.id} label={n.label} icon={<Icon icon={n.icon} size="sm" />}
            isSelected={view === n.id} onClick={() => goTo(n)}
          />
        ))}
      </SideNavSection>
      <SideNavSection title="Investigations">
        {sessions.length === 0 && (
          <div className="sidenav-empty"><Text type="supporting" color="tertiary">New conversations appear here</Text></div>
        )}
        {sessions.map((s) => (
          <SideNavItem
            key={s.localId} label={s.title} icon={<Icon icon={MessagesSquare} size="sm" />}
            isSelected={view === 'chat' && s.localId === activeId}
            onClick={() => { navigate('/chat'); setActiveId(s.localId); setEvidence(null); }}
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
          <span className="hide-md">
            <StatusDot
              variant={serviceState === 'online' ? 'success' : serviceState === 'offline' ? 'error' : 'neutral'}
              label={serviceState === 'online' ? 'Live data' : serviceState === 'offline' ? 'Service unavailable' : 'Connecting'}
            />
          </span>
        </Stack>
      }
      endContent={
        <Stack direction="horizontal" gap={2} vAlign="center">
          <SegmentedControl label="Response language" value={language} onChange={setLanguage} size="sm">
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
    <AppShell
      variant="elevated" height="fill" contentPadding={0} topNav={topNav} sideNav={sideNav}
      mobileNav={{ breakpoint: 'md' }}
      banner={serviceState === 'offline' ? (
        <Banner status="error" title="The intelligence service is unavailable. You can review the interface, but live actions may fail." />
      ) : undefined}
    >
      {view === 'analytics' ? (
        <div className="scroll-view"><Suspense fallback={<ViewLoader />}><Analytics role={role} /></Suspense></div>
      ) : view === 'forecast' ? (
        <div className="scroll-view"><Suspense fallback={<ViewLoader />}><EarlyWarning role={role} language={language} /></Suspense></div>
      ) : view === 'casesupport' ? (
        <div className="scroll-view"><Suspense fallback={<ViewLoader />}><CaseSupport role={role} language={language} /></Suspense></div>
      ) : view === 'research' ? (
        <div className="scroll-view"><Suspense fallback={<ViewLoader />}><Research role={role} /></Suspense></div>
      ) : view === 'ingest' ? (
        <div className="scroll-view">
          <Suspense fallback={<ViewLoader />}>
            <Ingest role={role} language={language}
              onAskAbout={(cn) => { navigate('/chat'); send('Show all details of the case with CrimeNo ' + cn); }} />
          </Suspense>
        </div>
      ) : (
        <div className="chat-split">
          <div className="chat-main">
            {messages.length === 0 ? (
              <div className="chat-welcome">
                <div className="chat-welcome-scroll"><Welcome onPick={send} /></div>
                <div className="chat-welcome-dock">
                  <Composer onSend={send} disabled={loading} language={language} role={role} />
                </div>
              </div>
            ) : (
              <ChatLayout
                density="spacious"
                composer={<Composer onSend={send} disabled={loading} language={language} role={role} />}
              >
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
                        {m.error ? (
                          <span className="bubble-error">
                            <Icon icon={TriangleAlert} size="sm" color="error" />
                            <Text color="error">{m.text}</Text>
                          </span>
                        ) : m.role === 'bot' ? (
                          <Markdown density="compact" headingLevelStart={3} contentWidth="100%">{m.text}</Markdown>
                        ) : (
                          <Text>{m.text}</Text>
                        )}
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
              </ChatLayout>
            )}
          </div>
          <EvidencePanel evidence={evidence} open={evidenceOpen} onClose={() => setEvidenceOpen(false)} />
        </div>
      )}
    </AppShell>
  );
}

function ViewLoader() {
  return (
    <div className="view" aria-label="Loading workspace">
      <Stack gap={3}>
        <Skeleton width={120} height={14} />
        <Skeleton width="42%" height={36} index={1} />
        <Skeleton width="68%" height={18} index={2} />
        <Grid columns={{ minWidth: 220, max: 3 }} gap={3}>
          {[0, 1, 2].map((index) => <Skeleton key={index} height={150} index={index + 3} />)}
        </Grid>
      </Stack>
    </div>
  );
}

function Welcome({ onPick }) {
  return (
    <div className="welcome-wrap">
      <Stack gap={5} maxWidth={900} width="100%">
        <Stack gap={2} className="welcome-copy">
          <Stack direction="horizontal" gap={1.5} vAlign="center" wrap="wrap">
            <Badge variant="info" icon={<Icon icon={Sparkles} size="xsm" />} label="Grounded AI" />
            <Badge variant="neutral" icon={<Icon icon={Database} size="xsm" />} label="Live KSP data" />
            <Badge variant="neutral" icon={<Icon icon={ShieldCheck} size="xsm" />} label="Traceable answers" />
          </Stack>
          <Heading level={1} type="display-2">From question to evidence.</Heading>
          <Text type="large" color="secondary">
            Investigate cases, patterns, networks, hotspots, and risk in plain language. Every data-backed answer exposes the query and records behind it.
          </Text>
        </Stack>
        <Stack gap={2}>
          <Text type="label" color="tertiary">START WITH A QUESTION</Text>
          <Grid columns={{ minWidth: 260, max: 2 }} gap={2} width="100%">
            {SUGGESTIONS.map((suggestion) => (
              <ClickableCard key={suggestion.q} label={suggestion.q} onClick={() => onPick(suggestion.q)}>
                <Stack gap={1.5}>
                  <Text type="supporting" color="accent" weight="semibold">{suggestion.cat}</Text>
                  <Text type="body">{suggestion.q}</Text>
                </Stack>
              </ClickableCard>
            ))}
          </Grid>
        </Stack>
      </Stack>
    </div>
  );
}
