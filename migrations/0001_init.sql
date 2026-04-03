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
