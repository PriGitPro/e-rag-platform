import { useState, useEffect, useCallback } from "react";

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

const API = "/api";
const TEST_TENANT = "00000000-0000-0000-0000-000000000001";

// ── Helpers ────────────────────────────────────────────────────────────────────
function authHeaders(token: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

function StatusDot({ ok }: { ok: boolean }) {
  return <span className={`dot ${ok ? "pass" : "fail"}`} style={{ display: "inline-block", marginRight: 6 }} />;
}

function ScoreBar({ value, max = 1 }: { value: number; max?: number }) {
  const pct = Math.min(100, Math.round((value / max) * 100));
  return (
    <div className="meter">
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

// ── App ────────────────────────────────────────────────────────────────────────
export function App() {
  const [token, setToken] = useState("");
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState(false);

  // Query state
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
      const data = await res.json() as { token: string };
      setToken(data.token);
    } catch {
      alert("Could not reach /dev/token — is the gateway running?");
    }
  }, []);

  // ── Query ─────────────────────────────────────────────────────────────────
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
        body: JSON.stringify({ query: queryText, topK, estimatedTokens: 512 })
      });
      if (!res.ok) {
        const err = await res.json() as { message?: string };
        setQueryError(err.message ?? `HTTP ${res.status}`);
      } else {
        setQueryResult(await res.json() as QueryResult);
      }
    } catch (e) {
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
        body: JSON.stringify({ storageKey, filename, mimeType, sizeBytes })
      });
      if (!res.ok) {
        const err = await res.json() as { message?: string };
        setIngestError(err.message ?? `HTTP ${res.status}`);
      } else {
        setIngestResult(await res.json() as IngestResult);
      }
    } catch {
      setIngestError("Network error — is the gateway running?");
    } finally {
      setIngestLoading(false);
    }
  }, [token, storageKey, filename, mimeType, sizeBytes]);

  const maxRrf = queryResult
    ? Math.max(...queryResult.chunks.map((c) => c.rrf_score), 0.001)
    : 1;
  const maxRerank = queryResult
    ? Math.max(...queryResult.chunks.map((c) => c.rerank_score ?? 0), 0.001)
    : 1;

  return (
    <div className="app-shell">
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
            {healthError
              ? <><StatusDot ok={false} />Gateway unreachable</>
              : health
                ? <><StatusDot ok={health.status === "ok"} />
                    DB <StatusDot ok={health.services.db === "ok"} />
                    Redis <StatusDot ok={health.services.redis === "ok"} />
                  </>
                : <span style={{ color: "var(--muted)" }}>Checking…</span>}
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
          <h2>{queryResult ? `${queryResult.latency_ms.toFixed(0)} ms` : "—"}</h2>
          <span>{queryResult ? `${queryResult.chunk_count} chunks retrieved` : "no query yet"}</span>
        </article>
        <article className="kpi-card glass reveal">
          <p>Intent</p>
          <h2 style={{ fontSize: "1.1rem" }}>{queryResult?.intent ?? "—"}</h2>
          <span>{queryResult?.plan_type ?? "rules-based planner"}</span>
        </article>
        <article className="kpi-card glass reveal">
          <p>Auth</p>
          <h2 style={{ color: token ? "var(--brand)" : "var(--muted)", fontSize: "1.1rem" }}>
            {token ? "Token Active" : "No Token"}
          </h2>
          <span>{token ? `tenant: ${TEST_TENANT.slice(0, 8)}…` : "click Get Dev Token"}</span>
        </article>
      </section>

      <main className="workspace-grid">
        {/* ── Query panel ── */}
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

        {/* ── Retrieval fusion ── */}
        <section className="retrieval-panel glass reveal">
          <div className="section-head">
            <h3>Retrieval Fusion</h3>
            <span className="chip">RRF k=60 · BGE rerank</span>
          </div>
          {queryResult && queryResult.chunks.length > 0 ? (
            <ul className="branch-list">
              {queryResult.chunks.map((c, i) => (
                <li key={c.chunk_id}>
                  <div style={{ overflow: "hidden", flex: 1 }}>
                    <p style={{ fontSize: "0.82rem", color: "var(--muted)" }}>
                      #{i + 1} · {c.doc_id.slice(0, 8)}… {c.source_url ? `· ${c.source_url}` : ""}
                    </p>
                    <p style={{ fontSize: "0.88rem", marginTop: 4 }}>
                      {c.content.slice(0, 120)}{c.content.length > 120 ? "…" : ""}
                    </p>
                  </div>
                  <div className="score-wrap">
                    <strong>{(c.rrf_score * 100).toFixed(1)}%</strong>
                    <ScoreBar value={c.rrf_score} max={maxRrf} />
                    {c.rerank_score != null && (
                      <>
                        <small style={{ color: "var(--muted)" }}>rerank {c.rerank_score.toFixed(3)}</small>
                        <ScoreBar value={c.rerank_score} max={maxRerank} />
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p style={{ color: "var(--muted)", fontSize: "0.9rem" }}>
              {queryLoading ? "Running hybrid search…" : "Results appear here after a query."}
            </p>
          )}
        </section>

        {/* ── Ingest panel ── */}
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
              { label: "Filename", value: filename, set: setFilename, placeholder: "policy.pdf" }
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
                    color: "var(--text)", fontFamily: "inherit"
                  }}
                />
              </label>
            ))}
            <label style={{ fontSize: "0.82rem", color: "var(--muted)" }}>
              MIME Type
              <select
                value={mimeType} onChange={(e) => setMimeType(e.target.value)}
                style={{
                  display: "block", width: "100%", marginTop: 4, padding: "8px 12px",
                  background: "#0b1419", border: "1px solid var(--line)", borderRadius: 10,
                  color: "var(--text)", fontFamily: "inherit"
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
                type="number" value={sizeBytes} onChange={(e) => setSizeBytes(Number(e.target.value))}
                style={{
                  display: "block", width: "100%", marginTop: 4, padding: "8px 12px",
                  background: "#0b1419", border: "1px solid var(--line)", borderRadius: 10,
                  color: "var(--text)", fontFamily: "inherit"
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

        {/* ── Answer panel — raw chunks (no LLM generation yet) ── */}
        <section className="answer-panel glass reveal">
          <div className="section-head">
            <h3>Retrieved Chunks</h3>
            <span className="chip">{queryResult ? `${queryResult.chunk_count} results` : "proto01 — no generation"}</span>
          </div>
          {queryResult && queryResult.chunks.length > 0 ? (
            <>
              <div className="citations" style={{ marginBottom: 12 }}>
                <span className="chip subtle">intent: {queryResult.intent}</span>
                <span className="chip subtle">{queryResult.latency_ms.toFixed(0)} ms</span>
                {queryResult.chunks[0]?.rerank_score != null && (
                  <span className="chip subtle">BGE reranked</span>
                )}
              </div>
              <div style={{ display: "grid", gap: 10, maxHeight: 420, overflowY: "auto" }}>
                {queryResult.chunks.map((c, i) => (
                  <div key={c.chunk_id} style={{
                    background: "#0d1a20", border: "1px solid var(--line)", borderRadius: 12, padding: 14
                  }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                      <span style={{ fontSize: "0.75rem", color: "var(--muted)" }}>
                        #{i + 1} · chunk {c.chunk_id.slice(0, 8)}…
                      </span>
                      <div style={{ display: "flex", gap: 6 }}>
                        <span className="chip subtle">rrf {(c.rrf_score * 100).toFixed(1)}%</span>
                        {c.rerank_score != null && (
                          <span className="chip subtle">rank {c.rerank_score.toFixed(3)}</span>
                        )}
                      </div>
                    </div>
                    <p style={{ margin: 0, fontSize: "0.88rem", lineHeight: 1.6, color: "#d6e9ef" }}>
                      {c.content}
                    </p>
                    {c.source_url && (
                      <p style={{ margin: "8px 0 0", fontSize: "0.76rem", color: "var(--muted)" }}>
                        ↗ {c.source_url}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p style={{ color: "var(--muted)", fontSize: "0.9rem", lineHeight: 1.6 }}>
              {queryLoading
                ? "Embedding → hybrid search → rerank…"
                : "LLM generation not yet wired (Week 3). Raw ranked chunks appear here after a query."}
            </p>
          )}
        </section>
      </main>
    </div>
  );
}
