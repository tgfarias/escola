-- F4: KDS offline — eventos de entrega e pareamento de tablet (spec 4.4, 7, 9).

-- Pendência da spec 14: código de pareamento com índice único próprio.
CREATE UNIQUE INDEX devices_pairing_code ON devices (pairing_code_hash) WHERE pairing_code_hash IS NOT NULL;

CREATE TABLE delivery_events (
  event_id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  order_id uuid NOT NULL,
  device_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('delivered', 'undelivered')),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, event_id),
  FOREIGN KEY (school_id, order_id) REFERENCES orders (school_id, id),
  FOREIGN KEY (school_id, device_id) REFERENCES devices (school_id, id)
);

CREATE INDEX delivery_events_order ON delivery_events (school_id, order_id, occurred_at DESC, event_id DESC);
CREATE INDEX delivery_events_received ON delivery_events (school_id, received_at);

ALTER TABLE delivery_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON delivery_events USING (school_id = app_school_id());
-- Append-only: o estado vem do evento mais recente; nada é corrigido no lugar.
GRANT SELECT, INSERT ON delivery_events TO app_user;

-- Consulta sem tenant prevista na spec 4.4: só códigos ainda válidos.
CREATE FUNCTION resolve_pairing_code(p_code_hash text)
RETURNS TABLE (school_id uuid, device_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT d.school_id, d.id FROM devices d
  WHERE d.pairing_code_hash = p_code_hash AND d.kind = 'kitchen' AND d.pairing_expires_at > now() AND d.revoked_at IS NULL
$$;

REVOKE ALL ON FUNCTION resolve_pairing_code(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_pairing_code(text) TO app_user;
