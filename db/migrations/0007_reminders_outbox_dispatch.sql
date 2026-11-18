-- F3: lembretes, entregas de mensagem, abandono de evento da outbox e agenda (spec 4.4, 6.2, 6.3).

ALTER TABLE schools ADD COLUMN reminder_lead_minutes integer NOT NULL DEFAULT 720
  CHECK (reminder_lead_minutes BETWEEN 30 AND 2880);

-- Evento abandonado (mais de 24 h sem entrega, ou OTP vencido): nunca mais é enviado.
ALTER TABLE outbox_events ADD COLUMN failed_at timestamptz;
ALTER TABLE outbox_events ADD CHECK (delivered_at IS NULL OR failed_at IS NULL);
DROP INDEX outbox_events_pending;
CREATE INDEX outbox_events_pending ON outbox_events (school_id, next_attempt_at)
  WHERE delivered_at IS NULL AND failed_at IS NULL;

CREATE TABLE reminder_batches (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  service_date date NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, service_date)
);

CREATE TABLE message_deliveries (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  batch_id uuid NOT NULL,
  guardian_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared', 'sent', 'failed')),
  wa_message_id text CHECK (length(wa_message_id) BETWEEN 1 AND 200),
  error text CHECK (error ~ '^[a-z0-9_]{1,64}$'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, batch_id, guardian_id),
  FOREIGN KEY (school_id, batch_id) REFERENCES reminder_batches (school_id, id),
  FOREIGN KEY (school_id, guardian_id) REFERENCES guardians (school_id, id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['reminder_batches', 'message_deliveries']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (school_id = app_school_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO app_user', t);
  END LOOP;
END $$;

-- Agenda do n8n e do fechamento de segurança (spec 4.4). Usa o relógio do banco.
CREATE FUNCTION list_due_actions()
RETURNS TABLE (action text, school_id uuid, service_date date, overdue boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT 'send_reminders'::text, d.school_id, d.service_date, false
  FROM service_days d JOIN schools s ON s.id = d.school_id
  WHERE d.status = 'open'
    AND now() >= d.cutoff_at - make_interval(mins => s.reminder_lead_minutes)
    AND now() < d.cutoff_at
    AND NOT EXISTS (
      SELECT 1 FROM reminder_batches b
      WHERE b.school_id = d.school_id AND b.service_date = d.service_date AND b.completed_at IS NOT NULL)
  UNION ALL
  SELECT 'close_service_day'::text, d.school_id, d.service_date, now() >= d.cutoff_at + interval '10 minutes'
  FROM service_days d
  WHERE d.status = 'open' AND now() >= d.freeze_at
  ORDER BY 3, 2, 1
$$;

-- Quinta consulta sem tenant (spec 6.3): o dispatcher não enxerga a outbox sob RLS sem saber a escola.
CREATE FUNCTION list_schools_with_pending_events()
RETURNS TABLE (school_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT DISTINCT o.school_id FROM outbox_events o
  WHERE o.delivered_at IS NULL AND o.failed_at IS NULL AND o.next_attempt_at <= now()
$$;

REVOKE ALL ON FUNCTION list_due_actions() FROM PUBLIC;
REVOKE ALL ON FUNCTION list_schools_with_pending_events() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_due_actions() TO app_user;
GRANT EXECUTE ON FUNCTION list_schools_with_pending_events() TO app_user;
