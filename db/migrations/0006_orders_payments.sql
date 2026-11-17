-- F2: cardápio, dias de serviço, checkout, pagamento, carteira e romaneio (spec 5 e 9).

CREATE TABLE menu_items (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  price_cents bigint NOT NULL CHECK (price_cents > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, name)
);

CREATE TABLE service_days (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  service_date date NOT NULL,
  cutoff_at timestamptz NOT NULL,
  freeze_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, service_date),
  CHECK (freeze_at > cutoff_at),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);

CREATE TABLE service_day_items (
  school_id uuid NOT NULL REFERENCES schools (id),
  service_day_id uuid NOT NULL,
  menu_item_id uuid NOT NULL,
  price_cents bigint NOT NULL CHECK (price_cents > 0),
  PRIMARY KEY (school_id, service_day_id, menu_item_id),
  FOREIGN KEY (school_id, service_day_id) REFERENCES service_days (school_id, id),
  FOREIGN KEY (school_id, menu_item_id) REFERENCES menu_items (school_id, id)
);

CREATE TABLE wallets (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  guardian_id uuid NOT NULL,
  balance_cents bigint NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, guardian_id),
  FOREIGN KEY (school_id, guardian_id) REFERENCES guardians (school_id, id)
);

-- Append-only: o papel da aplicação só tem SELECT e INSERT.
CREATE TABLE wallet_entries (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  wallet_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('checkout_hold', 'hold_release', 'late_payment_credit', 'cancel_credit', 'refund', 'manual_adjustment')),
  amount_cents bigint NOT NULL CHECK (amount_cents <> 0),
  source_type text NOT NULL CHECK (source_type IN ('checkout', 'payment', 'adjustment')),
  source_id uuid NOT NULL,
  note text CHECK (note IS NULL OR length(note) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, source_type, source_id, kind),
  FOREIGN KEY (school_id, wallet_id) REFERENCES wallets (school_id, id),
  CHECK (
    (kind IN ('checkout_hold', 'refund') AND amount_cents < 0)
    OR (kind IN ('hold_release', 'late_payment_credit', 'cancel_credit') AND amount_cents > 0)
    OR kind = 'manual_adjustment'
  )
);
CREATE INDEX wallet_entries_wallet ON wallet_entries (school_id, wallet_id, created_at);

CREATE TABLE checkouts (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  guardian_id uuid NOT NULL,
  service_day_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending_payment'
    CHECK (status IN ('pending_payment', 'paid', 'expired', 'late_credited', 'cancelled')),
  total_cents bigint NOT NULL CHECK (total_cents > 0),
  wallet_applied_cents bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  FOREIGN KEY (school_id, guardian_id) REFERENCES guardians (school_id, id),
  FOREIGN KEY (school_id, service_day_id) REFERENCES service_days (school_id, id),
  CHECK (wallet_applied_cents >= 0 AND wallet_applied_cents <= total_cents)
);
CREATE INDEX checkouts_day_status ON checkouts (school_id, service_day_id, status);
CREATE INDEX checkouts_guardian ON checkouts (school_id, guardian_id, service_day_id);

CREATE TABLE orders (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  checkout_id uuid NOT NULL,
  student_id uuid NOT NULL,
  service_date date NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'delivered', 'expired', 'expired_late', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  FOREIGN KEY (school_id, checkout_id) REFERENCES checkouts (school_id, id),
  FOREIGN KEY (school_id, student_id) REFERENCES students (school_id, id)
);
CREATE INDEX orders_checkout ON orders (school_id, checkout_id);
-- Toque duplo e dois responsáveis pedindo para o mesmo aluno (spec 5.4).
CREATE UNIQUE INDEX orders_one_active_per_student
  ON orders (school_id, student_id, service_date) WHERE status IN ('pending', 'confirmed', 'delivered');

CREATE TABLE order_items (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  order_id uuid NOT NULL,
  menu_item_id uuid NOT NULL,
  qty integer NOT NULL CHECK (qty BETWEEN 1 AND 10),
  unit_price_cents bigint NOT NULL CHECK (unit_price_cents > 0),
  UNIQUE (school_id, id),
  UNIQUE (school_id, order_id, menu_item_id),
  FOREIGN KEY (school_id, order_id) REFERENCES orders (school_id, id),
  FOREIGN KEY (school_id, menu_item_id) REFERENCES menu_items (school_id, id)
);

CREATE TABLE payments (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  checkout_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{1,30}$'),
  provider_charge_id text,
  method text NOT NULL CHECK (method IN ('pix', 'card_link')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'expired', 'refunded')),
  paid_at timestamptz,
  expires_at timestamptz NOT NULL,
  pix_copy_paste text,
  pix_qr_png_base64 text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (provider, provider_charge_id),
  FOREIGN KEY (school_id, checkout_id) REFERENCES checkouts (school_id, id),
  CHECK ((status IN ('paid', 'refunded')) = (paid_at IS NOT NULL))
);
CREATE UNIQUE INDEX payments_one_per_checkout ON payments (school_id, checkout_id);
CREATE INDEX payments_pending ON payments (school_id, status) WHERE status = 'pending';

-- Evento bruto do gateway; a unicidade global deduplica reenvios (spec 5.4).
CREATE TABLE payment_events (
  id uuid PRIMARY KEY,
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  school_id uuid NOT NULL REFERENCES schools (id),
  payment_id uuid,
  raw jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (provider, provider_event_id),
  FOREIGN KEY (school_id, payment_id) REFERENCES payments (school_id, id)
);

-- Imutável depois de gravado (CLAUDE.md regra 18).
CREATE TABLE manifests (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  service_day_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  content jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, service_day_id, version),
  FOREIGN KEY (school_id, service_day_id) REFERENCES service_days (school_id, id)
);

CREATE TABLE idempotency_keys (
  school_id uuid NOT NULL REFERENCES schools (id),
  key text NOT NULL CHECK (length(key) BETWEEN 8 AND 200),
  request_hash text NOT NULL,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (school_id, key)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['menu_items', 'service_days', 'service_day_items', 'wallets', 'wallet_entries',
    'checkouts', 'orders', 'order_items', 'payments', 'payment_events', 'manifests', 'idempotency_keys']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (school_id = app_school_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON menu_items, service_days, wallets, checkouts, orders, payments TO app_user;
GRANT SELECT, INSERT, DELETE ON service_day_items TO app_user;
GRANT SELECT, INSERT ON order_items, wallet_entries, payment_events, manifests TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON idempotency_keys TO app_user;
