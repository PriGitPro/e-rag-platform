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

CREATE INDEX IF NOT EXISTS idx_governance_events_tenant_timestamp
  ON governance_events (tenant_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_governance_events_user_timestamp
  ON governance_events (user_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_governance_events_plan_run
  ON governance_events (plan_run_id);
