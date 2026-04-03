"""
BM25S in-process index.

Built over the full ingested corpus at ingestion time and serialised to
MinIO (dev) / R2 (prod). On each ingestion run the corpus is extended,
the index rebuilt from scratch, and both artefacts re-uploaded.

Storage layout in the bucket:
  bm25/corpus.json   — newline-joined corpus texts as a JSON array
  bm25/index.pkl     — pickled bm25s.BM25 retriever

Limitations (acceptable for proto01):
  - Rebuild cost is O(N) over full corpus — switch to incremental index
    (e.g. Elasticsearch or a streaming BM25 impl) once corpus > 100k chunks.
  - Single global index; multi-tenant isolation handled at query time by
    filtering results to the requesting tenant's chunk IDs.
"""

import io
import json
import logging
import pickle
from typing import TYPE_CHECKING

import bm25s
import boto3
from botocore.exceptions import ClientError

from config import config

if TYPE_CHECKING:
    from mypy_boto3_s3 import S3Client

logger = logging.getLogger(__name__)

_CORPUS_KEY = "bm25/corpus.json"
_INDEX_KEY = "bm25/index.pkl"


def _s3() -> "S3Client":
    return boto3.client(  # type: ignore[return-value]
        "s3",
        endpoint_url=config.s3_endpoint,
        aws_access_key_id=config.s3_access_key,
        aws_secret_access_key=config.s3_secret_key,
    )


def _load_corpus(s3: "S3Client") -> list[str]:
    try:
        obj = s3.get_object(Bucket=config.s3_bucket, Key=_CORPUS_KEY)
        return json.loads(obj["Body"].read())
    except ClientError as e:
        if e.response["Error"]["Code"] in ("NoSuchKey", "404"):
            return []
        logger.warning("Could not load BM25 corpus; starting fresh: %s", e)
        return []


def _save_corpus(s3: "S3Client", corpus: list[str]) -> None:
    s3.put_object(
        Bucket=config.s3_bucket,
        Key=_CORPUS_KEY,
        Body=json.dumps(corpus).encode(),
        ContentType="application/json",
    )


def _save_index(s3: "S3Client", retriever: bm25s.BM25) -> None:
    buf = io.BytesIO()
    pickle.dump(retriever, buf)
    buf.seek(0)
    s3.put_object(
        Bucket=config.s3_bucket,
        Key=_INDEX_KEY,
        Body=buf.read(),
        ContentType="application/octet-stream",
    )


def update_bm25_index(new_texts: list[str]) -> None:
    """Extend corpus with new_texts, rebuild BM25S index, persist to MinIO."""
    s3 = _s3()
    corpus = _load_corpus(s3)
    corpus.extend(new_texts)

    corpus_tokens = bm25s.tokenize(corpus, stopwords="en")
    retriever = bm25s.BM25()
    retriever.index(corpus_tokens)

    _save_corpus(s3, corpus)
    _save_index(s3, retriever)
    logger.info("BM25 index updated — corpus size: %d documents", len(corpus))
