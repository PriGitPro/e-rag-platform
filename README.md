# Enterprise RAG Platform

A production-oriented Retrieval-Augmented Generation platform built for enterprise knowledge management. Designed for governed, multi-tenant RAG with hybrid retrieval, full audit trails, and a clear path to agentic query execution.

---

## What is this?

Most RAG demos retrieve text and call it done. This platform treats retrieval as an **enterprise infrastructure problem**: multi-tenant data isolation, immutable governance audit logs, hybrid dense+sparse retrieval, LLM-agnostic inference, and a rules-based query planner that will eventually route complex queries to agent pipelines with MCP server tooling.

**Current state (proto01):** Ingestion pipeline is live. Hybrid retrieval with BGE reranking works. LLM generation is not yet wired — the query endpoint returns ranked chunks. The UI shows real retrieval results.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Browser  →  Vite UI (port 5173)                            │
└─────────────────────┬───────────────────────────────────────┘
                      │ /api/* proxy
┌─────────────────────▼───────────────────────────────────────┐
│  Fastify API Gateway  (TypeScript, port 3000)               │
│  JWT auth · RBAC · rate-limit · token-budget guard          │
│  POST /v1/query   → proxies to query-service                │
│  POST /v1/ingest  → pushes job to Redis queue               │
│  GET  /health     → checks Postgres + Redis                 │
│  GET  /dev/token  → test JWT (dev only)                     │
└──────────┬──────────────────────┬───────────────────────────┘
           │                      │
    ┌──────▼──────┐        ┌──────▼──────────────────────────┐
    │  Redis      │        │  Query Service  (Python, :8000)  │
    │  (job queue)│        │  Planner → hybrid_search → rerank│
    └──────┬──────┘        │  FastAPI · uvicorn               │
           │               └──────────────┬──────────────────┘
    ┌──────▼──────────────────────────────▼──────────────────┐
    │  Ingestion Worker  (Python)                             │
    │  extract → chunk → embed → Milvus upsert → BM25 index  │
    │  BLPOP loop on Redis queue                              │
    └──────────────────────────────────────────────────────── ┘
           │                              │
    ┌──────▼──────┐               ┌───────▼─────────┐
    │  MinIO/R2   │               │  Milvus          │
    │  raw files  │               │  dense+sparse    │
    │  BM25 index │               │  tenant partitions│
    └─────────────┘               └──────────────────┘
           │
    ┌──────▼──────┐
    │  Postgres   │
    │  tenants    │
    │  documents  │
    │  chunks     │
    │  governance │
    └─────────────┘
```

### Services

| Service | Port | Language | Purpose |
|---|---|---|---|
| `api-gateway` | 3000 | TypeScript | Authenticated entry point, rate limiting, token budgets |
| `query-service` | 8000 | Python | Hybrid retrieval, BGE reranker, query planner |
| `ingestion-worker` | — | Python | Document ETL: extract → chunk → embed → index |
| `web` | 5173 | React/Vite | Developer test UI |
| `postgres` | 5432 | — | Documents, chunks, governance events |
| `redis` | 6379 | — | Ingestion job queue |
| `minio-r2-local` | 9010 | — | Local R2 stand-in (raw docs + BM25 index) |
| `milvus-standalone` | 19530 | — | Vector store (dense HNSW + sparse BM25) |

---

## Local setup

### Prerequisites
- Docker Desktop ≥ 4.25
- Node.js ≥ 20
- Python ≥ 3.12 (for running workers outside Docker)
- An OpenAI API key

### 1. Clone and install Node deps

```bash
git clone <repo>
cd enterprise-rag-platform
npm install
```

### 2. Configure environment

```bash
cp .env.local.example .env.local   # if example exists, else .env.local is in .gitignore
# Edit .env.local and set OPENAI_API_KEY=sk-...
```

Key variables in `.env.local`:

```bash
OPENAI_API_KEY=sk-...              # required for embedding + LLM
LLM_PROVIDER=openai                # or: ollama
LLM_MODEL=gpt-4o                   # or: llama3.2
RERANKER_ENABLED=true              # false to skip BGE (saves ~500 MB RAM)
```

### 3. Start all services

```bash
docker compose -f infra/docker-compose.yml up --build
```

Services come up in order (healthcheck gates). First build takes ~5 minutes (PyTorch layer).

### 4. Open the UI

```
http://localhost:5173
```

Click **Get Dev Token** → paste a storageKey → queue an ingestion job → run a query.

### 5. Test the API directly

```bash
# Health check
curl localhost:3000/health

# Get dev token
TOKEN=$(curl -s localhost:3000/dev/token | jq -r .token)

# Queue an ingestion job (file must already be in MinIO)
curl -s -X POST localhost:3000/v1/ingest \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"filename":"policy.pdf","mimeType":"application/pdf","sizeBytes":102400,"storageKey":"docs/policy.pdf"}'

# Query (returns ranked chunks)
curl -s -X POST localhost:3000/v1/query \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"What is our data retention policy?","topK":5}' | jq .
```

---

## Using Ollama instead of OpenAI

```bash
# Start with Ollama sidecar
docker compose -f infra/docker-compose.yml --profile ollama up

# Pull a model (one-time, ~2 GB)
docker exec erp-ollama ollama pull llama3.2

# Update .env.local
LLM_PROVIDER=ollama
LLM_MODEL=llama3.2
OLLAMA_BASE_URL=http://ollama:11434

# Restart app services
docker compose -f infra/docker-compose.yml restart api-gateway ingestion-worker query-service
```

GPU passthrough: uncomment the `deploy.resources` block in `infra/docker-compose.yml` for the `ollama` service.

---

## Ingestion pipeline

```
MinIO (storageKey) → Extractor → Chunker → OpenAI Embedder → Milvus + Postgres + BM25
```

**Supported formats:** PDF (pypdf), DOCX (python-docx), Markdown, HTML (BeautifulSoup)

**Chunking:** Fixed-size 512 tokens with 20% overlap (default). Semantic/sentence/hierarchical strategies are stubbed behind `CHUNK_STRATEGY` env var — implement only if RAGAS shows they improve recall.

**Embedding:** `text-embedding-3-large` (1536 dims). Model version stored per-chunk in Postgres so re-embedding doesn't require re-ingestion.

**Milvus schema (`erp_chunks`):**
- `dense` — FLOAT_VECTOR(1536), HNSW (M=16, efConstruction=200, COSINE)
- `sparse` — SPARSE_FLOAT_VECTOR, SPARSE_INVERTED_INDEX (IP)
- Partition key: `tenant_id` (64 partitions, automatic hash routing)

---

## Retrieval pipeline

```
Query → embed + sparse encode → Milvus hybrid_search (RRF k=60) → Postgres hydrate → BGE rerank → top_k chunks
```

**Query planner** (rules-based, no LLM yet):

| Intent | Trigger | Current routing |
|---|---|---|
| `single_intent` | default | `RetrievalPlan` → retriever |
| `cross_system` | "compare", "vs", "across systems" | `RetrievalPlan` (fallback until M2 MCP servers) |
| `complex_multi_step` | "step by step", "walk me through" | `RetrievalPlan` (fallback until M2 MCP servers) |

**BGE Reranker v2** (`BAAI/bge-reranker-v2-m3`):
- Cross-encoder rescoring after RRF fusion
- ~500 MB RAM budget (model + PyTorch). Disable with `RERANKER_ENABLED=false` on memory-constrained infra.
- Railway: requires Pro plan (8 GB). Starter (512 MB) will OOM with reranker enabled.

---

## Database schema

```sql
tenants       id, name, created_at
documents     id, tenant_id, filename, mime_type, storage_key, byte_size, status, created_at, updated_at
chunks        id, document_id, tenant_id, chunk_index, content, token_count, embedding_id, embedding_model, created_at
governance_events  (append-only, trigger-protected)
              id, event_type, tenant_id, user_id, plan_run_id, detected, action_taken, pii_redacted, timestamp
```

Migrations run automatically via `docker-entrypoint-initdb.d` on first Postgres container start.

---

## Auth

JWT (`@fastify/jwt`). Token payload:

```json
{
  "sub": "user-uuid",
  "tenantId": "tenant-uuid",
  "roles": ["rag:query", "rag:ingest", "admin"],
  "tokenBudget": 4000
}
```

In development, `GET /dev/token` returns a signed 24h token for the hardcoded test tenant (`00000000-0000-0000-0000-000000000001`). This endpoint is disabled in `NODE_ENV=production`.

---

## Project structure

```
apps/
  api-gateway/          TypeScript Fastify gateway
    src/
      plugins/          jwt, redis, rate-limit
      middleware/       auth, rbac, token-budget
      routes/           health, query, ingest, devToken
  ingestion-worker/     Python ingestion + query pipeline
    src/
      extractors/       pdf, docx, markdown, html
      llm/              openai + ollama providers
      chunker.py        fixed-size (semantic/sentence stubs)
      embedder.py       text-embedding-3-large
      bm25_index.py     BM25S corpus + MinIO persistence
      retriever.py      hybrid_search + BGE rerank
      planner.py        rules-based intent classifier
      query_server.py   FastAPI /retrieve endpoint
      worker.py         Redis BLPOP ingestion loop
  web/                  React + Vite test UI
infra/
  docker-compose.yml    all services
migrations/
  0001_init.sql         tenants, documents, chunks, governance_events
  0002_embedding_metadata.sql  adds embedding_model column
```

---

## Roadmap (from RFC-001)

| Week | Focus |
|---|---|
| **1 (done)** | Docker stack, Fastify gateway, JWT auth, Postgres schema |
| **2 (done)** | Ingestion pipeline: extractors, chunking, embedding, Milvus, BM25 |
| **proto01 (done)** | Hybrid retrieval, BGE reranker, query planner, test UI |
| **3** | LLM generation pass (answer from chunks), governance intercepts (PII, faithfulness NLI) |
| **4** | Frontend production UI, RBAC scoping per tenant, streaming responses |
| **5** | RAGAS evaluation harness, chunking strategy benchmarks, HNSW tuning |
| **M2** | MCP server integrations (Confluence, Jira, Slack) — routes `cross_system` and `complex_multi_step` intents to AgentPlan |
| **Q1** | LLM-based query classifier (replaces rules), requires labelled traffic data |

---

## Configuration reference

| Variable | Default | Description |
|---|---|---|
| `NODE_ENV` | `development` | Enables dev-only endpoints in non-production |
| `PORT` | `3000` | API gateway port |
| `JWT_SECRET` | *(dev default)* | JWT signing secret — change in production |
| `DATABASE_URL` | postgres://... | Postgres connection string |
| `REDIS_URL` | redis://... | Redis connection string |
| `MILVUS_URI` | http://... | Milvus / Zilliz Cloud endpoint |
| `OPENAI_API_KEY` | — | Required for embedding (and LLM if `LLM_PROVIDER=openai`) |
| `LLM_PROVIDER` | `openai` | `openai` or `ollama` |
| `LLM_MODEL` | `gpt-4o` | Model name for whichever provider is active |
| `OLLAMA_BASE_URL` | http://localhost:11434 | Ollama base URL |
| `QUERY_SERVICE_URL` | http://localhost:8000 | Python query service URL (api-gateway → query-service) |
| `RERANKER_ENABLED` | `true` | Set `false` to skip BGE reranking (saves ~500 MB RAM) |
| `RERANKER_MODEL` | `BAAI/bge-reranker-v2-m3` | HuggingFace reranker model |
| `CHUNK_SIZE` | `512` | Chunk size in characters |
| `CHUNK_OVERLAP_PCT` | `0.2` | Overlap fraction (0.2 = 20%) |
| `CHUNK_STRATEGY` | `fixed` | `fixed` only for now; `semantic`/`sentence`/`hierarchical` stubbed |
| `S3_ENDPOINT` | http://minio-r2-local:9000 | S3-compatible storage endpoint |
| `S3_BUCKET` | `erp-documents` | Bucket for raw docs and BM25 index |

---

## For non-technical readers

**What this does in plain English:** You upload documents (PDFs, Word docs, web pages). The platform breaks them into searchable pieces, creates a mathematical fingerprint for each piece, and stores them in a fast search index. When someone asks a question, the system finds the most relevant pieces using two different search methods simultaneously, then a second AI model re-ranks those pieces by relevance. The result is the best-matched text fragments from your document library — ready to be used as context for an AI answer.

**Why it's built this way:**
- *Multi-tenant:* Your company's documents are isolated from other tenants at the database and vector store level.
- *Governed:* Every query and retrieval action is logged in an append-only audit trail that cannot be modified.
- *Hybrid search:* Combines semantic similarity (meaning-based) with keyword matching (BM25) — neither alone is as good as both together.
- *LLM-agnostic:* Swap between OpenAI and local Ollama models with two environment variables. Same code runs either way.

**What's not built yet:** LLM answer generation (Week 3), production RBAC UI (Week 4), automated quality evaluation (Week 5), and MCP server integrations for Jira/Confluence/Slack (Milestone 2).
