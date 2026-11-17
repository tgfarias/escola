CREATE TABLE outbox_events (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  type text NOT NULL,
  data jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  UNIQUE (school_id, id)
);

CREATE INDEX outbox_events_pending ON outbox_events (next_attempt_at) WHERE delivered_at IS NULL;

ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON outbox_events USING (school_id = app_school_id());
GRANT SELECT, INSERT, UPDATE ON outbox_events TO app_user;
