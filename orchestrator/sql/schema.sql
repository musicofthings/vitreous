CREATE TABLE IF NOT EXISTS agents (
  agent_id UUID PRIMARY KEY,
  goal TEXT NOT NULL,
  status TEXT NOT NULL,
  tools JSONB NOT NULL,
  max_steps INT NOT NULL,
  parallelism INT NOT NULL,
  schedule TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS steps (
  step_id UUID PRIMARY KEY,
  agent_id UUID NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  step_order INT NOT NULL,
  tool TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL,
  attempt INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  last_error TEXT,
  output JSONB,
  next_run_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  UNIQUE(agent_id, step_order)
);

CREATE TABLE IF NOT EXISTS node_registrations (
  node_id TEXT PRIMARY KEY,
  callback_url TEXT NOT NULL,
  capabilities JSONB NOT NULL,
  last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS execution_events (
  id BIGSERIAL PRIMARY KEY,
  agent_id UUID NOT NULL,
  step_id UUID,
  level TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
