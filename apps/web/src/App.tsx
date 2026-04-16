import { useState, useEffect, useCallback, useRef } from "react";

// ── Types ──────────────────────────────────────────────────────────────────────
interface Health {
  status: "ok" | "degraded";
  services: { db: "ok" | "error"; redis: "ok" | "error" };
}
interface RetrievedChunk {
  chunk_id: string;
  doc_id: string;
  source_url: string;
  content: string;
  rrf_score: number;
  rerank_score: number | null;
}
interface QueryResult {
  queryId: string;
  query: string;
  intent: string;
  plan_type: string;
  chunks: RetrievedChunk[];
  chunk_count: number;
  latency_ms: number;
}
interface IngestResult {
  jobId: string;
  documentId: string;
  status: string;
}

type SseEventType = "thought" | "tool_call" | "tool_result" | "governance" | "chunk" | "done";

interface AgentEvent {
  id: string;
  type: SseEventType;
  data: Record<string, unknown>;
  ts: number;
}

interface DemoScenario {
  title: string;
  badge: string;
  badgeColor: string;
  description: string;
  query: string;
  icon: string;
  pathType: "pipeline" | "agentic";
}

// ── Constants ──────────────────────────────────────────────────────────────────
const API = "/api";
const TEST_TENANT = "00000000-0000-0000-0000-000000000001";

const DEMO_SCENARIOS: DemoScenario[] = [
  {
    icon: "📋",
    title: "Data Retention Policy",
    badge: "Pipeline · single_intent",
    badgeColor: "#00bcd4",
    pathType: "pipeline",
    description:
      "Hybrid RRF search + BGE reranking. GovernanceIntercept2 scans merged context for PII before synthesis.",
    query:
      "What is our customer PII data retention policy, including backup schedules, deletion timelines, and who owns enforcement?",
  },
  {
    icon: "⚖️",
    title: "SOC2 vs ISO27001 Gap Analysis",
    badge: "Agentic · cross_system",
    badgeColor: "#7c4dff",
    pathType: "agentic",
    description:
      "Agent calls Jira and Confluence in parallel, then synthesizes a cross-framework comparison with live governance intercepts.",
    query:
      "Compare our SOC2 Type II evidence handling with ISO27001 Annex A controls and surface any open Jira compliance gap tickets.",
  },
  {
    icon: "🚨",
    title: "Breach Notification Walkthrough",
    badge: "Agentic · complex_multi_step",
    badgeColor: "#f44336",
    pathType: "agentic",
    description:
      "Multi-hop agent loop: plans steps, retrieves runbooks, resolves regulatory timelines. Hard-capped at 5 iterations.",
    query:
      "Walk me through our data breach notification process step by step — include the GDPR 72-hour timeline, responsible teams, and link relevant Confluence runbooks.",
  },
];

// ── Event display metadata ─────────────────────────────────────────────────────
const EVENT_META: Record<SseEventType, { icon: string; color: string; bg: string; label: string }> = {
  thought:     { icon: "◈", color: "#64b5f6", bg: "#050e1a",  label: "Thinking"   },
  tool_call:   { icon: "⚡", color: "#ffd54f", bg: "#120d00",  label: "Action"     },
  tool_result: { icon: "◉", color: "#69f0ae", bg: "#001608",  label: "Result"     },
  governance:  { icon: "◆", color: "#ff9800", bg: "#170800",  label: "Security"   },
  chunk:       { icon: "▸", color: "#80deea", bg: "transparent", label: "Answer"  },
  done:        { icon: "✓", color: "#69f0ae", bg: "#001608",  label: "Done"       },
};

// ── Helpers ────────────────────────────────────────────────────────────────────
function authHeaders(token: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

function StatusDot({ ok, pulse = false }: { ok: boolean; pulse?: boolean }) {
  return (
    <span style={{ position: "relative", display: "inline-flex", alignItems: "center", marginRight: 6 }}>
      <span className={`dot ${ok ? "pass" : "fail"}`} style={{ display: "inline-block" }} />
      {ok && pulse && <span className="dot-pulse" />}
    </span>
  );
}

function ConfidenceMeter({ value, max = 1 }: { value: number; max?: number }) {
  const pct = Math.min(100, Math.round((value / max) * 100));
  const color = pct >= 70 ? "#69f0ae" : pct >= 40 ? "#ffd54f" : "#ef9a9a";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div style={{ flex: 1, height: 5, background: "#0d1f2a", borderRadius: 3, overflow: "hidden" }}>
        <div style={{
          width: `${pct}%`, height: "100%", background: color,
          borderRadius: 3, transition: "width 0.5s ease",
        }} />
      </div>
      <span style={{ fontSize: "0.68rem", color, minWidth: 30, textAlign: "right" }}>{pct}%</span>
    </div>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** Convert a raw SSE event into a human-readable terminal line. */
function narrateEvent(ev: AgentEvent): string {
  switch (ev.type) {
    case "thought": {
      const content = String(ev.data.content ?? "");
      const iter = ev.data.iteration ? `[iter ${String(ev.data.iteration)}] ` : "";
      return iter + truncate(content, 160);
    }
    case "tool_call": {
      const args = (ev.data.args ?? {}) as Record<string, unknown>;
      const argStr = Object.entries(args)
        .map(([k, v]) => `${k}="${truncate(String(v), 35)}"`)
        .join(", ");
      return `Calling ${String(ev.data.tool ?? "")}(${argStr})`;
    }
    case "tool_result": {
      const r = ev.data.result;
      const count = Array.isArray(r) ? r.length : 1;
      return `${String(ev.data.tool ?? "")} returned ${count} result${count !== 1 ? "s" : ""}`;
    }
    case "governance": {
      const types = (ev.data.pattern_types as string[] | undefined) ?? [];
      const tool = ev.data.tool ? ` from ${String(ev.data.tool)}` : "";
      return `PII intercepted${tool}${types.length ? ` [${types.join(", ")}]` : ""} — context redacted`;
    }
    case "done":
      return `Complete · reason=${String(ev.data.reason ?? "")} · ${String(ev.data.iterations ?? "?")} iterations`;
    default:
      return "";
  }
}

/** Render answer text with amber REDACTED tokens and teal citation links. */
function renderWithHighlights(text: string): React.ReactNode[] {
  const parts = text.split(/(\[REDACTED:[^\]]*\]|\[Doc #\d+\])/g);
  return parts.map((part, i) => {
    if (/^\[REDACTED:/.test(part)) {
      return <span key={i} className="redacted-token">{part}</span>;
    }
    if (/^\[Doc #/.test(part)) {
      return <span key={i} className="citation-token">{part}</span>;
    }
    return <span key={i}>{part}</span>;
  });
}

// ── Inline CSS ─────────────────────────────────────────────────────────────────
const DEMO_CSS = `
/* ── Keyframes ── */
@keyframes pulse-ring {
  0%   { transform: scale(1); opacity: 0.7; }
  70%  { transform: scale(1.9); opacity: 0; }
  100% { transform: scale(1.9); opacity: 0; }
}
@keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
@keyframes fadeSlideIn {
  from { opacity: 0; transform: translateX(-6px); }
  to   { opacity: 1; transform: translateX(0); }
}
@keyframes govGlow {
  0%,100% { box-shadow: 0 0 0px 0px #ff980000, inset 0 0 0px #ff980000; }
  40%     { box-shadow: 0 0 18px 4px #ff980055, inset 0 0 30px #ff980010; }
}
@keyframes scanline {
  0%   { top: -3px; opacity: 1; }
  100% { top: calc(100% + 3px); opacity: 0; }
}
@keyframes kpiTokenPulse {
  0%,100% { box-shadow: 0 0 0 0 #1fa8c910; }
  50%     { box-shadow: 0 0 14px 3px #1fa8c930; }
}

/* ── Status dot pulse ring ── */
.dot-pulse {
  position: absolute;
  width: 10px; height: 10px;
  border-radius: 50%;
  background: #1fa8c9;
  animation: pulse-ring 2s ease-out infinite;
  left: -1px; top: -1px;
  pointer-events: none;
}

/* ── Cursor blink ── */
.cursor-blink { animation: blink 1s step-end infinite; }

/* ── KPI token-active glow ── */
.kpi-token-active { animation: kpiTokenPulse 2.5s ease-in-out infinite; }

/* ── Demo section wrapper ── */
.demo-section { padding: 0 24px 32px; max-width: 1400px; margin: 0 auto; }

/* ── Scenario picker ── */
.demo-scenario-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 14px;
  margin-bottom: 20px;
}
@media (max-width: 900px) { .demo-scenario-grid { grid-template-columns: 1fr; } }

.scenario-card {
  border: 1px solid var(--line, #1c3040);
  border-radius: 14px;
  padding: 16px 18px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s, box-shadow 0.15s;
  background: #0b1922;
}
.scenario-card:hover { border-color: var(--brand, #1fa8c9); background: #0d1f2d; }
.scenario-card.selected {
  border-color: var(--brand, #1fa8c9);
  background: #0d2230;
  box-shadow: 0 0 0 1px var(--brand, #1fa8c9), 0 0 22px #1fa8c918;
}
.scenario-icon { font-size: 1.5rem; margin-bottom: 8px; }
.scenario-title { font-size: 0.95rem; font-weight: 600; color: #d6e9ef; margin: 0 0 4px; }
.scenario-desc { font-size: 0.77rem; color: var(--muted, #5b8899); line-height: 1.5; margin: 0; }

/* ── Path badge ── */
.path-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 20px;
  font-size: 0.68rem;
  font-weight: 600;
  letter-spacing: 0.03em;
  margin-left: 8px;
  vertical-align: middle;
}

/* ── 3-col agent workspace: Pulse | Shield | Hero ── */
.agent-workspace {
  display: grid;
  grid-template-columns: 5fr 4fr 7fr;
  gap: 14px;
  margin-top: 16px;
}
@media (max-width: 1100px) { .agent-workspace { grid-template-columns: 1fr 1fr; } }
@media (max-width: 700px)  { .agent-workspace { grid-template-columns: 1fr; } }

/* ── Agent Pulse terminal ── */
.trace-feed {
  border: 1px solid #162838;
  border-radius: 14px;
  background: #03080d;
  padding: 12px;
  min-height: 380px;
  max-height: 540px;
  overflow-y: auto;
  font-family: "SF Mono", "Fira Code", "JetBrains Mono", monospace;
  font-size: 0.73rem;
  transition: border-color 0.4s, box-shadow 0.4s;
}
.trace-feed.gov-active {
  border-color: #ff980070;
  box-shadow: 0 0 16px #ff980030;
}
.trace-empty {
  color: #1e3a4a;
  font-size: 0.8rem;
  padding: 24px 12px;
  text-align: center;
  line-height: 1.7;
}
.trace-row {
  display: flex;
  gap: 7px;
  align-items: flex-start;
  padding: 6px 8px;
  border-radius: 7px;
  margin-bottom: 2px;
  animation: fadeSlideIn 0.22s ease forwards;
}
.trace-ts    { flex-shrink: 0; width: 36px; font-size: 0.62rem; opacity: 0.3; padding-top: 2px; }
.trace-icon  { flex-shrink: 0; width: 14px; text-align: center; font-size: 0.78rem; }
.trace-label {
  flex-shrink: 0; width: 64px;
  font-size: 0.64rem; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.05em;
  opacity: 0.65; padding-top: 2px;
}
.trace-content { flex: 1; word-break: break-word; line-height: 1.55; color: #8ab8ca; }

/* ── Governance Shield panel ── */
.shield-panel {
  border: 1px solid #162838;
  border-radius: 14px;
  background: #04090e;
  padding: 14px;
  min-height: 380px;
  max-height: 540px;
  overflow-y: auto;
  position: relative;
  transition: border-color 0.3s, box-shadow 0.3s;
}
.shield-panel.gov-fired {
  border-color: #ff9800aa;
  animation: govGlow 1.8s ease 2;
}
.scanline-bar {
  position: absolute;
  left: 0; right: 0; top: 0;
  height: 2px;
  background: linear-gradient(90deg, transparent 0%, #ff9800cc 50%, transparent 100%);
  animation: scanline 1s linear 3;
  pointer-events: none;
  z-index: 3;
  border-radius: 14px 14px 0 0;
}
.ev-step {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 4px;
  border-bottom: 1px solid #0c1e2a;
  font-size: 0.77rem;
}
.ev-step:last-child { border-bottom: none; }
.ev-step-icon  { font-size: 0.95rem; flex-shrink: 0; width: 22px; text-align: center; }
.ev-step-label { flex: 1; }
.ev-step-badge {
  font-size: 0.65rem; font-weight: 700;
  padding: 2px 7px; border-radius: 10px;
  text-transform: uppercase; letter-spacing: 0.04em;
}
.gov-intercept-card {
  margin-top: 10px;
  padding: 9px 12px;
  background: #160600;
  border: 1px solid #ff980050;
  border-radius: 9px;
  font-size: 0.73rem;
  color: #ff9800;
  line-height: 1.55;
}
.gov-intercept-title { font-weight: 700; margin-bottom: 3px; }
.gov-type-pill {
  display: inline-block;
  padding: 1px 7px;
  border-radius: 8px;
  background: #ff980020;
  border: 1px solid #ff980050;
  font-size: 0.65rem;
  margin-right: 4px;
  margin-top: 3px;
  color: #ffcc80;
}

/* ── Answer Hero ── */
.answer-hero {
  border: 1px solid #162838;
  border-radius: 14px;
  background: #060d14;
  padding: 20px 22px;
  min-height: 380px;
  max-height: 540px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  transition: border-color 0.4s, box-shadow 0.4s;
}
.answer-hero.streaming { border-color: #1fa8c950; }
.answer-hero.complete  { border-color: #69f0ae40; box-shadow: 0 0 20px #69f0ae08; }
.answer-hero-empty {
  color: #1a3848;
  font-size: 0.82rem;
  text-align: center;
  line-height: 1.9;
  padding-top: 28px;
  flex: 1;
}
.answer-hero-text {
  font-size: 0.92rem;
  line-height: 1.95;
  color: #cde6f0;
  white-space: pre-wrap;
  flex: 1;
}

/* ── Inline tokens ── */
.redacted-token {
  color: #ff9800;
  background: #1a0800;
  padding: 1px 5px;
  border-radius: 4px;
  font-family: "SF Mono", "Fira Code", monospace;
  font-size: 0.8em;
  border: 1px solid #ff980040;
  white-space: nowrap;
}
.citation-token {
  color: #1fa8c9;
  border-bottom: 1px dashed #1fa8c980;
  cursor: pointer;
  font-size: 0.88em;
}
.citation-token:hover { color: #80deea; background: #1fa8c912; border-radius: 3px; }

/* ── Evidence Map (classic workspace) ── */
.evidence-map {
  display: grid;
  grid-template-columns: 140px 1fr;
  gap: 14px;
}
.ev-timeline { display: flex; flex-direction: column; gap: 2px; }
.ev-timeline-step {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 7px 0;
  font-size: 0.76rem;
  position: relative;
}
.ev-timeline-step::after {
  content: "";
  position: absolute;
  left: 9px; top: 26px;
  width: 1px; height: calc(100% - 14px);
  background: #1a2e3a;
}
.ev-timeline-step:last-child::after { display: none; }
.ev-tl-dot {
  flex-shrink: 0;
  width: 18px; height: 18px;
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 0.7rem; z-index: 1;
}
.ev-chunk-card {
  background: #0a1620;
  border: 1px solid #1a2e3a;
  border-radius: 10px;
  padding: 10px 12px;
  transition: border-color 0.2s;
}
.ev-chunk-card:hover { border-color: #1fa8c960; }
.ev-chunk-card.gov-redacted {
  border-color: #ff980060;
  background: #0e0900;
}

/* ── Architecture legend ── */
.arch-legend {
  margin-top: 28px;
  padding: 14px 18px;
  background: #03080d;
  border: 1px solid #111e2a;
  border-radius: 12px;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 10px 24px;
  font-size: 0.73rem;
  color: var(--muted);
}
`;

// ── App ────────────────────────────────────────────────────────────────────────
export function App() {
  const [token, setToken] = useState("");
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState(false);

  // Classic query state
  const [queryText, setQueryText] = useState(
    "Compare our SOC2 and ISO27001 evidence handling approach and cite relevant internal policy pages."
  );
  const [topK, setTopK] = useState(5);
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
  const [queryLoading, setQueryLoading] = useState(false);
  const [queryError, setQueryError] = useState("");

  // Ingest state
  const [storageKey, setStorageKey] = useState("");
  const [filename, setFilename] = useState("");
  const [mimeType, setMimeType] = useState("application/pdf");
  const [sizeBytes, setSizeBytes] = useState(0);
  const [ingestResult, setIngestResult] = useState<IngestResult | null>(null);
  const [ingestLoading, setIngestLoading] = useState(false);
  const [ingestError, setIngestError] = useState("");

  // Demo story state
  const [demoScenario, setDemoScenario] = useState<number | null>(null);
  const [agentQuery, setAgentQuery] = useState("");
  const [agentEvents, setAgentEvents] = useState<AgentEvent[]>([]);
  const [agentAnswer, setAgentAnswer] = useState("");
  const [agentLoading, setAgentLoading] = useState(false);
  const [agentError, setAgentError] = useState("");
  const [govEvents, setGovEvents] = useState<AgentEvent[]>([]);
  const [doneReason, setDoneReason] = useState<string | null>(null);
  const traceEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    traceEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [agentEvents, agentAnswer]);

  // ── Health check ──────────────────────────────────────────────────────────
  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch(`${API}/health`);
        setHealth(await res.json());
        setHealthError(false);
      } catch {
        setHealthError(true);
      }
    };
    void check();
    const id = setInterval(check, 15_000);
    return () => clearInterval(id);
  }, []);

  // ── Token ─────────────────────────────────────────────────────────────────
  const handleGetToken = useCallback(async () => {
    try {
      const res = await fetch(`${API}/dev/token`);
      const data = (await res.json()) as { token: string };
      setToken(data.token);
    } catch {
      alert("Could not reach /dev/token — is the gateway running?");
    }
  }, []);

  // ── Classic query ─────────────────────────────────────────────────────────
  const handleQuery = useCallback(async () => {
    if (!token) { setQueryError("Get a dev token first."); return; }
    if (!queryText.trim()) { setQueryError("Query cannot be empty."); return; }
    setQueryLoading(true);
    setQueryError("");
    setQueryResult(null);
    try {
      const res = await fetch(`${API}/v1/query`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ query: queryText, topK, estimatedTokens: 512 }),
      });
      if (!res.ok) {
        const err = (await res.json()) as { message?: string };
        setQueryError(err.message ?? `HTTP ${res.status}`);
      } else {
        setQueryResult((await res.json()) as QueryResult);
      }
    } catch {
      setQueryError("Network error — is the gateway running?");
    } finally {
      setQueryLoading(false);
    }
  }, [token, queryText, topK]);

  // ── Ingest ────────────────────────────────────────────────────────────────
  const handleIngest = useCallback(async () => {
    if (!token) { setIngestError("Get a dev token first."); return; }
    if (!storageKey || !filename) { setIngestError("Storage key and filename are required."); return; }
    setIngestLoading(true);
    setIngestError("");
    setIngestResult(null);
    try {
      const res = await fetch(`${API}/v1/ingest`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ storageKey, filename, mimeType, sizeBytes }),
      });
      if (!res.ok) {
        const err = (await res.json()) as { message?: string };
        setIngestError(err.message ?? `HTTP ${res.status}`);
      } else {
        setIngestResult((await res.json()) as IngestResult);
      }
    } catch {
      setIngestError("Network error — is the gateway running?");
    } finally {
      setIngestLoading(false);
    }
  }, [token, storageKey, filename, mimeType, sizeBytes]);

  // ── Demo: select scenario ─────────────────────────────────────────────────
  const selectScenario = useCallback((idx: number) => {
    setDemoScenario(idx);
    setAgentQuery(DEMO_SCENARIOS[idx].query);
    setAgentEvents([]);
    setAgentAnswer("");
    setGovEvents([]);
    setAgentError("");
    setDoneReason(null);
  }, []);

  // ── Demo: run agentic query via SSE ───────────────────────────────────────
  const handleAgentQuery = useCallback(async () => {
    if (!token) { setAgentError("Get a dev token first — click the button in the top bar."); return; }
    if (!agentQuery.trim()) return;

    setAgentLoading(true);
    setAgentEvents([]);
    setAgentAnswer("");
    setGovEvents([]);
    setAgentError("");
    setDoneReason(null);

    try {
      const res = await fetch(`${API}/v1/query/stream`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ query: agentQuery, topK: 5, useLlmClassifier: true }),
      });

      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as Record<string, string>;
        setAgentError(err.message ?? `HTTP ${res.status}`);
        return;
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const messages = buf.split("\n\n");
        buf = messages.pop() ?? "";
        for (const msg of messages) {
          for (const line of msg.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const raw = line.slice(6).trim();
            if (!raw) continue;
            try {
              const ev = JSON.parse(raw) as { type: SseEventType; [k: string]: unknown };
              const agentEv: AgentEvent = {
                id: crypto.randomUUID(), type: ev.type, data: ev, ts: Date.now(),
              };
              if (ev.type === "chunk") {
                setAgentAnswer((prev) => prev + ((ev.content as string) ?? ""));
              } else if (ev.type === "governance") {
                setGovEvents((prev) => [...prev, agentEv]);
                setAgentEvents((prev) => [...prev, agentEv]);
              } else if (ev.type === "done") {
                setDoneReason((ev.reason as string) ?? "complete");
                setAgentLoading(false);
              } else {
                setAgentEvents((prev) => [...prev, agentEv]);
              }
            } catch { /* ignore malformed */ }
          }
        }
      }
    } catch (e) {
      setAgentError("Stream error — " + String(e));
    } finally {
      setAgentLoading(false);
    }
  }, [token, agentQuery]);

  // ── Derived ───────────────────────────────────────────────────────────────
  const maxRrf = queryResult
    ? Math.max(...queryResult.chunks.map((c) => c.rrf_score), 0.001)
    : 1;
  const maxRerank = queryResult
    ? Math.max(...queryResult.chunks.map((c) => c.rerank_score ?? 0), 0.001)
    : 1;
  const selectedScenario = demoScenario !== null ? DEMO_SCENARIOS[demoScenario] : null;
  const govFired = govEvents.length > 0;
  const isReranked = queryResult?.chunks.some((c) => c.rerank_score != null) ?? false;

  function fmtTs(ts: number): string {
    const d = new Date(ts);
    return `${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="app-shell">
      <style>{DEMO_CSS}</style>

      {/* ── Top bar ── */}
      <header className="topbar glass">
        <div className="brand">
          <div className="brand-mark">ER</div>
          <div>
            <p className="eyebrow">Enterprise Intelligence</p>
            <h1>RAG Control Center</h1>
          </div>
        </div>
        <div className="top-actions">
          <div className="health-pill">
            {healthError ? (
              <><StatusDot ok={false} />Gateway unreachable</>
            ) : health ? (
              <>
                <StatusDot ok={health.status === "ok"} pulse={health.status === "ok"} />
                {health.status === "ok" ? "Systems OK" : "Degraded"}&nbsp;·&nbsp;
                DB <StatusDot ok={health.services.db === "ok"} />
                Redis <StatusDot ok={health.services.redis === "ok"} />
              </>
            ) : (
              <span style={{ color: "var(--muted)" }}>Checking…</span>
            )}
          </div>
          <button className="ghost-btn" onClick={() => void handleGetToken()}>
            {token ? "↻ Refresh Token" : "Get Dev Token"}
          </button>
        </div>
      </header>

      {/* ── KPI row ── */}
      <section className="kpi-grid">
        <article className="kpi-card glass reveal">
          <p>Gateway</p>
          <h2 style={{ color: healthError ? "var(--danger)" : "var(--brand)" }}>
            {healthError ? "Down" : health?.status === "ok" ? "OK" : health ? "Degraded" : "…"}
          </h2>
          <span>{health ? `db:${health.services.db} redis:${health.services.redis}` : "polling"}</span>
        </article>

        <article className="kpi-card glass reveal">
          <p>Last Query</p>
          <h2>{queryResult ? `${queryResult.latency_ms.toFixed(0)} ms` : agentLoading ? "streaming…" : "—"}</h2>
          <span>
            {queryResult
              ? `${queryResult.chunk_count} chunks retrieved`
              : doneReason
              ? `agent · ${doneReason}`
              : "no query yet"}
          </span>
        </article>

        <article className="kpi-card glass reveal">
          <p>Intent</p>
          <h2 style={{ fontSize: "1.1rem" }}>
            {queryResult?.intent ?? (selectedScenario ? selectedScenario.pathType : "—")}
          </h2>
          <span>
            {queryResult?.plan_type ?? (selectedScenario ? selectedScenario.badge : "rules-based planner")}
          </span>
        </article>

        {/* Token Active — glows when authenticated */}
        <article className={`kpi-card glass reveal${token ? " kpi-token-active" : ""}`}>
          <p>Auth</p>
          <h2 style={{
            color: token ? "var(--brand)" : "var(--muted)",
            fontSize: "1.1rem",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            {token ? <><StatusDot ok pulse />Token Active</> : "No Token"}
          </h2>
          <span>{token ? `tenant: ${TEST_TENANT.slice(0, 8)}…` : "click Get Dev Token"}</span>
        </article>
      </section>

      {/* ── Classic workspace ── */}
      <main className="workspace-grid">
        {/* Query panel */}
        <section className="query-panel glass reveal">
          <div className="section-head">
            <h3>Ask Enterprise Knowledge</h3>
            <span className="chip">Hybrid RRF k=60</span>
          </div>
          <textarea
            value={queryText}
            onChange={(e) => setQueryText(e.target.value)}
            aria-label="Enterprise query"
            placeholder="Ask a question about your documents…"
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void handleQuery(); }}
          />
          <div className="query-footer">
            <div className="chip-row">
              <span className="chip subtle">top_k: {topK}</span>
              <label className="chip subtle" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                k=
                <input
                  type="number" min={1} max={20} value={topK}
                  onChange={(e) => setTopK(Number(e.target.value))}
                  style={{ width: 40, background: "transparent", border: "none", color: "var(--muted)", fontFamily: "inherit" }}
                />
              </label>
              <span className="chip subtle">⌘↵ to run</span>
            </div>
            <button className="solid-btn" onClick={() => void handleQuery()} disabled={queryLoading}>
              {queryLoading ? "Retrieving…" : "Execute Query"}
            </button>
          </div>
          {queryError && <p style={{ color: "var(--danger)", marginTop: 8, fontSize: "0.85rem" }}>{queryError}</p>}
        </section>

        {/* ── Evidence Map — merged Retrieval Fusion + Retrieved Chunks, spans 2 rows ── */}
        <section className="retrieval-panel glass reveal" style={{ gridRow: "span 2" }}>
          <div className="section-head">
            <h3>Evidence Map</h3>
            <span className="chip">
              {queryResult ? `${queryResult.chunk_count} chunks · ${queryResult.latency_ms.toFixed(0)} ms` : "RRF k=60 · BGE rerank"}
            </span>
          </div>

          {queryResult && queryResult.chunks.length > 0 ? (
            <div className="evidence-map">
              {/* Left: retrieval pipeline timeline */}
              <div className="ev-timeline">
                {[
                  { icon: "🗄️", label: "Zilliz Dense",   sub: "HNSW·COSINE",  done: true,       color: "#69f0ae" },
                  { icon: "🔡", label: "BM25 Sparse",    sub: "Inverted·IP",  done: true,       color: "#69f0ae" },
                  { icon: "↔️", label: "RRF Fusion",     sub: `k=60`,         done: true,       color: "#ffd54f" },
                  { icon: "🏆", label: "BGE Rerank",     sub: "v2-m3",        done: isReranked, color: "#80deea" },
                ].map((step) => (
                  <div key={step.label} className="ev-timeline-step">
                    <div
                      className="ev-tl-dot"
                      style={{
                        background: step.done ? step.color + "20" : "#0d1f2a",
                        border: `1px solid ${step.done ? step.color + "60" : "#1a2e3a"}`,
                        color: step.done ? step.color : "#2a4a5a",
                      }}
                    >
                      {step.done ? "✓" : "–"}
                    </div>
                    <div>
                      <div style={{ fontSize: "0.75rem", color: step.done ? "#a8c8d8" : "#2a4a5a", fontWeight: 500 }}>
                        {step.label}
                      </div>
                      <div style={{ fontSize: "0.65rem", color: "#2a4a5a" }}>{step.sub}</div>
                    </div>
                  </div>
                ))}
                <div style={{ marginTop: 10, padding: "8px 10px", background: "#080f16", borderRadius: 8, fontSize: "0.7rem" }}>
                  <div style={{ color: "var(--muted)" }}>Query ID</div>
                  <div style={{ color: "#1fa8c9", fontFamily: "monospace", fontSize: "0.66rem" }}>
                    {queryResult.queryId.slice(0, 14)}…
                  </div>
                  <div style={{ color: "var(--muted)", marginTop: 4 }}>intent</div>
                  <div style={{ color: "#ffd54f", fontSize: "0.7rem" }}>{queryResult.intent}</div>
                </div>
              </div>

              {/* Right: top 3 chunks with confidence meters */}
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <p style={{ fontSize: "0.68rem", color: "var(--muted)", margin: "0 0 4px", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                  Top {Math.min(3, queryResult.chunks.length)} Evidence Chunks
                </p>
                {queryResult.chunks.slice(0, 3).map((c, i) => {
                  const hasRedacted = c.content.includes("[REDACTED");
                  return (
                    <div
                      key={c.chunk_id}
                      className={`ev-chunk-card${hasRedacted ? " gov-redacted" : ""}`}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                        <span style={{ fontSize: "0.68rem", color: "var(--muted)" }}>
                          #{i + 1} · {c.chunk_id.slice(0, 8)}…
                        </span>
                        {hasRedacted && (
                          <span style={{ fontSize: "0.63rem", color: "#ff9800", padding: "1px 6px", background: "#1a0800", borderRadius: 8, border: "1px solid #ff980040" }}>
                            ⚠ pii redacted
                          </span>
                        )}
                      </div>
                      <p style={{ margin: "0 0 7px", fontSize: "0.8rem", color: "#b8d8e5", lineHeight: 1.5 }}>
                        {c.content.slice(0, 95)}{c.content.length > 95 ? "…" : ""}
                      </p>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: "0.65rem", color: "var(--muted)" }}>
                          <span style={{ width: 42, flexShrink: 0 }}>Confidence</span>
                          <ConfidenceMeter value={c.rrf_score} max={maxRrf} />
                        </div>
                        {c.rerank_score != null && (
                          <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: "0.65rem", color: "var(--muted)" }}>
                            <span style={{ width: 42, flexShrink: 0 }}>Rerank</span>
                            <ConfidenceMeter value={c.rerank_score} max={maxRerank} />
                          </div>
                        )}
                      </div>
                      {c.source_url && (
                        <p style={{ margin: "5px 0 0", fontSize: "0.65rem", color: "var(--muted)" }}>↗ {c.source_url}</p>
                      )}
                    </div>
                  );
                })}
                {queryResult.chunks.length > 3 && (
                  <p style={{ fontSize: "0.7rem", color: "var(--muted)", textAlign: "center", margin: 0 }}>
                    +{queryResult.chunks.length - 3} more chunks
                  </p>
                )}
              </div>
            </div>
          ) : (
            <p style={{ color: "var(--muted)", fontSize: "0.9rem", lineHeight: 1.6 }}>
              {queryLoading
                ? "Embedding → hybrid search → BGE rerank…"
                : "Results appear here. Left panel shows the retrieval pipeline stages; right panel shows top-3 evidence chunks with confidence scores."}
            </p>
          )}
        </section>

        {/* Ingest panel */}
        <section className="glass reveal" style={{ padding: 18 }}>
          <div className="section-head">
            <h3>Trigger Ingestion</h3>
            <span className="chip">MinIO → Worker</span>
          </div>
          <p style={{ color: "var(--muted)", fontSize: "0.85rem", marginBottom: 12 }}>
            Upload a file to MinIO first, then paste its object key here.
          </p>
          <div style={{ display: "grid", gap: 8 }}>
            {[
              { label: "Storage Key (MinIO object path)", value: storageKey, set: setStorageKey, placeholder: "docs/policy.pdf" },
              { label: "Filename", value: filename, set: setFilename, placeholder: "policy.pdf" },
            ].map(({ label, value, set, placeholder }) => (
              <label key={label} style={{ fontSize: "0.82rem", color: "var(--muted)" }}>
                {label}
                <input
                  value={value}
                  onChange={(e) => set(e.target.value)}
                  placeholder={placeholder}
                  style={{
                    display: "block", width: "100%", marginTop: 4, padding: "8px 12px",
                    background: "#0b1419", border: "1px solid var(--line)", borderRadius: 10,
                    color: "var(--text)", fontFamily: "inherit",
                  }}
                />
              </label>
            ))}
            <label style={{ fontSize: "0.82rem", color: "var(--muted)" }}>
              MIME Type
              <select
                value={mimeType}
                onChange={(e) => setMimeType(e.target.value)}
                style={{
                  display: "block", width: "100%", marginTop: 4, padding: "8px 12px",
                  background: "#0b1419", border: "1px solid var(--line)", borderRadius: 10,
                  color: "var(--text)", fontFamily: "inherit",
                }}
              >
                <option value="application/pdf">PDF</option>
                <option value="application/vnd.openxmlformats-officedocument.wordprocessingml.document">DOCX</option>
                <option value="text/markdown">Markdown</option>
                <option value="text/html">HTML</option>
              </select>
            </label>
            <label style={{ fontSize: "0.82rem", color: "var(--muted)" }}>
              Size (bytes)
              <input
                type="number" value={sizeBytes}
                onChange={(e) => setSizeBytes(Number(e.target.value))}
                style={{
                  display: "block", width: "100%", marginTop: 4, padding: "8px 12px",
                  background: "#0b1419", border: "1px solid var(--line)", borderRadius: 10,
                  color: "var(--text)", fontFamily: "inherit",
                }}
              />
            </label>
          </div>
          <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end" }}>
            <button className="solid-btn" onClick={() => void handleIngest()} disabled={ingestLoading}>
              {ingestLoading ? "Queuing…" : "Queue Ingestion Job"}
            </button>
          </div>
          {ingestError && <p style={{ color: "var(--danger)", fontSize: "0.85rem", marginTop: 8 }}>{ingestError}</p>}
          {ingestResult && (
            <div style={{ marginTop: 10, padding: 12, background: "#0d1f27", borderRadius: 10, fontSize: "0.82rem" }}>
              <p style={{ margin: 0, color: "var(--brand)" }}>✓ Job queued</p>
              <p style={{ margin: "4px 0 0", color: "var(--muted)" }}>
                jobId: {ingestResult.jobId}<br />
                documentId: {ingestResult.documentId}
              </p>
            </div>
          )}
        </section>
      </main>

      {/* ── Divider ── */}
      <div style={{ borderTop: "1px solid #1c3040", margin: "8px 24px 0", opacity: 0.4 }} />

      {/* ── Demo Story — Agentic Intelligence ── */}
      <section className="demo-section">
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, margin: "22px 0 18px" }}>
          <h2 style={{ margin: 0, fontSize: "1.15rem", color: "#d6e9ef" }}>
            ⚡ Agentic Intelligence — Live Demo
          </h2>
          <span style={{ fontSize: "0.75rem", color: "var(--muted)" }}>
            M2 · governed loop · SSE streaming · HardCap(5)
          </span>
        </div>

        {/* Scenario picker */}
        <div className="demo-scenario-grid">
          {DEMO_SCENARIOS.map((s, idx) => (
            <button
              key={idx}
              className={`scenario-card${demoScenario === idx ? " selected" : ""}`}
              onClick={() => selectScenario(idx)}
              style={{ textAlign: "left", fontFamily: "inherit" }}
            >
              <div className="scenario-icon">{s.icon}</div>
              <p className="scenario-title">
                {s.title}
                <span
                  className="path-badge"
                  style={{
                    background: s.badgeColor + "20",
                    color: s.badgeColor,
                    border: `1px solid ${s.badgeColor}40`,
                  }}
                >
                  {s.badge}
                </span>
              </p>
              <p className="scenario-desc">{s.description}</p>
            </button>
          ))}
        </div>

        {/* Query editor + run controls */}
        {demoScenario !== null && (
          <>
            <div style={{ marginBottom: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <span style={{ fontSize: "0.78rem", color: "var(--muted)" }}>Scenario query — edit before running</span>
                {selectedScenario && (
                  <span
                    className="path-badge"
                    style={{
                      background: selectedScenario.badgeColor + "20",
                      color: selectedScenario.badgeColor,
                      border: `1px solid ${selectedScenario.badgeColor}40`,
                    }}
                  >
                    {selectedScenario.pathType === "agentic"
                      ? "AgentPlan · wrap_tool_call + JSONL audit"
                      : "RetrievalPlan · GovernanceIntercept2"}
                  </span>
                )}
              </div>
              <textarea
                value={agentQuery}
                onChange={(e) => setAgentQuery(e.target.value)}
                rows={3}
                style={{
                  width: "100%", padding: "10px 14px",
                  background: "#0b1922", border: "1px solid var(--line)",
                  borderRadius: 10, color: "#d6e9ef", fontFamily: "inherit",
                  fontSize: "0.88rem", lineHeight: 1.6, resize: "vertical", boxSizing: "border-box",
                }}
              />
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <div style={{ fontSize: "0.75rem", color: "var(--muted)" }}>
                {agentLoading ? (
                  <><span className="cursor-blink" style={{ color: "var(--brand)" }}>●</span>&nbsp;streaming live events…</>
                ) : doneReason === "max_iterations" ? (
                  "⚠️ hard cap reached — 5 iterations"
                ) : doneReason === "complete" ? (
                  `✅ done · ${agentEvents.length} events · ${govEvents.length} governance intercept${govEvents.length !== 1 ? "s" : ""}`
                ) : (
                  "Select a scenario above, then run"
                )}
              </div>
              <button
                className="solid-btn"
                onClick={() => void handleAgentQuery()}
                disabled={agentLoading || !agentQuery.trim()}
              >
                {agentLoading ? "Streaming…" : "▶  Run Scenario"}
              </button>
            </div>

            {agentError && (
              <p style={{ color: "var(--danger)", fontSize: "0.85rem", marginBottom: 12 }}>{agentError}</p>
            )}

            {/* ── 3-col workspace: Pulse | Shield | Hero ── */}
            <div className="agent-workspace">

              {/* ── Col 1: Agent Pulse ── */}
              <div>
                <p style={{ fontSize: "0.73rem", color: "var(--muted)", margin: "0 0 6px", fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
                  Agent Pulse
                  {agentLoading && (
                    <span className="cursor-blink" style={{ color: "#64b5f6", fontSize: "0.85rem" }}>◈</span>
                  )}
                </p>
                <div className={`trace-feed${govFired ? " gov-active" : ""}`}>
                  {agentEvents.length === 0 && !agentLoading && (
                    <div className="trace-empty">
                      Live agent monologue streams here.<br />
                      <span style={{ fontSize: "0.72rem" }}>Each step of reasoning becomes visible in real-time.</span>
                    </div>
                  )}

                  {agentEvents.map((ev) => {
                    const meta = EVENT_META[ev.type];
                    return (
                      <div key={ev.id} className="trace-row" style={{ background: meta.bg }}>
                        <span className="trace-ts">{fmtTs(ev.ts)}</span>
                        <span className="trace-icon" style={{ color: meta.color }}>{meta.icon}</span>
                        <span className="trace-label" style={{ color: meta.color }}>{meta.label}</span>
                        <span className="trace-content">{narrateEvent(ev)}</span>
                      </div>
                    );
                  })}

                  {agentLoading && agentEvents.length === 0 && (
                    <div className="trace-row" style={{ background: EVENT_META.thought.bg }}>
                      <span className="trace-ts">--:--</span>
                      <span className="trace-icon" style={{ color: EVENT_META.thought.color }}>◈</span>
                      <span className="trace-label" style={{ color: EVENT_META.thought.color }}>Thinking</span>
                      <span className="trace-content cursor-blink" style={{ color: "#3a6a7a" }}>
                        Retrieving context…
                      </span>
                    </div>
                  )}
                  <div ref={traceEndRef} />
                </div>
              </div>

              {/* ── Col 2: Governance Shield ── */}
              <div>
                <p style={{
                  fontSize: "0.73rem", margin: "0 0 6px", fontWeight: 600,
                  display: "flex", alignItems: "center", gap: 8,
                  color: govFired ? "#ff9800" : "var(--muted)",
                }}>
                  {govFired ? <><span>◆</span> Governance Shield</>  : "Governance Shield"}
                  {govFired && (
                    <span style={{ fontSize: "0.65rem", color: "#ff9800", background: "#1a0800", border: "1px solid #ff980040", borderRadius: 8, padding: "1px 7px" }}>
                      {govEvents.length} intercept{govEvents.length !== 1 ? "s" : ""}
                    </span>
                  )}
                </p>
                <div className={`shield-panel${govFired ? " gov-fired" : ""}`}>
                  {govFired && <div className="scanline-bar" />}

                  {/* Pipeline steps tracker */}
                  {[
                    {
                      icon: "🗄️", label: "Milvus Retrieval",
                      color: "#69f0ae", done: true,
                    },
                    {
                      icon: "🔗", label: "MCP Tool Calls",
                      color: "#ffd54f",
                      done: agentEvents.some((e) => e.type === "tool_call") || doneReason !== null,
                    },
                    {
                      icon: "◉", label: "Tool Results",
                      color: "#80deea",
                      done: agentEvents.some((e) => e.type === "tool_result") || doneReason !== null,
                    },
                    {
                      icon: govFired ? "◆" : "🛡️", label: "Gov Intercept",
                      color: govFired ? "#ff9800" : "#2a4a5a",
                      done: govFired,
                    },
                  ].map((step) => (
                    <div key={step.label} className="ev-step">
                      <span className="ev-step-icon">{step.icon}</span>
                      <span className="ev-step-label" style={{ color: step.done ? step.color : "#2a4a5a" }}>
                        {step.label}
                      </span>
                      <span
                        className="ev-step-badge"
                        style={{
                          background: step.done ? step.color + "18" : "transparent",
                          color: step.done ? step.color : "#1a3040",
                          border: `1px solid ${step.done ? step.color + "40" : "#1a2e3a"}`,
                        }}
                      >
                        {step.done ? "LIVE" : "wait"}
                      </span>
                    </div>
                  ))}

                  {/* Governance intercept detail cards */}
                  {govEvents.map((ev) => {
                    const types = (ev.data.pattern_types as string[] | undefined) ?? [];
                    return (
                      <div key={ev.id} className="gov-intercept-card">
                        <div className="gov-intercept-title">
                          ⚠ PII Intercepted{ev.data.tool ? ` — ${String(ev.data.tool)}` : ""}
                        </div>
                        {types.length > 0 && (
                          <div>
                            {types.map((t) => (
                              <span key={t} className="gov-type-pill">{t}</span>
                            ))}
                          </div>
                        )}
                        <div style={{ color: "#ff980080", marginTop: 4, fontSize: "0.68rem" }}>
                          action=redacted · logged → governance_events + JSONL
                        </div>
                      </div>
                    );
                  })}

                  {!agentLoading && !govFired && agentEvents.length === 0 && (
                    <div className="trace-empty">
                      Retrieval pipeline stages and governance intercepts appear here as the agent runs.
                    </div>
                  )}
                </div>
              </div>

              {/* ── Col 3: Answer Hero ── */}
              <div>
                <p style={{
                  fontSize: "0.73rem", color: "var(--muted)", margin: "0 0 6px",
                  fontWeight: 600, display: "flex", alignItems: "center", gap: 8,
                }}>
                  Synthesized Answer
                  {agentLoading && agentAnswer && (
                    <span className="cursor-blink" style={{ color: "#80deea" }}>▋</span>
                  )}
                  {doneReason === "complete" && agentAnswer && (
                    <span style={{ color: "#69f0ae", fontSize: "0.65rem", fontWeight: 400 }}>· complete</span>
                  )}
                </p>
                <div className={`answer-hero${agentLoading && agentAnswer ? " streaming" : doneReason === "complete" && agentAnswer ? " complete" : ""}`}>
                  {!agentAnswer && !agentLoading && (
                    <div className="answer-hero-empty">
                      The synthesized answer streams here.<br />
                      <span style={{ color: "#102030", fontSize: "0.76rem" }}>
                        Citations like{" "}
                        <span style={{ color: "#1fa8c9", borderBottom: "1px dashed #1fa8c980" }}>[Doc #1]</span>
                        {" "}link back to evidence chunks.<br />
                        Redacted PII appears in{" "}
                        <span style={{ color: "#ff9800", background: "#1a0800", padding: "1px 4px", borderRadius: 3 }}>
                          [REDACTED:type]
                        </span>
                        .
                      </span>
                    </div>
                  )}
                  {agentAnswer && (
                    <div className="answer-hero-text">
                      {renderWithHighlights(agentAnswer)}
                      {agentLoading && <span className="cursor-blink">▋</span>}
                    </div>
                  )}
                  {agentLoading && !agentAnswer && (
                    <div style={{ color: "#1a3848", fontSize: "0.8rem", paddingTop: 8 }}>
                      <span className="cursor-blink">Waiting for first token…</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        )}

        {/* Architecture legend */}
        <div className="arch-legend">
          <div>
            <strong style={{ color: "#80deea" }}>Pipeline path</strong> · single_intent<br />
            Retrieval → MCP parallel → GovernanceIntercept2 → LLMRouter → answer
          </div>
          <div>
            <strong style={{ color: "#ffd54f" }}>Agentic path</strong> · cross_system / complex_multi_step<br />
            AgentExecutor loop → wrap_tool_call → GovernanceIntercept → SSE
          </div>
          <div>
            <strong style={{ color: "#ff9800" }}>HardCap</strong> · max 5 iterations<br />
            Terminates loop, yields done(max_iterations)
          </div>
          <div>
            <strong style={{ color: "#69f0ae" }}>Audit trail</strong> · JSONL + Postgres<br />
            Every tool call logged fire-and-forget · governance_events append-only
          </div>
          <div>
            <strong style={{ color: "#64b5f6" }}>LLM Router</strong> · governance-aware<br />
            governance_flags → gpt-4o · long context → gpt-4o · otherwise configured provider
          </div>
          <div style={{ color: "#1a3040" }}>
            MCP servers serve mock data — real Jira/Confluence requires M2 service deployment
            at JIRA_MCP_BASE_URL / CONFLUENCE_MCP_BASE_URL
          </div>
        </div>
      </section>
    </div>
  );
}
