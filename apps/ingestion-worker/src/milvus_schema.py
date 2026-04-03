"""
Milvus collection schema for hybrid dense+sparse retrieval.

Collection: erp_chunks
Partition key: tenant_id  (Milvus routes each tenant's data to its own partition)

Fields:
  chunk_id    VARCHAR(64)             primary key
  tenant_id   VARCHAR(64)             partition key
  doc_id      VARCHAR(64)             FK to Postgres documents.id
  source_url  VARCHAR(1024)           original source for citation

  dense       FLOAT_VECTOR(1536)      text-embedding-3-large; HNSW index
              HNSW params: M=16, efConstruction=200
              Retrieval uses COSINE similarity.

  sparse      SPARSE_FLOAT_VECTOR     BM25 TF weights (corpus-wide IDF in Week 3)
              SPARSE_INVERTED_INDEX; retrieval uses inner product (IP).

Hybrid retrieval (Week 3): RRF fusion of dense ANN + sparse BM25 results.
"""

import logging

from pymilvus import DataType, MilvusClient

logger = logging.getLogger(__name__)

COLLECTION = "erp_chunks"
DENSE_DIM = 1536
# Enough partitions for multi-tenancy without manual partition management.
# Milvus hashes tenant_id into num_partitions slots automatically.
_NUM_PARTITIONS = 64


def ensure_collection(client: MilvusClient) -> None:
    """Idempotently create the erp_chunks collection."""
    if client.has_collection(COLLECTION):
        logger.info("Collection '%s' already exists — skipping creation", COLLECTION)
        return

    schema = client.create_schema(
        auto_id=False,
        enable_dynamic_field=False,
        description="RAG chunk store — dense + sparse hybrid search",
    )
    schema.add_field("chunk_id", DataType.VARCHAR, max_length=64, is_primary=True)
    schema.add_field("tenant_id", DataType.VARCHAR, max_length=64, is_partition_key=True)
    schema.add_field("doc_id", DataType.VARCHAR, max_length=64)
    schema.add_field("source_url", DataType.VARCHAR, max_length=1024)
    schema.add_field("dense", DataType.FLOAT_VECTOR, dim=DENSE_DIM)
    schema.add_field("sparse", DataType.SPARSE_FLOAT_VECTOR)

    index_params = client.prepare_index_params()
    index_params.add_index(
        field_name="dense",
        index_type="HNSW",
        metric_type="COSINE",
        params={"M": 16, "efConstruction": 200},
    )
    index_params.add_index(
        field_name="sparse",
        index_type="SPARSE_INVERTED_INDEX",
        metric_type="IP",
    )

    client.create_collection(
        collection_name=COLLECTION,
        schema=schema,
        index_params=index_params,
        num_partitions=_NUM_PARTITIONS,
    )
    logger.info("Created Milvus collection '%s'", COLLECTION)
