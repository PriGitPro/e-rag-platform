"""
Hybrid retrieval pipeline.

Flow
────
  1. Embed query  →  text-embedding-3-large (same model as ingestion)
  2. Sparse vec   →  TF hash encoding (same encoding as ingestion; swap to BM25
                     EmbeddingFunction with corpus IDF in Week 3)
  3. Milvus hybrid_search: HNSW dense (COSINE) + SPARSE_INVERTED_INDEX (IP),
     fused with RRFRanker(k=60)
  4. Fetch content from Postgres by chunk_id
  5. BGE reranker v2 cross-encoder rescoring (if RERANKER_ENABLED=true)
  6. Return top_k RetrievedChunk objects

RFC forward notes
─────────────────
  Step 2: replace TF sparse with BM25EmbeddingFunction fitted on full corpus once
          corpus is large enough to make IDF meaningful (Week 3).
  Step 3: HNSW ef parameter is NOT tuned here. Do not change it without a RAGAS
          baseline — Week 5 task. Current ef=max(pre_k*2, 100) is conservative.
  Step 5: add metadata filter expressions (date range, source type, doc tags) to
          AnnSearchRequest.expr when governance filtering is needed.
  Step 6: future option — add an MMR (max marginal relevance) pass after reranking
          to reduce chunk redundancy when top_k > 8.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from pymilvus import AnnSearchRequest, MilvusClient, RRFRanker

from config import config
from db import fetch_chunks_by_ids, get_conn
from embedder import embed_texts
from milvus_schema import COLLECTION
from sparse import sparse_vector

logger = logging.getLogger(__name__)


@dataclass
class RetrievedChunk:
    chunk_id: str
    doc_id: str
    source_url: str
    content: str
    rrf_score: float
    rerank_score: float | None = None


class Retriever:
    """
    Stateful retriever — holds Milvus client and optional reranker.
    Instantiate once per process; share across requests.
    """

    def __init__(self) -> None:
        self._milvus = MilvusClient(uri=config.milvus_uri)
        self._reranker = None
        if config.reranker_enabled:
            from reranker import BGEReranker
            self._reranker = BGEReranker(config.reranker_model)
        else:
            logger.info("Reranker disabled (RERANKER_ENABLED=false) — returning RRF order")

    def retrieve(self, query: str, tenant_id: str, top_k: int = 5) -> list[RetrievedChunk]:
        """
        Run hybrid search and return up to top_k ranked chunks.
        Returns [] if the collection is empty or no results match.
        """
        # 1. Query embeddings
        dense_vec = embed_texts([query])[0]
        sparse_vec = sparse_vector(query)

        # Over-fetch so the reranker has material to work with.
        pre_k = max(top_k * 4, 20)
        ef = max(pre_k * 2, 100)
        tenant_filter = f'tenant_id == "{tenant_id}"'

        # 2. Hybrid search
        try:
            results = self._milvus.hybrid_search(
                collection_name=COLLECTION,
                reqs=[
                    AnnSearchRequest(
                        data=[dense_vec],
                        anns_field="dense",
                        param={"metric_type": "COSINE", "params": {"ef": ef}},
                        limit=pre_k,
                        expr=tenant_filter,
                    ),
                    AnnSearchRequest(
                        data=[sparse_vec],
                        anns_field="sparse",
                        param={"metric_type": "IP"},
                        limit=pre_k,
                        expr=tenant_filter,
                    ),
                ],
                ranker=RRFRanker(k=60),
                limit=pre_k,
                output_fields=["chunk_id", "doc_id", "source_url"],
            )
        except Exception as exc:
            logger.warning("Milvus hybrid_search failed: %s", exc)
            return []

        if not results or not results[0]:
            return []

        # 3. Extract hit metadata
        hits = results[0]
        chunk_ids = [h["entity"]["chunk_id"] for h in hits]
        rrf_scores = {h["entity"]["chunk_id"]: float(h["distance"]) for h in hits}
        doc_ids = {h["entity"]["chunk_id"]: h["entity"].get("doc_id", "") for h in hits}
        source_urls = {h["entity"]["chunk_id"]: h["entity"].get("source_url", "") for h in hits}

        if not chunk_ids:
            return []

        # 4. Hydrate content from Postgres
        conn = get_conn()
        try:
            content_map = fetch_chunks_by_ids(conn, chunk_ids)
        finally:
            conn.close()

        chunks = [
            RetrievedChunk(
                chunk_id=cid,
                doc_id=doc_ids.get(cid, ""),
                source_url=source_urls.get(cid, ""),
                content=content_map.get(cid, ""),
                rrf_score=rrf_scores[cid],
            )
            for cid in chunk_ids
            if cid in content_map
        ]

        # 5. BGE rerank
        if self._reranker and chunks:
            chunks = self._reranker.rerank(query, chunks)

        logger.info(
            "retrieve: query=%r tenant=%s hits=%d returned=%d reranked=%s",
            query[:60], tenant_id, len(chunk_ids), len(chunks[:top_k]),
            self._reranker is not None,
        )
        return chunks[:top_k]
