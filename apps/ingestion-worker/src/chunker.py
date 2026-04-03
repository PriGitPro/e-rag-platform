"""
Chunking strategies for RAG ingestion.

Currently implemented: fixed-size with configurable overlap (default 20%).

Three additional strategies are documented below and gated behind the
CHUNK_STRATEGY env flag. Implement them only if RAGAS evaluation shows
they improve retrieval recall — don't build what you haven't measured.

  semantic      — split where embedding cosine similarity drops below a
                  threshold between consecutive sentences. Requires a
                  sentence-level embedding pass; adds ~2× latency.

  sentence      — split on sentence boundaries (spacy or nltk punkt).
                  Preserves grammatical coherence; useful for QA tasks.

  hierarchical  — produce both parent (large) and child (small) chunks.
                  Store child embeddings; retrieve parent for context.
                  Useful when answers are short but context must be wide.
"""

from dataclasses import dataclass
from enum import Enum


class ChunkStrategy(str, Enum):
    FIXED = "fixed"
    SEMANTIC = "semantic"
    SENTENCE = "sentence"
    HIERARCHICAL = "hierarchical"


@dataclass
class Chunk:
    index: int
    text: str
    start_char: int
    end_char: int


def _fixed(text: str, chunk_size: int, overlap_pct: float) -> list[Chunk]:
    overlap = int(chunk_size * overlap_pct)
    step = max(1, chunk_size - overlap)
    chunks: list[Chunk] = []
    i = 0
    idx = 0
    while i < len(text):
        end = min(i + chunk_size, len(text))
        chunk_text = text[i:end].strip()
        if chunk_text:
            chunks.append(Chunk(index=idx, text=chunk_text, start_char=i, end_char=end))
            idx += 1
        if end == len(text):
            break
        i += step
    return chunks


def chunk_text(
    text: str,
    strategy: ChunkStrategy = ChunkStrategy.FIXED,
    chunk_size: int = 512,
    overlap_pct: float = 0.2,
) -> list[Chunk]:
    if not text.strip():
        return []
    if strategy == ChunkStrategy.FIXED:
        return _fixed(text, chunk_size, overlap_pct)
    raise NotImplementedError(
        f"Strategy '{strategy}' is not implemented yet. "
        "Run RAGAS evals with 'fixed' first to establish a baseline."
    )
