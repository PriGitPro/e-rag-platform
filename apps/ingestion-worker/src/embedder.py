"""
Embedding via OpenAI text-embedding-3-large (1536 dims).

The model name is intentionally stored alongside every chunk in Postgres
so that re-embedding a corpus after a model upgrade is a simple
SELECT WHERE embedding_model != 'new-model' loop — no re-ingestion needed.
"""

from openai import OpenAI

from config import config

_client: OpenAI | None = None


def _get_client() -> OpenAI:
    global _client
    if _client is None:
        _client = OpenAI(api_key=config.openai_api_key)
    return _client


def embed_texts(texts: list[str]) -> list[list[float]]:
    """Embed a batch of texts. Returns one 1536-dim vector per text, in order."""
    if not texts:
        return []
    response = _get_client().embeddings.create(
        model=config.embedding_model,
        input=texts,
        dimensions=config.embedding_dims,
    )
    return [item.embedding for item in sorted(response.data, key=lambda x: x.index)]
