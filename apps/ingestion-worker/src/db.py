import psycopg2
import psycopg2.extras

from config import config


def get_conn():
    return psycopg2.connect(config.database_url)


def insert_document(conn, doc_id: str, tenant_id: str, filename: str, mime_type: str, storage_key: str, byte_size: int) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO documents (id, tenant_id, filename, mime_type, storage_key, byte_size, status)
            VALUES (%s, %s, %s, %s, %s, %s, 'processing')
            ON CONFLICT (id) DO UPDATE SET status = 'processing', updated_at = NOW()
            """,
            (doc_id, tenant_id, filename, mime_type, storage_key, byte_size),
        )
    conn.commit()


def update_document_status(conn, doc_id: str, status: str) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE documents SET status = %s, updated_at = NOW() WHERE id = %s",
            (status, doc_id),
        )
    conn.commit()


def save_chunks(conn, document_id: str, tenant_id: str, chunks: list[dict]) -> None:
    """Upsert chunk rows. Each dict must have: index, text, chunk_id, model."""
    with conn.cursor() as cur:
        psycopg2.extras.execute_values(
            cur,
            """
            INSERT INTO chunks
              (id, document_id, tenant_id, chunk_index, content, token_count, embedding_id, embedding_model)
            VALUES %s
            ON CONFLICT (id) DO NOTHING
            """,
            [
                (
                    c["chunk_id"],
                    document_id,
                    tenant_id,
                    c["index"],
                    c["text"],
                    len(c["text"].split()),   # rough word-count token estimate
                    c["chunk_id"],            # embedding_id = chunk_id for now
                    c["model"],
                )
                for c in chunks
            ],
        )
    conn.commit()
