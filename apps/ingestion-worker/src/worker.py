"""
Ingestion worker — main entry point.

Loop: BLPOP erp:ingest:jobs → extract → chunk → embed → upsert Milvus → update BM25 → persist Postgres.

Expected job payload (JSON):
{
  "jobId": "<uuid>",
  "documentId": "<uuid>",
  "tenantId": "<uuid>",
  "storageKey": "<minio-object-key>",
  "filename": "report.pdf",
  "mimeType": "application/pdf",
  "sizeBytes": 123456,
  "sourceUrl": "https://..."   // optional
}
"""

import json
import logging
import uuid

import redis
from pymilvus import MilvusClient

from bm25_index import update_bm25_index
from chunker import ChunkStrategy, chunk_text
from config import config
from db import get_conn, insert_document, save_chunks, update_document_status
from embedder import embed_texts
from extractors import get_extractor
from milvus_schema import COLLECTION, ensure_collection
from sparse import sparse_vector
from storage import download_document, ensure_bucket

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("worker")

QUEUE_KEY = "erp:ingest:jobs"


def _process(job: dict, milvus: MilvusClient) -> None:
    doc_id = job.get("documentId") or str(uuid.uuid4())
    tenant_id = job["tenantId"]
    storage_key = job["storageKey"]
    filename = job["filename"]
    mime_type = job["mimeType"]
    size_bytes = job.get("sizeBytes", 0)
    source_url = job.get("sourceUrl", "")

    conn = get_conn()
    try:
        # Persist document record so FK constraints on chunks hold
        insert_document(conn, doc_id, tenant_id, filename, mime_type, storage_key, size_bytes)

        # 1. Download from MinIO / R2
        raw = download_document(storage_key)
        logger.info("Downloaded %d bytes — doc_id=%s", len(raw), doc_id)

        # 2. Extract text
        extractor = get_extractor(mime_type, filename)
        doc = extractor.extract(raw, filename)
        logger.info("Extracted %d chars from %s", len(doc.text), filename)

        if not doc.text.strip():
            logger.warning("Empty extraction for doc_id=%s — marking skipped", doc_id)
            update_document_status(conn, doc_id, "skipped")
            return

        # 3. Chunk
        strategy = ChunkStrategy(config.chunk_strategy)
        raw_chunks = chunk_text(
            doc.text,
            strategy=strategy,
            chunk_size=config.chunk_size,
            overlap_pct=config.chunk_overlap_pct,
        )
        logger.info("Produced %d chunks (strategy=%s)", len(raw_chunks), strategy.value)

        texts = [c.text for c in raw_chunks]

        # 4. Embed in batches
        dense_vecs: list[list[float]] = []
        bs = config.embed_batch_size
        for i in range(0, len(texts), bs):
            dense_vecs.extend(embed_texts(texts[i : i + bs]))
        logger.info("Embedded %d chunks with %s", len(dense_vecs), config.embedding_model)

        # 5. Build chunk records
        chunk_records = [
            {
                "chunk_id": str(uuid.uuid4()),
                "index": chunk.index,
                "text": chunk.text,
                "model": config.embedding_model,
                "dense": vec,
                "sparse": sparse_vector(chunk.text),
            }
            for chunk, vec in zip(raw_chunks, dense_vecs)
        ]

        # 6. Upsert to Milvus
        milvus.insert(
            collection_name=COLLECTION,
            data=[
                {
                    "chunk_id": r["chunk_id"],
                    "tenant_id": tenant_id,
                    "doc_id": doc_id,
                    "source_url": source_url,
                    "dense": r["dense"],
                    "sparse": r["sparse"],
                }
                for r in chunk_records
            ],
        )

        # 7. Update BM25 corpus + rebuild index
        update_bm25_index(texts)

        # 8. Persist chunk metadata to Postgres
        save_chunks(conn, doc_id, tenant_id, chunk_records)

        update_document_status(conn, doc_id, "complete")
        logger.info("Completed doc_id=%s chunks=%d", doc_id, len(chunk_records))

    except Exception:
        logger.exception("Failed processing doc_id=%s", doc_id)
        try:
            update_document_status(conn, doc_id, "error")
        except Exception:
            pass
    finally:
        conn.close()


def main() -> None:
    ensure_bucket()

    milvus = MilvusClient(uri=config.milvus_uri)
    ensure_collection(milvus)

    r = redis.from_url(config.redis_url, decode_responses=True)
    logger.info("ingestion-worker ready — polling %s", QUEUE_KEY)

    while True:
        result = r.blpop(QUEUE_KEY, timeout=5)
        if result is None:
            continue
        _, raw = result
        try:
            job = json.loads(raw)
        except json.JSONDecodeError:
            logger.error("Invalid job payload (not JSON): %s", raw[:200])
            continue
        logger.info("Job received: jobId=%s docId=%s", job.get("jobId"), job.get("documentId"))
        _process(job, milvus)


if __name__ == "__main__":
    main()
