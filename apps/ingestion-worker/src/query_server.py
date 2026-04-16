"""
Query HTTP service — FastAPI app served by uvicorn.

This process is separate from the BLPOP ingestion worker.
Both share the same Docker image; the entrypoint differs:
  worker.py       → ingestion loop
  query_server.py → HTTP query service

Endpoints
─────────
  POST /retrieve         — hybrid search + rerank (sync, backward-compatible)
  POST /retrieve/stream  — hybrid search + MCP tools + governed agent loop (SSE)
  GET  /health           — liveness probe
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import asdict

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from agent_executor import AgentExecutor, ToolSpec
from db import get_conn
from governance import GovernanceIntercept2
from llm.base import Message
from llm_router import LLMRouter
from mcp_tools import ConfluenceMCPClient, JiraMCPClient, gather_pipeline_context
from planner import AgentPlan, RetrievalPlan, plan_query
from retriever import Retriever

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("query_server")

_retriever: Retriever | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _retriever
    logger.info("Initialising retriever (loading reranker if enabled)…")
    last_err: Exception | None = None
    for attempt in range(1, 11):
        try:
            _retriever = Retriever()
            break
        except Exception as exc:
            last_err = exc
            wait = attempt * 3
            logger.warning(
                "Retriever init attempt %d/10 failed (%s); retrying in %ds…",
                attempt, exc, wait,
            )
            await asyncio.sleep(wait)
    else:
        raise RuntimeError(
            f"Milvus unavailable after 10 attempts — last error: {last_err}"
        )
    logger.info("Query server ready")
    yield
    logger.info("Query server shutting down")


app = FastAPI(
    title="ERP Query Service",
    description="Hybrid retrieval + BGE reranker endpoint for the RAG pipeline",
    version="0.2.0",
    lifespan=lifespan,
)


# ── Request / response models ────────────────────────────────────────────────────

class RetrieveRequest(BaseModel):
    query: str = Field(..., min_length=1, description="Natural language query")
    tenant_id: str = Field(..., description="Tenant UUID — results are scoped to this tenant")
    top_k: int = Field(default=5, ge=1, le=20)


class RetrieveResponse(BaseModel):
    query: str
    intent: str
    plan_type: str
    chunks: list[dict]
    chunk_count: int
    latency_ms: float


class StreamRetrieveRequest(BaseModel):
    query: str = Field(..., min_length=1, description="Natural language query")
    tenant_id: str = Field(..., description="Tenant UUID")
    user_id: str = Field(..., description="Authenticated user UUID — required for governance audit")
    plan_run_id: str | None = Field(default=None, description="Caller-supplied run ID; auto-generated if absent")
    top_k: int = Field(default=5, ge=1, le=20)
    use_llm_classifier: bool = Field(
        default=True,
        description="Use LLMIntentClassifier to route cross_system / complex_multi_step to AgentPlan",
    )


# ── Existing sync endpoint (unchanged) ──────────────────────────────────────────

@app.post("/retrieve", response_model=RetrieveResponse)
def retrieve(req: RetrieveRequest) -> RetrieveResponse:
    t0 = time.monotonic()

    plan = plan_query(req.query, req.tenant_id, req.top_k)

    if isinstance(plan, AgentPlan):
        # AgentPlan executor requires use_llm_classifier=True (POST /retrieve/stream).
        raise HTTPException(
            status_code=501,
            detail=(
                f"Intent '{plan.intent}' requires AgentPlan executor. "
                "Use POST /retrieve/stream with use_llm_classifier=true."
            ),
        )

    assert isinstance(plan, RetrievalPlan)
    chunks = _retriever.retrieve(plan.query, plan.tenant_id, plan.top_k)  # type: ignore[union-attr]

    latency_ms = (time.monotonic() - t0) * 1000
    return RetrieveResponse(
        query=req.query,
        intent=plan.intent.value,
        plan_type="RetrievalPlan",
        chunks=[asdict(c) for c in chunks],
        chunk_count=len(chunks),
        latency_ms=round(latency_ms, 1),
    )


# ── Streaming SSE endpoint ───────────────────────────────────────────────────────

@app.post("/retrieve/stream")
async def retrieve_stream(req: StreamRetrieveRequest) -> StreamingResponse:
    """
    Hybrid retrieval + MCP tools + governed agent loop, streamed as Server-Sent Events.

    SSE event types: thought, tool_call, tool_result, governance, chunk, done
    Each event: data: <json>\\n\\n
    """
    return StreamingResponse(
        _stream_generator(req),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # disable nginx buffering for true streaming
        },
    )


async def _stream_generator(req: StreamRetrieveRequest):
    """Async generator that drives both the Pipeline Path and the Agentic Path."""
    plan_run_id = req.plan_run_id or str(uuid.uuid4())

    plan = plan_query(
        req.query,
        req.tenant_id,
        req.top_k,
        use_llm_classifier=req.use_llm_classifier,
    )
    logger.info(
        "plan_run_id=%s intent=%s plan=%s",
        plan_run_id, plan.intent.value, type(plan).__name__,
    )

    # Always run vector retrieval — provides base context for both paths.
    retrieval_chunks = _retriever.retrieve(plan.query, plan.tenant_id, plan.top_k)  # type: ignore[union-attr]
    retrieval_context = "\n\n".join(c.content for c in retrieval_chunks)

    if isinstance(plan, RetrievalPlan):
        async for sse in _pipeline_path(req, plan_run_id, retrieval_context):
            yield sse
    else:
        assert isinstance(plan, AgentPlan)
        async for sse in _agentic_path(req, plan_run_id, retrieval_context):
            yield sse


async def _pipeline_path(
    req: StreamRetrieveRequest,
    plan_run_id: str,
    retrieval_context: str,
):
    """
    Pipeline Path (single_intent):
      1. Parallel MCP context fetch (Jira + Confluence)
      2. GovernanceIntercept2 on combined context
      3. LLMRouter selects model
      4. Stream final answer as SSE chunks
    """
    yield f"data: {json.dumps({'type': 'thought', 'content': 'Gathering context from connected systems...'})}\n\n"

    mcp_context = await gather_pipeline_context(req.query, req.tenant_id)
    combined = _build_pipeline_context(retrieval_context, mcp_context)

    conn = get_conn()
    try:
        intercept2 = GovernanceIntercept2(req.user_id, req.tenant_id, plan_run_id)
        filtered_context, gov_result = intercept2.filter_context(combined, conn=conn)
    finally:
        conn.close()

    if gov_result.is_flagged:
        _ptypes = list({d.pattern_type for d in gov_result.detected})
        yield f"data: {json.dumps({'type': 'governance', 'flagged': True, 'action': 'redacted', 'pattern_types': _ptypes, 'detected_count': len(_ptypes)})}\n\n"

    governance_flags = ["pii_detected"] if gov_result.is_flagged else []
    llm = LLMRouter.route(filtered_context, governance_flags)

    messages = [
        Message(
            role="system",
            content="You are a helpful enterprise assistant. Answer using only the provided context. Cite your sources.",
        ),
        Message(
            role="user",
            content=f"Context:\n{filtered_context}\n\nQuestion: {req.query}",
        ),
    ]

    loop = asyncio.get_event_loop()
    deltas: list[str] = await loop.run_in_executor(None, lambda: list(llm.stream(messages)))
    for delta in deltas:
        yield f"data: {json.dumps({'type': 'chunk', 'content': delta})}\n\n"

    yield f"data: {json.dumps({'type': 'done', 'reason': 'complete'})}\n\n"


async def _agentic_path(
    req: StreamRetrieveRequest,
    plan_run_id: str,
    retrieval_context: str,
):
    """
    Agentic Path (cross_system / complex_multi_step):
      Governed agent loop with HardCap(5), wrap_tool_call audit, SSE streaming.
    """
    tools = _build_tool_registry(req.tenant_id)
    executor = AgentExecutor(
        plan_run_id=plan_run_id,
        user_id=req.user_id,
        tenant_id=req.tenant_id,
        tools=tools,
    )
    async for sse_line in executor.run(req.query, retrieval_context):
        yield sse_line


# ── Helpers ──────────────────────────────────────────────────────────────────────

def _build_pipeline_context(retrieval: str, mcp: dict) -> str:
    """Combine vector retrieval results and MCP tool results into a single context string."""
    parts = [f"# Retrieved Documents\n{retrieval}"]

    if mcp.get("jira"):
        jira_lines = "\n".join(
            f"- {issue.get('key', '')}: {issue.get('summary', '')}"
            for issue in mcp["jira"]
        )
        parts.append(f"# Jira Issues\n{jira_lines}")

    if mcp.get("confluence"):
        conf_lines = "\n".join(
            f"- {page.get('title', '')}: {page.get('body', '')[:500]}"
            for page in mcp["confluence"]
        )
        parts.append(f"# Confluence Pages\n{conf_lines}")

    return "\n\n".join(parts)


def _build_tool_registry(tenant_id: str) -> list[ToolSpec]:
    """Build the list of tools available to AgentExecutor for this tenant."""
    jira = JiraMCPClient()
    conf = ConfluenceMCPClient()
    return [
        ToolSpec(
            name="jira_search",
            description="Search Jira issues by keyword. Args: query (str)",
            fn=lambda query: jira.search_issues(query, tenant_id),
        ),
        ToolSpec(
            name="confluence_search",
            description="Search Confluence pages by keyword. Args: query (str)",
            fn=lambda query: conf.search_pages(query, tenant_id),
        ),
    ]


# ── Health ───────────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok", "reranker": _retriever._reranker is not None if _retriever else False}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")
