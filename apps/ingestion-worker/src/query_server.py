"""
Query HTTP service — FastAPI app served by uvicorn.

This process is separate from the BLPOP ingestion worker.
Both share the same Docker image; the entrypoint differs:
  worker.py       → ingestion loop
  query_server.py → HTTP query service

Endpoints
─────────
  POST /retrieve   — hybrid search + rerank
  GET  /health     — liveness probe
"""

from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager
from dataclasses import asdict

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

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
    _retriever = Retriever()
    logger.info("Query server ready")
    yield
    logger.info("Query server shutting down")


app = FastAPI(
    title="ERP Query Service",
    description="Hybrid retrieval + BGE reranker endpoint for the RAG pipeline",
    version="0.1.0",
    lifespan=lifespan,
)


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


@app.post("/retrieve", response_model=RetrieveResponse)
def retrieve(req: RetrieveRequest) -> RetrieveResponse:
    t0 = time.monotonic()

    plan = plan_query(req.query, req.tenant_id, req.top_k)

    if isinstance(plan, AgentPlan):
        # AgentPlan executor does not exist yet (M2).
        raise HTTPException(
            status_code=501,
            detail=(
                f"Intent '{plan.intent}' requires AgentPlan executor (MCP servers, M2). "
                "Not yet implemented. Set CHUNK_STRATEGY=fixed and retry."
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


@app.get("/health")
def health():
    return {"status": "ok", "reranker": _retriever._reranker is not None if _retriever else False}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")
