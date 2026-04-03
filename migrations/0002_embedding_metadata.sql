-- Add embedding model tracking to chunks so re-embedding is possible
-- without re-ingesting documents (just re-run embedder with new model).

ALTER TABLE chunks ADD COLUMN IF NOT EXISTS embedding_model TEXT;

-- Backfill existing rows (none expected in proto01, but safe to have)
UPDATE chunks SET embedding_model = 'text-embedding-3-large' WHERE embedding_model IS NULL;
