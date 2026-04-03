
# Enterprise RAG Platform with Built-in AI Governance

> A production-grade knowledge platform with governed hybrid execution: a deterministic RAG pipeline for single-intent queries, with agentic escalation for complex multi-step queries — both paths enforcing three-intercept governance, an immutable audit trail, and RAGAS-gated retrieval quality.


## Contents

| # | Section |
|---|---------|
| 1 | [Executive summary](#1-executive-summary) |
| 2 | [Problem statement](#2-problem-statement) |
| 3 | [Goals and non-goals](#3-goals-and-non-goals) |
| 4 | [Architecture overview](#4-architecture-overview) |
| 5 | [Component design](#5-component-design) |
| 6 | [Data flow](#6-data-flow--query-lifecycle) |
| 7 | [Technology decisions](#7-technology-decisions) |
| 8 | [Deployment topology](#8-deployment-topology) |
| 9 | [Delivery plan](#9-delivery-plan) |
| 10 | [Testing strategy](#10-testing-strategy) |
| 11 | [Security and governance](#11-security-and-governance) |
| 12 | [Performance targets](#12-performance-targets) |
| 13 | [Risks and mitigations](#13-risks-and-mitigations) |
| 14 | [Alternatives considered](#14-alternatives-considered) |
| 15 | [Competitive landscape](#15-competitive-landscape) |
| 16 | [Open questions](#16-open-questions) |

---

## 1 Executive summary

This document proposes the architecture for a production-grade **Enterprise RAG Platform** — a system that enables internal teams to query proprietary knowledge bases using natural language, with integrated AI governance, explainable citations, and real-time enterprise knowledge integration via the Model Context Protocol (MCP).

The platform addresses a gap in the current enterprise AI landscape: most RAG implementations are either demos with no governance, or black-box vendor products with no observability. This system is designed to be both production-safe and fully transparent — every retrieval decision, governance event, and model call is traceable and auditable.

The architecture uses a **governed hybrid execution model**. The Query Planner classifies every incoming query into one of three intent categories. Single-intent queries (~75–80% of traffic) are handled by the deterministic RAG pipeline: fast, fully auditable, RAGAS-measurable. Complex multi-step queries (~20–25%) are escalated to a governed agentic loop where the LLM selects tools iteratively — but every tool call is wrapped by the same governance layer, every intermediate step is written to the audit log, and a hard iteration cap prevents runaway execution. The pipeline is the product; agency is the controlled escape valve for queries the pipeline cannot handle in one pass.

> **✅ Key differentiators**
>
> **Governed hybrid execution:** The Query Planner routes between a deterministic pipeline (fast, auditable, RAGAS-gated) and a governed agentic loop (iterative, tool-driven, capped). Governance enforces on both paths — structurally, not as middleware.
>
> **Three-intercept governance + tool-call-level wrapping:** Pre-retrieval, post-retrieval, and post-generation safety checks are structurally enforced on the pipeline path. On the agentic path, a `wrap_tool_call()` decorator applies pre/post governance to every MCP tool invocation. No LLM output or retrieved content ever reaches the next stage without a governance intercept.
>
> **Immutable audit trail across all execution paths:** Every governance event — pipeline intercepts, agentic tool-call intercepts, faithfulness scores, PII detections — is written to an append-only `governance_events` table. Agentic steps include `agent_iteration` and `step_index` columns so the full reasoning trace is reconstructable by a compliance team.
>
> **Hybrid retrieval with measurable quality:** Milvus HNSW dense vectors + BM25S sparse index fused via Reciprocal Rank Fusion, evaluated by RAGAS in CI on every change. The RAGAS gate applies to the pipeline path; a separate agentic eval harness covers the escalation path.

---

## 2 Problem statement

Enterprise teams deploying LLM-powered knowledge systems face five compounding problems:

1. **No governance.** LLM responses may expose PII from source documents, or be manipulated by prompt injection content embedded in retrieved chunks. Most implementations have no intercept between retrieval and generation.
2. **Weak retrieval.** Naive vector search misses keyword-specific queries (document numbers, clause identifiers, exact technical terms). Single-strategy retrieval produces retrieval quality that cannot be measured or improved systematically.
3. **No observability.** Organizations cannot see what the model retrieved, why it retrieved it, what it cost, or whether the answer was grounded in the sources. Debugging a wrong answer requires reading through logs manually.
4. **Siloed knowledge.** Enterprise knowledge lives across Confluence, Jira, Notion, GitHub, and internal document stores. Current RAG systems require ingesting everything into a single vector store — losing the metadata, structure, and access controls of the source systems.
5. **No auditability.** In regulated industries, AI-assisted decisions require an immutable record of what the system retrieved, what it generated, and what governance checks were applied. No current open-source RAG solution provides this.

---

## 3 Goals and non-goals

### Goals

- Build a production-ready RAG pipeline with measurable retrieval quality (RAGAS ≥ 90% faithfulness).
- Implement hybrid retrieval — dense vector + sparse BM25 fused via RRF — with index strategy comparison documented.
- Implement a Query Planner that routes queries across three intent classes: single-intent to the deterministic pipeline, complex multi-step to the governed agentic loop.
- Enforce AI governance at three structurally distinct intercept points on the pipeline path; extend governance to tool-call level on the agentic path via `wrap_tool_call()`.
- Expose enterprise knowledge platforms (Confluence, Jira) as MCP retrieval branches on the pipeline path and as agent-callable tools on the agentic path — same interface, both paths governed.
- Provide full query observability: per-step trace, retrieval scores, governance events, token costs. On the agentic path, log every agent iteration and tool call to the audit trail.
- Run the full production system on free cloud tiers at MVP scale.
- Demonstrate staff-engineer-level depth through documented architecture decisions, measurable benchmarks, and a CI-gated eval suite.

### Non-goals

- Model fine-tuning or training.
- Multi-region deployment (future phase).
- Autonomous portfolio rebalancing or live trade execution.
- Replacing existing BI or analytics platforms.
- Real-time streaming data ingestion pipelines.

---

## 4 Architecture overview

'''
<svg viewBox="0 0 620 780" xmlns="http://www.w3.org/2000/svg" font-family="'SF Mono', 'Fira Code', 'Cascadia Code', monospace">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#0d1117"/>
      <stop offset="100%" stop-color="#0a0f14"/>
    </linearGradient>
    <linearGradient id="gwGrad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#1e3a5f"/>
      <stop offset="100%" stop-color="#2563a8"/>
    </linearGradient>
    <linearGradient id="govGrad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#c0392b"/>
      <stop offset="100%" stop-color="#e55039"/>
    </linearGradient>
    <linearGradient id="plannerGrad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#1a3a5c"/>
      <stop offset="100%" stop-color="#1e4d80"/>
    </linearGradient>
    <filter id="govGlow">
      <feGaussianBlur stdDeviation="3" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="shadow">
      <feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="#000" flood-opacity="0.5"/>
    </filter>
  </defs>

  <rect width="620" height="780" fill="url(#bg)"/>

  <!-- Subtle grid -->
  <g opacity="0.04" stroke="#aaa" stroke-width="0.5">
    <line x1="0" y1="100" x2="620" y2="100"/><line x1="0" y1="200" x2="620" y2="200"/>
    <line x1="0" y1="300" x2="620" y2="300"/><line x1="0" y1="400" x2="620" y2="400"/>
    <line x1="0" y1="500" x2="620" y2="500"/><line x1="0" y1="600" x2="620" y2="600"/>
    <line x1="0" y1="700" x2="620" y2="700"/>
    <line x1="155" y1="0" x2="155" y2="780"/><line x1="310" y1="0" x2="310" y2="780"/>
    <line x1="465" y1="0" x2="465" y2="780"/>
  </g>

  <!-- Title -->
  <text x="310" y="32" text-anchor="middle" fill="#e2e8f0" font-size="13" font-weight="700" letter-spacing="2" opacity="0.9">RFC-001 · ENTERPRISE RAG PLATFORM</text>
  <text x="310" y="50" text-anchor="middle" fill="#64748b" font-size="10" letter-spacing="3">GOVERNED HYBRID EXECUTION · HIGH-LEVEL OVERVIEW</text>

  <!-- GATEWAY -->
  <rect x="130" y="66" width="360" height="44" rx="6" fill="url(#gwGrad)" filter="url(#shadow)"/>
  <rect x="130" y="66" width="360" height="44" rx="6" fill="none" stroke="#3b82f6" stroke-width="1" opacity="0.6"/>
  <text x="310" y="84" text-anchor="middle" fill="#93c5fd" font-size="9" letter-spacing="2" font-weight="700">GATEWAY</text>
  <text x="310" y="99" text-anchor="middle" fill="#bfdbfe" font-size="10">Auth · Rate Limiting · Tenant Routing</text>

  <line x1="310" y1="110" x2="310" y2="128" stroke="#475569" stroke-width="1.5" stroke-dasharray="3,3"/>
  <polygon points="310,130 305,122 315,122" fill="#475569"/>

  <!-- INTERCEPT 1 -->
  <rect x="130" y="132" width="360" height="44" rx="6" fill="url(#govGrad)" filter="url(#govGlow)" opacity="0.92"/>
  <rect x="130" y="132" width="360" height="44" rx="6" fill="none" stroke="#f87171" stroke-width="1.5" opacity="0.8"/>
  <circle cx="148" cy="154" r="11" fill="#991b1b" stroke="#ef4444" stroke-width="1"/>
  <text x="148" y="158" text-anchor="middle" fill="#fca5a5" font-size="9" font-weight="700">I1</text>
  <text x="315" y="150" text-anchor="middle" fill="#fca5a5" font-size="9" letter-spacing="2" font-weight="700">PRE-RETRIEVAL GOVERNANCE</text>
  <text x="315" y="165" text-anchor="middle" fill="#fecaca" font-size="10">PII Redaction · Injection Detection · RBAC Scope</text>

  <line x1="310" y1="176" x2="310" y2="194" stroke="#475569" stroke-width="1.5" stroke-dasharray="3,3"/>
  <polygon points="310,196 305,188 315,188" fill="#475569"/>

  <!-- QUERY PLANNER -->
  <rect x="130" y="198" width="360" height="54" rx="6" fill="url(#plannerGrad)" filter="url(#shadow)"/>
  <rect x="130" y="198" width="360" height="54" rx="6" fill="none" stroke="#60a5fa" stroke-width="1" opacity="0.5"/>
  <text x="310" y="218" text-anchor="middle" fill="#93c5fd" font-size="9" letter-spacing="2" font-weight="700">QUERY PLANNER</text>
  <text x="310" y="232" text-anchor="middle" fill="#bfdbfe" font-size="10">single_intent · cross_system → RetrievalPlan</text>
  <text x="310" y="245" text-anchor="middle" fill="#7dd3fc" font-size="10" font-weight="600">complex_multi_step → AgentPlan</text>

  <!-- Route split -->
  <line x1="310" y1="252" x2="310" y2="278" stroke="#475569" stroke-width="1.5"/>
  <line x1="195" y1="278" x2="425" y2="278" stroke="#475569" stroke-width="1.5"/>
  <line x1="195" y1="278" x2="195" y2="300" stroke="#7c3aed" stroke-width="2"/>
  <polygon points="195,302 190,294 200,294" fill="#7c3aed"/>
  <line x1="425" y1="278" x2="425" y2="300" stroke="#0e9090" stroke-width="2"/>
  <polygon points="425,302 420,294 430,294" fill="#0e9090"/>
  <text x="160" y="291" text-anchor="middle" fill="#a78bfa" font-size="9" font-weight="700">~75-80%</text>
  <text x="460" y="291" text-anchor="middle" fill="#5eead4" font-size="9" font-weight="700">~20-25%</text>

  <!-- PIPELINE PATH -->
  <rect x="30" y="304" width="270" height="172" rx="8" fill="#5b2d8e" fill-opacity="0.12" stroke="#7c3aed" stroke-width="1.5" stroke-dasharray="6,3"/>
  <text x="165" y="321" text-anchor="middle" fill="#a78bfa" font-size="9" letter-spacing="2" font-weight="700">PIPELINE PATH</text>
  <rect x="50" y="327" width="230" height="32" rx="5" fill="#5b2d8e" fill-opacity="0.5" stroke="#7c3aed" stroke-width="1"/>
  <text x="165" y="340" text-anchor="middle" fill="#c4b5fd" font-size="9" letter-spacing="1" font-weight="700">RAG RETRIEVER</text>
  <text x="165" y="352" text-anchor="middle" fill="#ddd6fe" font-size="9">Hybrid search · BM25 + Dense · Rerank</text>
  <line x1="165" y1="359" x2="165" y2="369" stroke="#7c3aed" stroke-width="1.5" stroke-dasharray="2,2"/>
  <polygon points="165,371 161,364 169,364" fill="#7c3aed"/>
  <rect x="50" y="373" width="230" height="32" rx="5" fill="#5b2d8e" fill-opacity="0.5" stroke="#7c3aed" stroke-width="1"/>
  <text x="165" y="386" text-anchor="middle" fill="#c4b5fd" font-size="9" letter-spacing="1" font-weight="700">MCP RETRIEVERS</text>
  <text x="165" y="398" text-anchor="middle" fill="#ddd6fe" font-size="9">Confluence · Jira (parallel)</text>
  <line x1="165" y1="405" x2="165" y2="415" stroke="#7c3aed" stroke-width="1.5" stroke-dasharray="2,2"/>
  <polygon points="165,417 161,410 169,410" fill="#7c3aed"/>
  <rect x="50" y="419" width="230" height="32" rx="5" fill="#5b2d8e" fill-opacity="0.5" stroke="#7c3aed" stroke-width="1"/>
  <text x="165" y="432" text-anchor="middle" fill="#c4b5fd" font-size="9" letter-spacing="1" font-weight="700">CONTEXT BUILDER</text>
  <text x="165" y="444" text-anchor="middle" fill="#ddd6fe" font-size="9">Score-weighted · ContextPolicy</text>

  <!-- AGENTIC PATH -->
  <rect x="320" y="304" width="270" height="172" rx="8" fill="#0d6e6e" fill-opacity="0.12" stroke="#0e9090" stroke-width="1.5" stroke-dasharray="6,3"/>
  <text x="455" y="321" text-anchor="middle" fill="#5eead4" font-size="9" letter-spacing="2" font-weight="700">AGENTIC PATH</text>
  <rect x="340" y="327" width="230" height="120" rx="5" fill="#0d6e6e" fill-opacity="0.4" stroke="#0e9090" stroke-width="1"/>
  <text x="455" y="344" text-anchor="middle" fill="#99f6e4" font-size="9" letter-spacing="1" font-weight="700">AGENTIC EXECUTOR</text>
  <text x="455" y="356" text-anchor="middle" fill="#ccfbf1" font-size="9">Governed iterative loop</text>
  <!-- Loop arrow -->
  <path d="M 420,368 Q 408,383 420,398 Q 432,413 455,413 Q 478,413 490,398 Q 502,383 490,368" fill="none" stroke="#0e9090" stroke-width="1.5" stroke-dasharray="3,2" opacity="0.7"/>
  <polygon points="420,368 415,379 427,375" fill="#0e9090" opacity="0.7"/>
  <rect x="358" y="371" width="194" height="32" rx="4" fill="#134e4a" stroke="#14b8a6" stroke-width="1"/>
  <text x="455" y="384" text-anchor="middle" fill="#5eead4" font-size="9" letter-spacing="1" font-weight="700">wrap_tool_call()</text>
  <text x="455" y="396" text-anchor="middle" fill="#99f6e4" font-size="9">Pre/post governance · every call</text>
  <text x="455" y="428" text-anchor="middle" fill="#14b8a6" font-size="9" font-weight="600">max_iterations=5 · RBAC permitted_tools</text>

  <!-- Convergence -->
  <line x1="165" y1="476" x2="165" y2="498" stroke="#7c3aed" stroke-width="2"/>
  <line x1="455" y1="476" x2="455" y2="498" stroke="#0e9090" stroke-width="2"/>
  <line x1="165" y1="498" x2="455" y2="498" stroke="#475569" stroke-width="1.5"/>
  <line x1="310" y1="498" x2="310" y2="516" stroke="#475569" stroke-width="1.5"/>
  <polygon points="310,518 305,510 315,510" fill="#475569"/>
  <text x="310" y="511" text-anchor="middle" fill="#475569" font-size="9" letter-spacing="2">CONVERGE</text>

  <!-- LLM ROUTER -->
  <rect x="130" y="520" width="360" height="44" rx="6" fill="url(#plannerGrad)" filter="url(#shadow)"/>
  <rect x="130" y="520" width="360" height="44" rx="6" fill="none" stroke="#60a5fa" stroke-width="1" opacity="0.5"/>
  <text x="310" y="538" text-anchor="middle" fill="#93c5fd" font-size="9" letter-spacing="2" font-weight="700">LLM ROUTER</text>
  <text x="310" y="553" text-anchor="middle" fill="#bfdbfe" font-size="10">GPT-4o · Sonnet · Flash · FaithfulnessPolicy gate</text>

  <line x1="310" y1="564" x2="310" y2="582" stroke="#475569" stroke-width="1.5" stroke-dasharray="3,3"/>
  <polygon points="310,584 305,576 315,576" fill="#475569"/>

  <!-- INTERCEPT 3 -->
  <rect x="130" y="586" width="360" height="44" rx="6" fill="url(#govGrad)" filter="url(#govGlow)" opacity="0.92"/>
  <rect x="130" y="586" width="360" height="44" rx="6" fill="none" stroke="#f87171" stroke-width="1.5" opacity="0.8"/>
  <circle cx="148" cy="608" r="11" fill="#991b1b" stroke="#ef4444" stroke-width="1"/>
  <text x="148" y="612" text-anchor="middle" fill="#fca5a5" font-size="9" font-weight="700">I3</text>
  <text x="315" y="604" text-anchor="middle" fill="#fca5a5" font-size="9" letter-spacing="2" font-weight="700">POST-GENERATION GOVERNANCE</text>
  <text x="315" y="619" text-anchor="middle" fill="#fecaca" font-size="10">Faithfulness score · Output sanitisation · Compliance audit</text>

  <line x1="310" y1="630" x2="310" y2="648" stroke="#475569" stroke-width="1.5" stroke-dasharray="3,3"/>
  <polygon points="310,650 305,642 315,642" fill="#475569"/>

  <!-- RESPONSE -->
  <rect x="130" y="652" width="360" height="44" rx="6" fill="url(#gwGrad)" filter="url(#shadow)"/>
  <rect x="130" y="652" width="360" height="44" rx="6" fill="none" stroke="#3b82f6" stroke-width="1" opacity="0.6"/>
  <text x="310" y="670" text-anchor="middle" fill="#93c5fd" font-size="9" letter-spacing="2" font-weight="700">RESPONSE DELIVERY</text>
  <text x="310" y="685" text-anchor="middle" fill="#bfdbfe" font-size="10">Citations · Governance flags · agent_iterations count</text>

  <!-- Audit sidebar -->
  <rect x="572" y="132" width="34" height="498" rx="4" fill="#1a0a0a" stroke="#c0392b" stroke-width="1" opacity="0.75"/>
  <text x="589" y="385" text-anchor="middle" fill="#ef4444" font-size="8" letter-spacing="2" font-weight="700" transform="rotate(90,589,385)">COMPLIANCE LEDGER · APPEND-ONLY AUDIT LOG</text>
  <line x1="490" y1="154" x2="570" y2="154" stroke="#ef4444" stroke-width="1" stroke-dasharray="3,3" opacity="0.5"/>
  <line x1="490" y1="390" x2="570" y2="390" stroke="#ef4444" stroke-width="1" stroke-dasharray="3,3" opacity="0.4"/>
  <line x1="490" y1="608" x2="570" y2="608" stroke="#ef4444" stroke-width="1" stroke-dasharray="3,3" opacity="0.5"/>

  <!-- Legend -->
  <rect x="30" y="718" width="560" height="48" rx="6" fill="#0f172a" stroke="#1e293b" stroke-width="1"/>
  <text x="44" y="733" fill="#64748b" font-size="9" letter-spacing="2">LEGEND</text>
  <rect x="44" y="739" width="12" height="10" rx="2" fill="#1e3a5f" stroke="#3b82f6" stroke-width="1"/>
  <text x="62" y="749" fill="#94a3b8" font-size="9">Infrastructure</text>
  <rect x="148" y="739" width="12" height="10" rx="2" fill="#7f1d1d" stroke="#ef4444" stroke-width="1"/>
  <text x="166" y="749" fill="#94a3b8" font-size="9">Governance Intercept</text>
  <rect x="286" y="739" width="12" height="10" rx="2" fill="#5b2d8e" stroke="#7c3aed" stroke-width="1"/>
  <text x="304" y="749" fill="#94a3b8" font-size="9">Pipeline Path</text>
  <rect x="388" y="739" width="12" height="10" rx="2" fill="#0d4444" stroke="#0e9090" stroke-width="1"/>
  <text x="406" y="749" fill="#94a3b8" font-size="9">Agentic Path</text>
  <rect x="490" y="739" width="12" height="10" rx="2" fill="#1a0a0a" stroke="#c0392b" stroke-width="1"/>
  <text x="508" y="749" fill="#94a3b8" font-size="9">Audit Log</text>
</svg>
'''

The platform uses a **governed hybrid execution model**. Every query enters a single governed gateway and passes through Intercept 1 and the Query Planner. The Planner's intent classification determines which execution path fires. Both paths share the same governance layer, the same audit log, and the same final Intercept 3 before response delivery.

### Execution path routing

```
┌─────────────────────────────────────────────────────────────────┐
│                         API Gateway                             │
│              Fastify · tRPC · JWT auth · rate limiting          │
│                        · token budget                           │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                  🔴 Governance — Intercept 1                     │
│        Pre-retrieval: query injection scan · PII in query       │
│                         · policy check                          │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                        Query Planner                            │
│     intent classification → single_intent | complex_multi_step  │
└──────────────────┬──────────────────────────┬───────────────────┘
                   │                          │
     single_intent │              complex_multi_step
                   │                          │
                   ▼                          ▼
┌──────────────────────────┐    ┌──────────────────────────────────┐
│   PIPELINE PATH          │    │   AGENTIC PATH                   │
│   (deterministic)        │    │   (governed iterative loop)      │
│                          │    │                                  │
│  RAG retriever           │    │  Agentic Executor                │
│  Zilliz · HNSW + BM25S   │    │  LLM selects tools from         │
│  · RRF · rerank          │    │  MCP registry · iterates        │
│         +                │    │  until sufficient or cap hit    │
│  MCP retrievers          │    │                                  │
│  Confluence · Jira       │    │  🔴 wrap_tool_call() on every   │
│  · parallel              │    │  tool invocation:               │
│                          │    │  pre-call injection scan        │
│  🔴 Governance           │    │  post-call PII scan             │
│  Intercept 2             │    │  step logged to audit trail     │
│  Post-retrieval          │    │                                  │
│                          │    │  Hard cap: max 5 iterations      │
│  Context Builder         │    │  Intermediate steps streamed    │
│  dedup · rerank          │    │  to client via SSE              │
│  citation map            │    │                                  │
└──────────┬───────────────┘    └──────────────┬───────────────────┘
           │                                   │
           └──────────────────┬────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         LLM Router                              │
│         route by complexity · sensitivity · cost · SSE          │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                  🔴 Governance — Intercept 3                     │
│   Post-generation: NLI faithfulness · PII in response           │
│                  · compliance disclaimer injection              │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Response + citations                         │
│  streamed to client · confidence score · source map            │
│     · governance flags · agent_iteration count (agentic path)  │
└─────────────────────────────────────────────────────────────────┘
```

### Storage layer

```
┌──────────────────────────────────────────────────────┐
│               Zilliz Cloud (Milvus)                  │
│  Dense + sparse vectors · HNSW · partition keys      │
│           per tenant · 3 collections                 │
├──────────────────────────────────────────────────────┤
│                  Neon (Postgres)                     │
│  Chunk registry · audit log · governance events      │
│  · sessions · eval results · agent step traces       │
├──────────────────────────────────────────────────────┤
│                 Upstash (Redis)                      │
│  Ingestion queue · feedback queue · session memory   │
│  · rate limit counters · agent iteration state       │
├──────────────────────────────────────────────────────┤
│                  Cloudflare R2                       │
│  Raw documents · BM25S index snapshots               │
│               · ingestion artifacts                  │
├──────────────────────────────────────────────────────┤
│             Async ingestion worker                   │
│   Extract · chunk · embed · BM25S index              │
│               · upsert to Zilliz                     │
└──────────────────────────────────────────────────────┘
```

> **ℹ️ Architecture decision — governed hybrid over pure pipeline or pure agent**
>
> A purely agentic architecture was evaluated and rejected: it weakens the governance USP (intercept points become non-deterministic), breaks RAGAS CI as a quality gate (non-deterministic retrieval paths), and cannot meet the P95 < 1.5s latency target for the majority of queries. A purely deterministic pipeline was also insufficient: real enterprise queries frequently require iterative retrieval that a single-pass plan cannot satisfy.
>
> The governed hybrid resolves this: the pipeline handles the fast, auditable majority; the agentic executor handles the complex minority with the same governance guarantees extended to tool-call level. Both paths write to the same audit log with a shared schema. The Query Planner's intent classifier is the routing boundary — this is the only component that determines which path fires.

---

## 5 Component design

### 5.1 Query Planner

The Query Planner classifies query intent and determines execution path. It produces one of two plan types: a `RetrievalPlan` for the deterministic pipeline path, or an `AgentPlan` for the governed agentic loop. This is the only routing boundary between the two execution paths — all downstream components receive a typed plan and execute accordingly.

**Intent classes:**

| Intent class | Typical query pattern | Execution path | Plan type |
|---|---|---|---|
| `single_intent` | Factual lookup, single-source retrieval, keyword-specific | Pipeline | `RetrievalPlan` |
| `cross_system` | Queries spanning internal docs + Confluence + Jira in parallel | Pipeline | `RetrievalPlan` |
| `complex_multi_step` | Comparative analysis, multi-hop reasoning, queries requiring iterative retrieval to determine what to retrieve next | Agentic | `AgentPlan` |

The classifier starts rules-based (Week 3, M1). It can be upgraded to an LLM classifier if rule precision drops below 90% — see Section 16 Q1.

```python
from typing import Union

class QueryPlanner:
    async def plan(
        self, query: str, session: Session
    ) -> Union[RetrievalPlan, AgentPlan]:

        intent = await classify_intent(query)
        # intent.category: single_intent | cross_system | complex_multi_step

        if intent.category == "complex_multi_step":
            return AgentPlan(
                permitted_tools=self._permitted_tools(session),
                max_iterations=5,               # hard cap — enforced by executor
                context_policy=get_context_policy(session),
                token_budget=get_budget(session),
                stream_intermediate=True,       # stream agent steps to client via SSE
            )

        # Pipeline path — single_intent or cross_system
        branches = []
        if intent.needs_internal_docs:
            branches.append(RAGBranch(
                collection=route_collection(intent),
                strategy=select_strategy(intent),   # direct | HyDE | expansion
                limit=budget_chunks(intent)
            ))
        if intent.needs_confluence:
            branches.append(MCPBranch(server="confluence", tool="search_confluence"))
        if intent.needs_jira:
            branches.append(MCPBranch(server="jira", tool="search_issues"))

        return RetrievalPlan(
            branches=branches,
            parallel=True,
            token_budget=get_budget(session)
        )

    def _permitted_tools(self, session: Session) -> list[ToolRef]:
        # Tools available to the agent are scoped by the user's RBAC roles.
        # A user without Confluence access cannot grant the agent Confluence access.
        base = [ToolRef("rag", "search_internal"), ToolRef("rag", "get_chunk")]
        if "confluence:read" in session.roles:
            base += [ToolRef("confluence", "search_confluence"),
                     ToolRef("confluence", "get_page_content")]
        if "jira:read" in session.roles:
            base += [ToolRef("jira", "search_issues"),
                     ToolRef("jira", "get_issue_context")]
        return base
```

**`AgentPlan` type:**

```python
@dataclass
class AgentPlan:
    permitted_tools: list[ToolRef]   # RBAC-scoped tools the agent may call
    max_iterations: int              # hard cap; executor raises AgentCapError on breach
    context_policy: ContextPolicy    # token allocation policy (see Section 16 Q3)
    token_budget: int                # total token budget for all iterations combined
    stream_intermediate: bool        # whether to SSE-stream intermediate steps
```
```

### 5.2 Agentic Executor `[NEW — M2]`

The Agentic Executor runs when the Query Planner produces an `AgentPlan`. It implements a governed iterative loop: the LLM decides which tools to call, the executor calls them through the governance wrapper, accumulates results, and loops until the LLM signals completion or the iteration cap is hit. It is not a general-purpose agent framework — it is a tightly scoped executor with governance enforced on every tool boundary.

#### Governed tool-call loop

```python
class AgenticExecutor:
    async def run(self, query: str, plan: AgentPlan, session: Session) -> AgentResult:
        history: list[Message] = []
        accumulated_context: list[Chunk] = []
        iteration = 0

        while iteration < plan.max_iterations:
            # LLM decides what to do next given query + history + accumulated context
            response = await self.llm.complete(
                system=AGENT_SYSTEM_PROMPT,
                messages=build_messages(query, history, accumulated_context),
                tools=plan.permitted_tools,
            )

            if response.stop_reason == "end_turn":
                break   # LLM satisfied — exit loop

            if response.stop_reason == "tool_use":
                for tool_call in response.tool_calls:
                    result = await self.wrap_tool_call(
                        tool_call, session, plan_run_id, iteration
                    )
                    accumulated_context.extend(result.chunks)
                    history.append(ToolResultMessage(tool_call.id, result))

                    if plan.stream_intermediate:
                        await self.sse.emit("agent_step", {
                            "iteration": iteration,
                            "tool": tool_call.name,
                            "chunk_count": len(result.chunks),
                        })

            iteration += 1

        else:
            # Cap hit — log and continue to final generation with what we have
            await self.audit.log(GovernanceEvent(
                event_type="agent_cap_reached",
                iterations_completed=iteration,
                plan_run_id=plan_run_id,
            ))

        return AgentResult(
            accumulated_context=accumulated_context,
            history=history,
            iterations=iteration,
        )
```

#### `wrap_tool_call()` — governance on every tool invocation

Every tool call the agent makes passes through `wrap_tool_call()`. This is the governance extension point for the agentic path. It applies the same threat model as the pipeline intercepts — pre-call on tool arguments, post-call on tool results — and writes every event to the shared audit log.

```python
async def wrap_tool_call(
    self,
    tool_call: ToolCall,
    session: Session,
    plan_run_id: str,
    iteration: int,
) -> ToolResult:

    # --- Pre-call intercept (mirrors Intercept 1) ---
    injection_scan(tool_call.arguments)       # raise if injection detected in args
    pii_check(tool_call.arguments)            # raise if PII in tool arguments
    rbac_check(tool_call.name, session.roles) # raise if tool not in permitted_tools

    await self.audit.log(GovernanceEvent(
        event_type="agent_tool_pre_call",
        intercept_point="agent_wrap_pre",
        tool_name=tool_call.name,
        agent_iteration=iteration,
        step_index=self.step_counter.next(),
        plan_run_id=plan_run_id,
        user_id=session.user_id,
        tenant_id=session.tenant_id,
    ))

    # --- Execute the tool ---
    raw_result = await self.mcp_client.call(tool_call.name, tool_call.arguments)

    # --- Post-call intercept (mirrors Intercept 2) ---
    clean_result = pii_redact(raw_result)     # redact PII in tool result
    injection_scan(raw_result.content)        # block injection embedded in results

    await self.audit.log(GovernanceEvent(
        event_type="agent_tool_post_call",
        intercept_point="agent_wrap_post",
        tool_name=tool_call.name,
        pii_redacted=raw_result != clean_result,
        agent_iteration=iteration,
        step_index=self.step_counter.next(),
        plan_run_id=plan_run_id,
        user_id=session.user_id,
        tenant_id=session.tenant_id,
    ))

    return clean_result
```

#### Iteration cap and failure modes

| Condition | Behaviour |
|---|---|
| LLM signals `end_turn` | Loop exits cleanly. Final generation proceeds with accumulated context. |
| `max_iterations` reached | `agent_cap_reached` event logged. Final generation proceeds with what was accumulated — response is flagged with `agent_cap_hit: true` in metadata. |
| Tool call injection detected | Tool call aborted. `agent_injection_blocked` event logged. Loop continues — LLM is informed the tool call was blocked. |
| RBAC violation (tool not permitted) | Tool call aborted. `agent_rbac_violation` event logged. Loop continues. |
| LLM token budget exhausted | Loop exits. `agent_budget_exhausted` logged. Partial context used for generation. |

### 5.3 RAG Retriever — Milvus hybrid search

The RAG branch uses Milvus 2.4's native hybrid search — a dense HNSW vector index and a sparse BM25 inverted index queried simultaneously, results fused via Reciprocal Rank Fusion (k=60). A cross-encoder reranker (BGE v2, running in the ingestion worker) re-scores the top-20 candidates before returning the final top-k.

```python
# Milvus hybrid search with RRF fusion
dense_req = AnnSearchRequest(
    data=[query_embedding], anns_field="dense_vec",
    param={"metric_type": "COSINE", "params": {"ef": 128}},
    limit=20, expr=build_rbac_filter(user_roles)
)
sparse_req = AnnSearchRequest(
    data=[bm25_sparse_vector], anns_field="sparse_vec",
    param={"metric_type": "IP"}, limit=20
)
results = collection.hybrid_search(
    reqs=[dense_req, sparse_req],
    rerank=RRFRanker(k=60), limit=10,
    output_fields=["content", "doc_id", "chunk_meta"]
)
```

### 5.4 MCP Retriever branches — pipeline and agent tool registry `[M2]`

Confluence and Jira MCP servers serve dual roles. On the **pipeline path**, they implement the `Retriever` interface and are activated in parallel by the Query Planner — results flow into the Context Builder alongside RAG chunks. On the **agentic path**, they are registered as callable tools in the agent's `permitted_tools` list — the LLM selects them dynamically and calls them through `wrap_tool_call()`.

Adding a future knowledge source (Notion, GitHub, Slack) requires implementing the `Retriever` interface (for pipeline use) and registering the MCP tools (for agent use) — no changes to the Query Planner, Agentic Executor, or downstream components.

| MCP server | Tools exposed | Pipeline use | Agent use |
|---|---|---|---|
| **Confluence** | search_confluence · get_page_content · search_by_label · get_space_tree | RAGBranch-equivalent, parallel retrieval | LLM calls `search_confluence` then `get_page_content` to drill into a specific page |
| **Jira** | search_issues · get_issue_context · get_sprint_context · find_related_issues | Parallel with RAG, JQL + vector fused | LLM calls `search_issues`, reads results, calls `get_issue_context` on specific tickets |

### 5.5 Context Builder `[Expanded from Context Optimizer]`

The Context Builder aggregates results from all activated branches. Its responsibilities expanded when the architecture added parallel branches: it must now deduplicate across sources, rerank across heterogeneous result types, preserve a unified citation map, and allocate the token window budget across sources.

- **Cross-source deduplication:** Remove semantically overlapping chunks across RAG, Confluence, and Jira results before passing to the LLM.
- **Cross-source reranking:** A single relevance score across all branch results using the cross-encoder model.
- **Unified citation map:** Maps each response claim to its source — Milvus chunk ID, Confluence page ID, or Jira issue key.
- **Window budget allocation:** Decides how many tokens to allocate per source when the total exceeds the context window. Compressed via LLMLingua if needed.

### 5.6 Governance — three structural intercepts + tool-call wrapping

Governance is applied at three structurally distinct points on the **pipeline path**, and extended to tool-call level on the **agentic path** via `wrap_tool_call()`. All intercepts write to the same `governance_events` table. Governance is not middleware that can be bypassed — it sits in the request path on both execution routes and failures block further execution.

**Pipeline path intercepts:**

| Intercept | Position | Responsibilities | On detection |
|---|---|---|---|
| **1 — Pre-retrieval** | After gateway, before Planner | Query injection scan · PII in query · policy check · role-based query restriction | Block request · log event · return error to client |
| **2 — Post-retrieval** | After all branches, before Context Builder | Injection in retrieved content · PII in source chunks (redact) · RBAC filter (remove unauthorized chunks) | Redact or remove offending chunks · log event · continue with clean context |
| **3 — Post-generation** | After LLM, before response delivery | NLI faithfulness scoring · PII in response · compliance disclaimer injection | Flag low-faithfulness responses · redact PII · append disclaimer |

**Agentic path — `wrap_tool_call()` intercepts:**

Every MCP tool call the agent makes passes through `wrap_tool_call()` before and after execution. This applies the same threat model as Intercepts 1 and 2 at tool-call granularity:

| Position | Responsibilities | On detection |
|---|---|---|
| **Pre-call** | Injection scan on tool arguments · PII in arguments · RBAC check (tool in permitted_tools) | Abort tool call · log `agent_injection_blocked` or `agent_rbac_violation` · LLM informed · loop continues |
| **Post-call** | PII redaction in tool result · injection scan on returned content | Redact PII in result · block injection · log event · clean result passed to LLM |

Intercept 3 (faithfulness, PII in response, disclaimer injection) fires on the final generated response regardless of which execution path produced it.

**`governance_events` table schema** (append-only, `CHECK` constraint prevents updates):

```sql
CREATE TABLE governance_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type      TEXT NOT NULL,
    intercept_point TEXT NOT NULL,  -- 'pre_retrieval' | 'post_retrieval' | 'post_generation'
                                    -- | 'agent_wrap_pre' | 'agent_wrap_post' | 'agent_cap_reached'
                                    -- | 'agent_injection_blocked' | 'agent_rbac_violation'
                                    -- | 'agent_budget_exhausted'
    user_id         UUID NOT NULL,
    tenant_id       UUID NOT NULL,
    plan_run_id     UUID NOT NULL,   -- ties all events for one query together
    agent_iteration INTEGER,         -- NULL on pipeline path; iteration index on agentic path
    step_index      INTEGER,         -- NULL on pipeline path; monotonic step counter per run
    tool_name       TEXT,            -- NULL on pipeline path; MCP tool name on agentic path
    detected        JSONB,           -- what was found (injection pattern, PII entity type, etc.)
    action_taken    TEXT NOT NULL,   -- 'blocked' | 'redacted' | 'flagged' | 'passed' | 'capped'
    pii_redacted    BOOLEAN NOT NULL DEFAULT FALSE,
    timestamp       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT no_updates CHECK (TRUE)  -- enforced via trigger; see migration
);
```

All governance events are immutable once written. This is the platform's audit surface for compliance teams. On the agentic path, the combination of `plan_run_id` + `agent_iteration` + `step_index` allows a compliance team to reconstruct the full reasoning trace: which tools were called in which order, what was detected at each step, and what action was taken.

### 5.7 Document ingestion pipeline

Ingestion is async and decoupled from the query path. Documents are uploaded to Cloudflare R2, an event is pushed to Upstash Redis, and the Python worker processes the queue independently of the API. The chunking strategy is configurable per document type — this is one of the primary drivers of retrieval quality.

| Strategy | Config | Best for |
|---|---|---|
| **Fixed-size** | 512 tokens · 64 overlap | Homogeneous structured documents · baseline benchmark |
| **Semantic** | Threshold 0.85 · 200–800 token range | Long-form documents · research reports |
| **Hierarchical** | Parent 2048t · child 256t · linked by parent_id | Contracts · legal documents · annual reports |
| **Sentence-window** | Index at sentence · return ±3 window at generate time | QA tasks · highest precision retrieval |

---

## 6 Data flow — query lifecycle

Every query passes through the same gateway, Intercept 1, and Query Planner. The Planner's output determines which lifecycle runs. Every step on both paths is instrumented with an OpenTelemetry span stored in Neon.

### Pipeline path — single_intent and cross_system queries

1. **Query received** — Fastify gateway authenticates JWT, resolves tenant, enforces rate limit and token budget.
2. **Governance intercept 1** — Query screened for injection patterns, PII, and policy violations. Blocked queries return immediately.
3. **Query Planner** — Intent classified as `single_intent` or `cross_system`. `RetrievalPlan` produced: which branches, which collections, which strategy.
4. **Parallel retrieval** — All planned branches fire simultaneously. RAG branch queries Zilliz; MCP branches call Confluence/Jira tools.
5. **Governance intercept 2** — All branch results screened. PII redacted. RBAC filter removes unauthorized chunks. Injection patterns in retrieved content blocked.
6. **Context Builder** — Results merged. Cross-source dedup and rerank. Citation map built. Token window allocated per `ContextPolicy`. Compressed if needed.
7. **LLM Router** — Model selected by query complexity, document sensitivity, and cost threshold. Prompt assembled with context and system instructions.
8. **LLM generation** — Streamed token by token via SSE. Full response accumulated in parallel.
9. **Governance intercept 3** — NLI faithfulness scored against source chunks. PII in response detected. Compliance disclaimer appended.
10. **Response delivery** — Streamed response with citation map, confidence score, and governance flags delivered to client.

### Agentic path — complex_multi_step queries

1. **Query received** — same as pipeline step 1.
2. **Governance intercept 1** — same as pipeline step 2.
3. **Query Planner** — Intent classified as `complex_multi_step`. `AgentPlan` produced: permitted tools (RBAC-scoped), `max_iterations=5`, token budget, streaming flag.
4. **Agentic Executor loop** — begins iteration 0:
   - LLM receives query + accumulated context + tool schemas. Decides next action.
   - If `end_turn`: loop exits, proceeds to step 5.
   - If `tool_use`: for each tool call, `wrap_tool_call()` fires:
     - **Pre-call**: injection scan + PII check + RBAC check on tool arguments. Blocked calls are aborted and logged; LLM is informed.
     - **Tool execution**: MCP tool called.
     - **Post-call**: PII redaction + injection scan on tool result. Logged.
     - Clean result appended to accumulated context and history.
   - Intermediate step streamed to client via SSE (tool name, chunk count, iteration index).
   - Iteration counter incremented. If `max_iterations` reached, `agent_cap_reached` logged and loop exits.
5. **Context Builder** — Accumulated context from all iterations merged, deduped, reranked, citation map built. Same component as pipeline path.
6. **LLM Router + final generation** — Final LLM call over full accumulated context. Streamed via SSE.
7. **Governance intercept 3** — same as pipeline step 9. Fires regardless of which path produced the response.
8. **Response delivery** — Response with citation map, governance flags, and `agent_iterations` count delivered to client.

---

## 7 Technology decisions

| Decision | Choice | Rationale |
|---|---|---|
| **Vector database** | Milvus 2.4 (via Zilliz Cloud) | Native support for both dense and sparse vector fields in a single collection. `hybrid_search` with `RRFRanker` built in. Partition key isolation for multi-tenancy. Same `pymilvus` SDK for local dev and cloud. Zilliz serverless free tier. |
| **Keyword search** | BM25S (in-process, MVP) → Elasticsearch (at scale) | BM25S is a pure Python BM25 library. Runs in the ingestion worker — no separate service, no cost. Index serialised to R2. Equivalent performance under 100K documents. Elasticsearch added when document volume exceeds this threshold. |
| **Retrieval fusion** | Reciprocal Rank Fusion (k=60) | RRF is score-agnostic — robust to the different score distributions of cosine similarity and BM25. Linear weighted combination requires calibration per corpus; RRF does not. k=60 is the standard default with strong empirical performance across benchmarks. |
| **Reranking** | BGE reranker v2 (cross-encoder, in-process) | Cross-encoder reranking scores each candidate against the full query — significantly more accurate than bi-encoder similarity. Running in the worker avoids API cost. ~300MB model weight fits in a 512MB Railway container. |
| **Embedding model** | text-embedding-3-large (routed by doc type) | Matryoshka representation supports truncation to 1536 dims. voyage-code-2 for code-heavy documents (+15% code recall). Embedding model version tracked per chunk in Postgres — enables re-embedding on model upgrade without full re-ingestion. |
| **MCP server framework** | FastMCP (SSE transport) | FastMCP provides a decorator-based interface for defining MCP tools with type-safe schemas. SSE transport is compatible with Railway deployment without WebSocket configuration. Tool schemas are validated at runtime — malformed tool calls fail fast. |
| **API layer** | Fastify + tRPC | tRPC provides end-to-end type safety between the React frontend and the Fastify backend without a schema generation step. Type errors surface at build time, not runtime. Streaming SSE works natively through tRPC subscriptions. |
| **Faithfulness validation** | NLI model (async, post-streaming) | NLI (Natural Language Inference) attributes response claims to source chunks. Run asynchronously after streaming completes to avoid blocking response delivery. Faithfulness score attached to response metadata — low-faithfulness responses flagged but not blocked by default. |
| **Agentic executor** | Custom governed loop (no external agent framework) | LangGraph, AutoGen, and CrewAI were evaluated. None adopted. External agent frameworks abstract the tool-call boundary — the exact point where `wrap_tool_call()` must intercept. A bespoke executor keeps the governance layer as a first-class citizen of the loop, not a post-hoc wrapper. The executor is ~200 lines of typed Python and is independently testable. Iteration cap, RBAC-scoped tool lists, and SSE streaming are explicit in the loop — not implicit framework behaviours. |

---

## 8 Deployment topology

<!-- TODO: remove or replace entire section narrative below before any external share — internal 0→1 phase only. Replace with minimum viable paid-tier topology (~$104/mo) and associated SLA language. -->

The full production system runs on free cloud tiers at MVP scale. Infrastructure cost is $0/month. The only spend is AI API tokens, which are pay-per-use and estimated at $5–25/month under low traffic.

<!-- TODO: remove "Cloud (free tier)" column header and "Limit to watch" column before external share — replace with "Cloud (production tier)" and "SLA" columns. -->

| Component | Local (Docker Compose) | Cloud (free tier) | Limit to watch |
|---|---|---|---|
| **Frontend** | Vite dev server :5173 | Vercel Hobby | 100GB bandwidth/mo |
| **API gateway** | Fastify :3000 | Railway ($5 credit) | $5/mo credit · sleeps on idle |
| **Ingestion worker** | Python worker container | Railway (shared credit) | Shares API credit pool |
| **Confluence MCP** | FastMCP :8001 | Railway (shared credit) | Very low idle usage |
| **Jira MCP** | FastMCP :8002 | Railway (shared credit) | Shares Railway credit |
| **Vector DB** | Milvus standalone | Zilliz Cloud Serverless | 1GB / ~500K vectors |
| **PostgreSQL** | Postgres :5432 | Neon free tier | 0.5GB · auto-suspend |
| **Redis** | Redis :6379 | Upstash free tier | 10K commands/day · 256MB |
| **Object storage** | MinIO | Cloudflare R2 | 10GB · no egress fees |

> **⚠️ Railway sleep behaviour**
>
> Railway free services sleep after 30 minutes of inactivity. A GitHub Actions scheduled workflow (`cron: */25 * * * *`) pings the API health endpoint to prevent sleep. If this proves unreliable, the fallback is Oracle Cloud Always Free — 4 ARM cores, 24GB RAM, no expiry — running the full Docker Compose stack on a single VM permanently at zero cost.

### Environment configuration

Local and cloud environments differ only in environment variables. No code changes are required to deploy. The local `.env.local` points to Docker Compose services; `.env.production` points to the free cloud services. The same SDK calls (pymilvus, Drizzle, ioredis) work identically against both.

### Scale-up path

<!-- TODO: remove free-tier cost references before external share — reframe as "production tier upgrade triggers." -->

Free tier limits are monitored via the cost dashboard (M3). The following upgrades are triggered at specific thresholds and require no architectural changes — only provider swaps:

- >400K vectors → Zilliz Standard ($65/mo) or self-hosted Milvus on Fly.io ($0).
- >400MB Postgres → Neon Pro ($19/mo).
- >100K BM25 documents → Elasticsearch on Railway Pro ($10/mo).
- 4 services approaching $5 credit → Railway Pro ($20/mo) or Oracle Cloud Always Free VM.

---

## 9 Delivery plan

```
┌──────────────────┬──────────────────┬──────────────────┬──────────────────┐
│  MVP · M1        │  M2              │  M3              │  Future          │
│  Production RAG  │  MCP             │  Observability   │  Scale +         │
│  core            │  integrations    │  + evals         │  multi-agent     │
│  Weeks 1–5       │  Weeks 6–9       │  Weeks 10–12     │  Week 13+        │
│  $0 infra        │  +$0 infra       │  +$0 infra       │  paid tiers      │
│  <!-- TODO -->   │  <!-- TODO -->   │  <!-- TODO -->   │  when needed     │
└──────────────────┴──────────────────┴──────────────────┴──────────────────┘
```

<!-- TODO: remove all $0 infra labels from milestone table before any external share — internal 0→1 phase only. -->

### M1 — MVP (Weeks 1–5)

- **Week 1:** Infrastructure setup — Docker Compose, all free tier accounts created, Fastify gateway skeleton, RBAC, auth.
- **Week 2:** Ingestion pipeline — extractors (PDF, DOCX, HTML, Markdown), four chunking strategies, embedding router, BM25S in-process index.
- **Week 3:** Milvus hybrid retrieval — collection schema, HNSW + sparse index, hybrid_search with RRFRanker, cross-encoder reranker. Query Planner — rules-based intent classifier, branch selector, collection router.
- **Week 4:** Three-intercept governance (injection, PII, NLI faithfulness). LLM service with streaming SSE and citation builder. **Feedback loop (thin)** — response thumbs up/down UI, feedback events written to `feedback_queue` in Upstash, consumer worker stores raw signal to `feedback_events` table in Neon. No fixture generation yet — queue seeding only.
- **Week 5:** RAGAS eval suite (30+ fixtures, CI gate). MVP deployed to Railway + Vercel. Context Builder expanded to support multi-source output.

### M2 — MCP integrations + Agentic Executor (Weeks 6–9)

- **Weeks 6–7:** Confluence MCP server — FastMCP, hybrid search, space tools, webhook-driven incremental sync, RBAC. MCP server registered as both a pipeline `Retriever` and an agent tool in the tool registry.
- **Weeks 7–8:** Jira MCP server — FastMCP, semantic + JQL fusion, sprint context tools, nightly + webhook sync. Same dual registration.
- **Week 8:** Agentic Executor — governed iterative loop, `wrap_tool_call()` with pre/post intercepts, RBAC-scoped `permitted_tools` list, hard `max_iterations=5` cap, SSE streaming of intermediate agent steps. Query Planner extended with `complex_multi_step` intent class and `AgentPlan` output type. `governance_events` schema migration: add `agent_iteration`, `step_index`, `tool_name` columns.
- **Week 9:** Integration demo — pipeline path (RAG + Confluence + Jira parallel) and agentic path (multi-step cross-system query) running side by side. Agentic eval harness with 15+ scenario fixtures in CI. Both paths producing governance events with full audit trail. All services deployed to Railway.

### M3 — Observability (Weeks 10–12)

- **Weeks 10–11:** OpenTelemetry instrumentation across both execution paths. Query trace log shows execution path taken (`pipeline` / `agentic`), per-step spans, retrieval scores, and governance events. Governance event viewer (Vercel) — filterable by intercept point, including `agent_wrap_pre` / `agent_wrap_post` events. Retrieval quality dashboard.
- **Week 11:** Cost dashboard — token spend per query/tenant/model/execution-path. Agentic queries tracked separately (higher token cost expected). Cap-hit rate and iteration distribution dashboards. Query Planner misclassification rate tracked (`complex_multi_step` false-positive rate as first-class metric). **Feedback loop (full)** — auto-fixture generation from accumulated `feedback_events` (negative signals → candidate eval fixtures, LLM-as-judge scores and promotes to RAGAS suite or agentic harness based on execution path of original query).
- **Weeks 11–12:** Weekly LLM-as-judge report across both paths. Fixture growth tracking dashboard (fixture count over time, source breakdown by feedback vs manual, pipeline vs agentic split).

---

## 10 Testing strategy

Testing runs in six layers. The RAGAS eval suite is the primary quality gate for the pipeline path. A separate agentic eval harness covers the escalation path. Security fixtures have zero-bypass tolerance on both paths.

| Layer | Mechanism | Runs when | Gate |
|---|---|---|---|
| **Unit tests** | Vitest — individual pipeline steps in isolation | Every PR | All tests pass |
| **RAGAS eval suite** | 30+ fixtures · faithfulness, precision, recall, relevance | Every PR via GitHub Actions | All metrics above threshold |
| **Security evals** | 10 injection variants · PII fixtures · RBAC boundary tests · agent tool-call injection variants | Every PR | Zero bypasses — hard block |
| **Agentic eval harness** | 15+ multi-step scenario fixtures · tool-call sequence correctness · iteration count · governance events fired per run · final answer faithfulness | On agentic executor changes | All scenarios complete within cap · governance events present · faithfulness ≥ threshold |
| **LLM-as-judge** | Claude Sonnet scores 10 sampled production queries (pipeline + agentic paths) | Weekly cron | Score trend tracked · no hard gate |
| **MCP evals** | 20+ fixtures per server · hybrid search quality verified · tool result correctness | On MCP changes | All scenarios pass |

> **Note on RAGAS and the agentic path.** RAGAS eval fixtures assume deterministic retrieval — same query produces the same retrieved chunks. This holds for the pipeline path. The agentic path has non-deterministic tool-call sequences across runs, making RAGAS inapplicable as a hard CI gate for that path. The agentic eval harness instead evaluates: (a) whether the correct tools were called, (b) whether the iteration cap was respected, (c) whether all governance events were written, and (d) whether the final answer is faithful to the accumulated context. These are evaluated using a fixed-seed LLM-as-judge with deterministic scenarios.

#### RAGAS target thresholds

| Metric | Target | Description |
|---|---|---|
| Faithfulness | ≥ 90% | Response claims are grounded in retrieved source chunks |
| Context precision | ≥ 88% | Retrieved chunks are relevant to the query |
| Context recall | ≥ 85% | All information needed to answer was retrieved |
| Answer relevance | ≥ 92% | Generated answer directly addresses the question |

Eval results are cached in Neon by fixture ID and prompt version hash. Re-runs skip LLM calls if the fixture and prompt have not changed, preventing duplicate token spend.

---

## 11 Security and governance

### Prompt injection defense

All user-sourced content (document text, query text, MCP results) is treated as untrusted external input. The injection classifier at Intercept 1 screens for known injection patterns. At Intercept 2, retrieved content is scanned for instruction-like text embedded in documents. All user content is wrapped in XML delimiters in the prompt so structural instruction boundaries are explicit to the model.

On the agentic path, `wrap_tool_call()` applies injection scanning to both tool arguments (pre-call) and tool results (post-call). An attacker who embeds injection instructions in a Confluence page or Jira issue body will have those instructions caught at the post-call intercept before the result enters the LLM's context window — the same threat model as Intercept 2 on the pipeline path, extended to every agent tool boundary.

### Agentic path — additional security controls

The agentic execution path introduces risks not present in the deterministic pipeline. These are mitigated as follows:

| Risk | Mitigation |
|---|---|
| Tool-call injection (malicious instructions in retrieved content direct the agent to call unintended tools) | `wrap_tool_call()` post-call intercept scans every tool result for instruction-like content before it enters the LLM context. Detected content is stripped and logged. |
| RBAC escalation (agent attempts to call a tool outside its permitted set) | `permitted_tools` list in `AgentPlan` is compiled at plan time from the user's RBAC roles. `wrap_tool_call()` pre-call check enforces this — any call to an unpermitted tool is aborted before execution. |
| Runaway iteration (agent loops without converging) | Hard `max_iterations=5` cap enforced by the executor. Cap breach logs `agent_cap_reached` and exits the loop — never waits or retries indefinitely. |
| Token budget exhaustion across iterations | Total token budget is set in `AgentPlan` and tracked across all iterations combined. Budget exhaustion logs `agent_budget_exhausted` and exits the loop gracefully. |
| Sensitive data exfiltration via tool arguments | Pre-call PII check on tool arguments prevents the LLM from passing user PII into external tool calls. |

### PII handling

PII detection uses Microsoft Presidio at both Intercept 1 (query) and Intercept 2 (retrieved content). Detected PII in source chunks is redacted before the chunk enters the context window — the LLM never sees raw PII. Response-level PII detection at Intercept 3 catches any PII that survived earlier stages.

### RBAC and multi-tenancy

Tenant isolation is enforced at the Milvus query layer via partition keys — not post-filter. RBAC rules are compiled to Milvus filter expressions and injected at search time. Documents outside a user's permitted namespaces cannot appear in retrieval results regardless of query content.

### Audit log

All governance events are written to an append-only `governance_events` table in Neon Postgres. The table schema uses a `CHECK` constraint to prevent updates; events can only be inserted. Columns include: event type, intercept point, user ID, tenant ID, what was detected, what action was taken, timestamp, and pipeline run ID for full trace correlation.

### Compliance disclaimer

Compliance disclaimers are injected at the Fastify gateway layer before the response reaches the client — not inside any agent or LLM call. This makes compliance injection structural and deterministic. An agent failure or LLM refusal cannot cause a response to be delivered without the disclaimer.

---

## 12 Performance targets

| Metric | Target | Path | Measurement |
|---|---|---|---|
| P95 end-to-end query latency (pipeline) | < 1.5 seconds to first token | Pipeline only | OpenTelemetry span from gateway receipt to SSE first token |
| P95 time-to-first-agent-step (agentic) | < 3 seconds to first SSE agent step event | Agentic only | Span from gateway receipt to first `agent_step` SSE emission |
| P95 total agentic query duration | < 15 seconds to final token | Agentic only | Span from gateway receipt to final SSE token (all iterations + generation) |
| Milvus HNSW recall@10 | ≥ 95% | Both | Benchmark against FLAT (exact search) on 10M vector test set |
| HNSW P99 search latency | < 10ms at 10M vectors | Both | pymilvus search timing across 1,000 test queries |
| Governance intercept overhead (pipeline) | < 150ms total (all three intercepts) | Pipeline | OpenTelemetry spans per intercept |
| wrap_tool_call() overhead per call | < 40ms (pre + post combined) | Agentic | Span per tool call invocation |
| Ingestion throughput | ≥ 50 pages/minute | — | Worker benchmark on mixed PDF/DOCX corpus |
| Governance false-positive rate | < 5% of legitimate queries blocked | Both | Tracked per intercept point in governance dashboard |

> **Agentic path latency expectations.** Agentic queries are expected and communicated to users as slower than pipeline queries — this is inherent in iterative tool-call execution. Streaming intermediate `agent_step` events to the client via SSE manages this: users see tool calls happening in real time rather than waiting in silence. The 15-second P95 total target assumes an average of 3 iterations at ~4 seconds each (LLM call + tool call + governance overhead). Queries that consistently hit the 5-iteration cap should be reviewed — they may indicate Query Planner misclassification or a query type that cannot be satisfied by available tools.

### Milvus index strategy benchmark

| Index | Recall@10 | P99 latency | Memory (10M vectors) | When to use |
|---|---|---|---|---|
| **HNSW** (default) | 96.2% | 8ms | 60GB | Production — best recall/latency tradeoff |
| **SCANN** | 94.1% | 6ms | 45GB | High-throughput tenants (>1,000 QPS) |
| **IVF_PQ** | 91.3% | 14ms | 8GB | Memory-constrained · >100M vectors |
| **FLAT** | 100% | — | — | Eval fixtures only — brute force, exact |

---

## 13 Risks and mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Milvus hybrid search integration complexity underestimated | 🔴 High | Stage integration: dense-only in Week 2, sparse field added Week 3 separately, reranker added after hybrid search is stable. Each stage independently tested before the next is added. |
| RAGAS scores below target on first run | 🔴 High | Run RAGAS on 10 fixtures with fixed-size chunking at end of Week 2 — baseline before optimization. Chunking strategy and reranking are the primary levers. Early signal prevents a Week 5 surprise. |
| Query Planner misclassifies pipeline query as complex_multi_step | 🔴 High | False positive on `complex_multi_step` routes a fast query through the agentic path, adding 10+ seconds of latency. Classifier tuned conservatively — err toward pipeline. Track misclassification rate as a first-class dashboard metric. LLM classifier evaluated if rule precision drops below 90%. |
| Agentic path governance events incomplete or missing | 🔴 High | `wrap_tool_call()` is the single choke point — all tool calls must pass through it. Unit tests enforce that no `ToolCall` object can be executed outside `wrap_tool_call()`. CI security fixture: a test that calls the MCP client directly (bypassing the wrapper) must be caught and fail. |
| Tool-call injection via Confluence or Jira content | 🔴 High | Post-call injection scan in `wrap_tool_call()` is a hard requirement, not a best-effort check. Security evals include 10+ fixtures where tool results contain embedded injection instructions — zero must reach the LLM context. |
| Query Planner intent misclassification (pipeline path) | 🟡 Medium | Start with rules-based classifier (5 patterns). Track misclassification rate in observability. Replace with LLM classifier if rule precision drops below 90%. Rules are auditable; LLM classifier is not. |
| Agentic loop regularly hitting max_iterations cap | 🟡 Medium | Cap hit rate tracked as a dashboard metric per query type. High cap-hit rate on specific query patterns signals either a missing tool (add it) or a query type the agent cannot satisfy (route to pipeline or return unsatisfied gracefully). |
| Confluence / Jira API rate limits block sync | 🟡 Medium | Incremental webhook-driven sync from day one — not full re-index. Exponential backoff on rate limit errors. Page content cached in Neon with TTL before re-fetching. |
| NLI faithfulness model latency too high | 🟡 Medium | Run faithfulness check async after streaming completes. Score attached to response metadata — visible in UI after the response streams. Does not block delivery. |
| Governance false-positive rate >5% | 🟡 Medium | Injection classifier tuned with 50+ negative examples before deployment. Threshold configurable per tenant. False-positive rate tracked as a first-class dashboard metric. |
| Railway $5 credit exhausted under heavy dev usage <!-- TODO: remove row before external share — dev-phase infra risk only --> | 🟡 Medium | Monitor Railway dashboard weekly. Run ingestion worker on-demand during early development. Fallback: Oracle Cloud Always Free VM (4 ARM, 24GB, no expiry) runs full stack at $0. |
| BGE reranker 300MB exceeds Railway 512MB RAM <!-- TODO: remove row before external share — dev-phase infra risk only --> | 🟢 Low | Measure actual footprint in Week 3. Upgrade worker to 1GB ($2/mo) or use Cohere Rerank API ($0.001/query) as fallback. |
| Neon auto-suspend adds 1s cold start to P95 latency <!-- TODO: remove row before external share — dev-phase infra risk only --> | 🟢 Low | Keep-warm query in the Railway keep-alive cron — same action that pings API health also queries Neon to prevent suspension. |

---

## 14 Alternatives considered

### Vector database — Qdrant, Pinecone, Weaviate

Qdrant was evaluated and offers a strong free cloud tier (1GB). It was not selected because Milvus 2.4 provides native sparse vector fields and a built-in `hybrid_search` API with `RRFRanker` — avoiding the need to implement RRF in application code. Pinecone has no free tier at production-useful scale. Weaviate's hybrid search is mature but its Python SDK has a different abstraction that would require more adaptation.

### Elasticsearch for BM25

Elasticsearch was the original plan for keyword search. Replaced at MVP with BM25S — a pure Python library that runs in the ingestion worker with no separate service. BM25S serialises the index to Cloudflare R2 and loads at worker startup. Performance is equivalent under 100K documents. Elasticsearch is the planned upgrade path once volume exceeds that threshold.

### LangChain / LlamaIndex as orchestration framework

Both frameworks were evaluated. Neither was adopted. LangChain's abstraction layer obscures retrieval decisions that this platform needs to measure and control explicitly — chunking strategies, RRF fusion, cross-encoder reranking, and governance intercepts all require direct control of the pipeline. LlamaIndex has similar concerns. The platform implements its own orchestration using typed Python and TypeScript, with each component independently testable.

### Single-layer governance

The original design (and the reviewer's suggested diagram) showed governance as a single layer. This was rejected because pre-retrieval, post-retrieval, and post-generation represent fundamentally different threat models: a query screening different concerns from content embedded in retrieved documents, which is different from validating generated text against sources. Collapsing them into one layer would make the system untestable as individual components and would remove the post-retrieval and post-generation safety nets.

### Fully agentic architecture vs governed hybrid

A fully agentic architecture — where every query is handled by an LLM-driven tool-calling loop with no deterministic pipeline — was evaluated and rejected for three reasons.

**Governance auditability collapses.** The three-intercept pipeline works because intercept positions are structurally fixed and deterministic. In a pure agent, the LLM decides when and what to retrieve — intercept positions become non-deterministic and the audit trail becomes a sequence of opaque events rather than a structured trace a compliance team can read.

**RAGAS CI gate breaks.** The pipeline's quality certificate depends on deterministic retrieval paths: same fixture produces same retrieved chunks, faithfulness is measurable. A pure agent has non-deterministic tool-call sequences across runs, making RAGAS inapplicable as a hard CI gate.

**Latency is incompatible with single-intent queries.** ~75–80% of enterprise queries are single-intent lookups that a one-pass retrieval answers correctly in < 1.5 seconds. Routing all queries through an agentic loop adds 3–5× latency and LLM cost for no quality benefit on that majority.

The governed hybrid resolves this without compromising the governance USP: the deterministic pipeline handles the fast, auditable majority; the agentic executor handles the complex minority with governance extended to tool-call level via `wrap_tool_call()`. The pipeline is the product. Agency is the controlled escape valve.

### External agent frameworks — LangGraph, AutoGen, CrewAI

All three were evaluated for the agentic executor. None adopted. All three abstract the tool-call boundary — the exact point where `wrap_tool_call()` must intercept. The executor is ~200 lines of typed Python and is independently testable; adopting a framework would embed governance logic inside framework abstractions that cannot be audited by a compliance team. Governance is not a plugin — it is the loop.

---

## 15 Competitive landscape

This section compares the platform against commercial products an enterprise buyer would evaluate. The alternatives in Section 14 cover open-source tooling decisions; this covers the buy-vs-build decision and direct commercial competition. "We win" and "we lose" assessments are honest — the goal is to understand where to compete, not to claim universal superiority.

| Competitor | Retrieval quality | Governance depth | Auditability | Observability | We win because | We lose because |
|---|---|---|---|---|---|---|
| **Glean** | Strong — proprietary connector graph across 100+ SaaS apps | Shallow — SSO/RBAC for access control only; no per-response governance intercepts at retrieval or generation layer | None — no audit trail of what was retrieved, why, or what governance checks fired | None exposed to buyers — black-box model calls | Three-intercept governance is architecturally enforced, not a feature flag. Append-only `governance_events` log per response. RAGAS CI quality gate gives a verifiable quality SLA that Glean cannot offer. Prompt injection embedded in retrieved documents is caught at Intercept 2 — Glean has no equivalent. | Glean's connector breadth (100+ SaaS integrations) is years of engineering. We launch with Confluence + Jira only. For non-regulated enterprises where coverage beats auditability, Glean wins. Glean also ships a polished end-user search UI we do not have at MVP. |
| **Vectara** | Strong — Boomerang embedding + HHEM faithfulness scoring built in | Partial — HHEM detects hallucinations post-generation only; no pre-retrieval or post-retrieval intercepts | Partial — query logs available but no structured governance event schema; not compliance-grade | Limited — retrieval scores exposed via API, no governance event stream | Governance depth: Vectara has one intercept (post-generation); we have three. Our three-intercept model catches prompt injection embedded in source documents at Intercept 2 — a threat Vectara's post-generation HHEM cannot detect. Audit log is append-only, queryable by the customer's compliance team, not locked in a vendor portal. | Vectara is a fully managed service with zero infra burden. Our platform requires deployment and operations. Vectara's Boomerang embedding is production-proven and strong. For buyers in non-regulated industries who want managed SaaS, Vectara is lower-friction. |
| **Microsoft 365 Copilot** | Strong on Microsoft Graph — weak on non-Microsoft knowledge sources | Deep within Microsoft Purview ecosystem — but governance is at the data-access layer, not the generation layer. Purview DLP does not audit individual AI generation decisions. | Microsoft Purview audit logs cover data access events; generation-layer decisions (what was retrieved, what faithfulness score was produced, what governance checks fired) are not individually auditable per query | Poor — no retrieval explainability; no per-query trace exposed to the buyer | Generation-layer auditability: Copilot cannot provide a per-query record of retrieved chunks, governance intercepts fired, and faithfulness score. For regulated industries requiring an AI decision audit trail, Copilot does not satisfy the requirement. Retrieval is fully explainable. Non-Microsoft sources (Confluence, Jira, internal docs) are first-class citizens, not connectors. | Zero-deployment for M365 tenants. Deep Office integration we cannot match. For organisations already on Azure, SSO and security perimeter are already solved. This is the most dangerous long-term competitor — Microsoft's distribution moat is significant. |
| **Cohere (enterprise RAG)** | Strong — Embed v3 + Command R+ with built-in RAG grounding and citation generation | Shallow — input/output safety filters applied API-side; no structural multi-intercept architecture; governance implementation is opaque | Basic request logging; no governance event schema; audit capability depends on enterprise contract terms not publicly documented | Good — grounding citations returned per response; no governance event stream | Governance is structural and customer-verifiable — not dependent on Cohere's internal trust practices. Buyers in regulated industries can audit our governance code; they cannot audit Cohere's. RAGAS eval suite in CI is verifiable quality assurance Cohere offers no equivalent of. Platform is self-hostable. | Cohere's embedding and generation models (Embed v3, Rerank 3, Command R+) are among the strongest available. We depend on third-party model providers and inherit their limitations and pricing. Cohere offers enterprise SLAs and dedicated support we cannot match at this stage. |

### Summary positioning

The platform wins on **governance depth**, **generation-layer auditability**, and **retrieval transparency**. It loses on **connector breadth**, **managed-service simplicity**, and **enterprise SLAs**. The right beachhead is regulated-industry buyers — fintech, legal, pharma, healthcare — who need an immutable AI decision audit trail, cannot accept a black-box vendor, and have the engineering capacity to deploy and operate the platform. Microsoft Copilot is the highest-priority competitor to monitor: it will close the auditability gap over time and has unmatched enterprise distribution.

---

## 16 Open questions

1. **Query Planner upgrade path.** The rules-based intent classifier now handles three classes: `single_intent`, `cross_system`, `complex_multi_step`. At what misclassification rate (particularly false positives on `complex_multi_step`) does it make sense to replace it with an LLM classifier? What are the latency and cost implications of an LLM planning step on every query, given that the planning step now gates which execution path fires?
2. **Cross-source reranking model.** The BGE cross-encoder is trained on text similarity. How does it perform when reranking heterogeneous results — a Milvus document chunk alongside a Jira issue summary? Should a domain-specific reranker be evaluated?
3. **Context window allocation policy. ✅ DECIDED — see below.**

   **Decision:** Relevance-score-ranked allocation with a per-source floor, configurable per tenant.

   **Default policy:** The context window is divided as follows. Each active retrieval branch (RAG, Confluence MCP, Jira MCP) is guaranteed a minimum floor of 10% of the available context budget regardless of score — this prevents a high-scoring single source from starving other branches entirely. The remaining 70% is allocated proportionally to branches based on their top-chunk RRF score normalised across branches. Within each branch, chunks are taken in descending RRF score order until that branch's budget is consumed.

   **Configuration:** Tenants may override the floor percentage and the proportional weighting via a `context_policy` object in their tenant config:

   ```typescript
   interface ContextPolicy {
     floor_pct_per_branch: number;      // default: 0.10
     allocation_mode: 'score_weighted' | 'equal' | 'custom_weights';
     custom_weights?: Record<BranchId, number>;  // only for 'custom_weights' mode
     max_chunks_per_branch?: number;    // hard cap regardless of budget
   }
   ```

   Equal allocation (`allocation_mode: 'equal'`) is available for tenants who prefer predictability over relevance-ranked allocation. Custom weights allow tenants to bias toward a specific source (e.g., always prioritise internal docs over Jira). The chosen policy and resulting per-branch token allocation are logged as part of the query trace for auditability. On the agentic path, `ContextPolicy` governs the final Context Builder merge — not individual tool-call results, which are accumulated iteratively.

4. **Faithfulness gate aggressiveness. ✅ DECIDED — see below.**

   **Decision:** Block below threshold and retry with expanded retrieval. Threshold is configurable per tenant with a safe default.

   **Default behaviour:** NLI faithfulness is scored at Intercept 3 after generation. The default block threshold is **0.65** (i.e., responses where fewer than 65% of generated claims are attributed to retrieved source chunks are blocked). A blocked response triggers an automatic single retry: the Context Builder re-runs with `limit` increased by 50% and a lower RRF fusion score cutoff, giving the LLM more source material. If the retry score also falls below threshold, the response is delivered with a `low_faithfulness` governance flag and a mandatory disclaimer injected at the gateway layer. The flag and both scores are written to the `governance_events` audit log.

   **Threshold configuration:** Tenants in regulated industries should set a higher block threshold (recommended: 0.80). The threshold is set in tenant config:

   ```typescript
   interface FaithfulnessPolicy {
     block_threshold: number;           // default: 0.65; recommended for regulated: 0.80
     retry_on_block: boolean;           // default: true
     retry_limit_multiplier: number;    // default: 1.5 (50% more chunks on retry)
     deliver_flagged_if_retry_fails: boolean; // default: true; set false to hard-block
   }
   ```

   Setting `deliver_flagged_if_retry_fails: false` enables a hard-block mode where low-faithfulness responses are never delivered to the client — the user receives an explicit "insufficient grounding" error instead. Recommended for regulated industries where a hallucinated answer is a compliance event. All threshold decisions, retry outcomes, and delivery decisions are written to `governance_events`. On the agentic path, the faithfulness gate fires on the final generated response and is applied identically — the fact that context was accumulated over multiple iterations does not change the gate behaviour.

5. **Chunking strategy selection automation.** Currently the strategy is configured per document type. Could document characteristics (length, structure, vocabulary density) be used to automatically select the optimal chunking strategy at ingest time?
6. **Multi-agent extension and abstraction boundary. ✅ DECIDED — governed hybrid adopted.**

   The question of the right abstraction boundary between the pipeline and an agent layer is resolved by the governed hybrid execution model adopted in this RFC revision. The boundary is the Query Planner's output type: `RetrievalPlan` routes to the deterministic pipeline; `AgentPlan` routes to the Agentic Executor. The Agentic Executor is not a general-purpose agent — it is a governed iterative loop scoped to MCP tool calls, with `wrap_tool_call()` as the governance enforcement point.

   Debate-based multi-agent reasoning (multiple agents arguing over conflicting retrieved content) remains a future-phase consideration. The current Agentic Executor is single-agent. If debate-based reasoning is added, the abstraction boundary is: the Agentic Executor becomes the orchestrator; individual reasoning agents receive governed context from it and write their outputs back through the same `wrap_tool_call()` interface. The governance model does not change — the surface area of `wrap_tool_call()` expands to inter-agent communication.

---

*RFC-001 · Enterprise RAG Platform with AI Governance*
*Status: Draft · Version 1.1.0 · April 2026*
*Review comments welcome — open a GitHub discussion or contact the author directly.*

---
*Architecture reviewed and adapted · Query Planner extended with three intent classes and AgentPlan output type · Agentic Executor added (governed iterative loop, wrap_tool_call()) · governance_events schema extended with agent_iteration + step_index · Retriever interface unified across RAG + MCP (pipeline and agent tool registry) · Governed hybrid execution model adopted — pure pipeline and pure agent alternatives documented and rejected*


