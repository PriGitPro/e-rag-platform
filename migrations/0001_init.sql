CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS governance_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type TEXT NOT NULL,
    intercept_point TEXT NOT NULL,
    user_id UUID NOT NULL,
    tenant_id UUID NOT NULL,
    plan_run_id UUID NOT NULL,
    agent_iteration INTEGER,
    step_index INTEGER,
    tool_name TEXT,
    detected JSONB,
    action_taken TEXT NOT NULL,
    pii_redacted BOOLEAN NOT NULL DEFAULT FALSE,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION prevent_governance_events_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'governance_events is append-only; % operations are not allowed', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS trg_governance_events_no_update_delete ON governance_events;
CREATE TRIGGER trg_governance_events_no_update_delete
BEFORE UPDATE OR DELETE ON governance_events
FOR EACH ROW
EXECUTE FUNCTION prevent_governance_events_mutation();

DROP TRIGGER IF EXISTS trg_governance_events_no_truncate ON governance_events;
CREATE TRIGGER trg_governance_events_no_truncate
BEFORE TRUNCATE ON governance_events
FOR EACH STATEMENT
EXECUTE FUNCTION prevent_governance_events_mutation();

CREATE INDEX IF NOT EXISTS idx_governance_events_tenant_timestamp
  ON governance_events (tenant_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_governance_events_user_timestamp
  ON governance_events (user_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_governance_events_plan_run
  ON governance_events (plan_run_id);

-- Tenants

CREATE TABLE IF NOT EXISTS tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed a hardcoded test tenant (Week 1 — no sign-up flow)
INSERT INTO tenants (id, name)
VALUES ('00000000-0000-0000-0000-000000000001', 'test-tenant')
ON CONFLICT (id) DO NOTHING;

-- Documents

CREATE TABLE IF NOT EXISTS documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    storage_key TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_documents_tenant
  ON documents (tenant_id, created_at DESC);

-- Chunks

CREATE TABLE IF NOT EXISTS chunks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES documents(id),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    token_count INTEGER NOT NULL,
    embedding_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chunks_document
  ON chunks (document_id, chunk_index);

CREATE INDEX IF NOT EXISTS idx_chunks_tenant
  ON chunks (tenant_id);
