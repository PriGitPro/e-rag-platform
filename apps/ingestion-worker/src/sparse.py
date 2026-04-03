"""
Proto01 sparse vector encoding.

Computes a simple TF-based sparse vector per chunk using stable token hashes
as dimension indices. This is sufficient to populate the Milvus SPARSE_FLOAT_VECTOR
field and exercise the hybrid search plumbing.

Week 3 TODO: replace with pymilvus.model.sparse.BM25EmbeddingFunction fitted on
the full corpus so IDF is computed globally rather than per-chunk. That will
require loading the BM25 corpus from MinIO before each embedding pass and
re-encoding on model updates.
"""

import re
from collections import Counter
from math import log


def _tokenize(text: str) -> list[str]:
    return re.findall(r"\b[a-z]+\b", text.lower())


def sparse_vector(text: str) -> dict[int, float]:
    """
    Returns {dimension: weight} where dimension = abs(hash(token)) % 2^20
    and weight = log(1 + tf) normalised by document length.

    Milvus SPARSE_FLOAT_VECTOR requires at least one entry and non-negative values.
    """
    tokens = _tokenize(text)
    if not tokens:
        return {0: 1e-6}  # sentinel — empty doc

    tf = Counter(tokens)
    n = len(tokens)
    return {
        abs(hash(tok)) % (1 << 20): log(1.0 + count / n)
        for tok, count in tf.items()
    }
