"""
BGE Reranker v2 — cross-encoder rescoring.

Memory budget
─────────────
Model weights (BAAI/bge-reranker-v2-m3):  ~300 MB
PyTorch + runtime overhead:               ~200 MB
Total estimated RSS:                       ~500 MB

Railway container sizing:
  Starter plan (512 MB) — will OOM if reranker + rest of deps loaded together.
  Pro plan    (8 GB)    — comfortable.
  Recommendation: run query-service on a ≥1 GB container.
  Fallback: set RERANKER_ENABLED=false to skip rescoring (returns RRF-ranked order).

Alternative models (smaller footprint):
  BAAI/bge-reranker-base         ~200 MB  English only
  cross-encoder/ms-marco-MiniLM  ~70 MB   lower quality, good for rate-limited envs

RFC forward
───────────
  - Quantise to int8 when traffic justifies it (halves model RAM, ~5% quality drop).
  - Consider serving the reranker as a dedicated sidecar to avoid OOM in the
    worker process when ingestion and query share a container.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass
class ScoredChunk:
    """Returned by BGEReranker.rerank() — adds rerank_score to any chunk-like object."""
    chunk_id: str
    doc_id: str
    source_url: str
    content: str
    rrf_score: float
    rerank_score: float | None = None


class BGEReranker:
    def __init__(self, model_name: str = "BAAI/bge-reranker-v2-m3") -> None:
        # Lazy import — keeps startup fast when RERANKER_ENABLED=false
        from sentence_transformers import CrossEncoder  # type: ignore[import]
        logger.info("Loading reranker model: %s (this may take ~30s on first run)", model_name)
        self._model = CrossEncoder(model_name, max_length=512)
        logger.info("Reranker ready: %s", model_name)

    def rerank(self, query: str, chunks: list) -> list:
        """
        Score each (query, chunk.content) pair and re-sort descending.
        Returns the same list objects, with rerank_score populated.
        """
        if not chunks:
            return []
        pairs = [[query, c.content] for c in chunks]
        scores = self._model.predict(pairs, show_progress_bar=False)
        for chunk, score in zip(chunks, scores):
            chunk.rerank_score = float(score)
        return sorted(chunks, key=lambda c: c.rerank_score or 0.0, reverse=True)
