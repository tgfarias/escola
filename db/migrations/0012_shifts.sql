-- F5C Parte B: turnos (matutino/vespertino), corte, fechamento e romaneio por turno, "Finalizar turno" e
-- pedidos não retirados (spec 2026-11-20-admin-turnos-avisos-design.md, B.1).

-- Turno da turma. Escola de um turno só fica toda no matutino.
ALTER TABLE classes ADD COLUMN shift text NOT NULL DEFAULT 'matutino' CHECK (shift IN ('matutino', 'vespertino'));

-- Corte padrão por turno. O antigo default_cutoff_time vira o do matutino; o vespertino começa às 13:00.
ALTER TABLE schools ADD COLUMN cutoff_time_matutino time NOT NULL DEFAULT '07:30';
ALTER TABLE schools ADD COLUMN cutoff_time_vespertino time NOT NULL DEFAULT '13:00';
UPDATE schools SET cutoff_time_matutino = default_cutoff_time;
ALTER TABLE schools DROP COLUMN default_cutoff_time;

-- Um turno ativo por dia. service_days.cutoff_at/freeze_at espelham o turno mais tarde (compatibilidade).
CREATE TABLE service_day_shifts (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  service_day_id uuid NOT NULL,
  shift text NOT NULL CHECK (shift IN ('matutino', 'vespertino')),
  cutoff_at timestamptz NOT NULL,
  freeze_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'finished')),
  closed_at timestamptz,
  finished_at timestamptz,
  finished_by_device_id uuid,
  finished_by_staff_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, service_day_id, shift),
  FOREIGN KEY (school_id, service_day_id) REFERENCES service_days (school_id, id),
  FOREIGN KEY (school_id, finished_by_device_id) REFERENCES devices (school_id, id),
  FOREIGN KEY (school_id, finished_by_staff_id) REFERENCES staff_users (school_id, id),
  CHECK (freeze_at > cutoff_at),
  CHECK ((status = 'open') = (closed_at IS NULL)),
  CHECK ((status = 'finished') = (finished_at IS NOT NULL)),
  CHECK (finished_by_device_id IS NULL OR finished_by_staff_id IS NULL),
  CHECK (status = 'finished' OR (finished_by_device_id IS NULL AND finished_by_staff_id IS NULL))
);
CREATE INDEX service_day_shifts_closed ON service_day_shifts (school_id, service_day_id) WHERE status = 'closed';

-- Dados existentes: um turno matutino por dia, com os horários e o estado do dia. Dia fechado de data passada já foi
-- servido: entra como finalizado sem mexer nos pedidos (não gera "não retirados" retroativos).
INSERT INTO service_day_shifts (id, school_id, service_day_id, shift, cutoff_at, freeze_at, status, closed_at, finished_at)
SELECT gen_random_uuid(), d.school_id, d.id, 'matutino', d.cutoff_at, d.freeze_at,
       CASE WHEN d.status = 'open' THEN 'open'
            WHEN d.service_date < (now() AT TIME ZONE s.timezone)::date THEN 'finished'
            ELSE 'closed' END,
       d.closed_at,
       CASE WHEN d.status = 'closed' AND d.service_date < (now() AT TIME ZONE s.timezone)::date THEN d.closed_at END
FROM service_days d JOIN schools s ON s.id = d.school_id;

-- O checkout é a unidade de pagamento de um turno.
ALTER TABLE checkouts ADD COLUMN shift text NOT NULL DEFAULT 'matutino' CHECK (shift IN ('matutino', 'vespertino'));
ALTER TABLE checkouts ALTER COLUMN shift DROP DEFAULT;
ALTER TABLE checkouts ADD CONSTRAINT checkouts_shift_fk
  FOREIGN KEY (school_id, service_day_id, shift) REFERENCES service_day_shifts (school_id, service_day_id, shift);
DROP INDEX checkouts_day_status;
CREATE INDEX checkouts_day_status ON checkouts (school_id, service_day_id, shift, status);

-- Romaneio por turno, imutável depois de gravado (regra 18). A coluna nova não altera o conteúdo gravado.
ALTER TABLE manifests ADD COLUMN shift text NOT NULL DEFAULT 'matutino' CHECK (shift IN ('matutino', 'vespertino'));
ALTER TABLE manifests ALTER COLUMN shift DROP DEFAULT;
ALTER TABLE manifests DROP CONSTRAINT manifests_school_id_service_day_id_version_key;
ALTER TABLE manifests ADD CONSTRAINT manifests_shift_version_key UNIQUE (school_id, service_day_id, shift, version);
ALTER TABLE manifests ADD CONSTRAINT manifests_shift_fk
  FOREIGN KEY (school_id, service_day_id, shift) REFERENCES service_day_shifts (school_id, service_day_id, shift);

-- Pedido pago e não retirado. Continua ativo: não deixa nascer outro pedido do aluno na mesma data.
ALTER TABLE orders DROP CONSTRAINT orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (status IN (
  'pending', 'confirmed', 'delivered', 'expired', 'expired_late', 'cancelled', 'not_collected'));
DROP INDEX orders_one_active_per_student;
CREATE UNIQUE INDEX orders_one_active_per_student
  ON orders (school_id, student_id, service_date) WHERE status IN ('pending', 'confirmed', 'delivered', 'not_collected');
CREATE INDEX orders_not_collected ON orders (school_id, service_date) WHERE status = 'not_collected';

-- Devolução de não retirado: crédito positivo, origem no pedido, uma vez por pedido.
ALTER TABLE wallet_entries DROP CONSTRAINT wallet_entries_kind_check;
ALTER TABLE wallet_entries ADD CONSTRAINT wallet_entries_kind_check CHECK (kind IN (
  'checkout_hold', 'hold_release', 'late_payment_credit', 'cancel_credit', 'refund', 'manual_adjustment',
  'counter_charge', 'counter_void', 'topup_credit', 'uncollected_credit'));
ALTER TABLE wallet_entries DROP CONSTRAINT wallet_entries_source_type_check;
ALTER TABLE wallet_entries ADD CONSTRAINT wallet_entries_source_type_check
  CHECK (source_type IN ('checkout', 'payment', 'adjustment', 'counter_sale', 'topup', 'order'));
ALTER TABLE wallet_entries DROP CONSTRAINT wallet_entries_sign_check;
ALTER TABLE wallet_entries ADD CONSTRAINT wallet_entries_sign_check CHECK (
  (kind IN ('checkout_hold', 'refund', 'counter_charge') AND amount_cents < 0)
  OR (kind IN ('hold_release', 'late_payment_credit', 'cancel_credit', 'counter_void', 'topup_credit', 'uncollected_credit') AND amount_cents > 0)
  OR kind = 'manual_adjustment'
);
CREATE UNIQUE INDEX wallet_entries_one_uncollected_credit ON wallet_entries (school_id, source_id) WHERE kind = 'uncollected_credit';

-- "Finalizar turno" vindo do tablet. event_id gerado no cliente é a chave (regra 36); append-only.
CREATE TABLE shift_events (
  event_id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  service_day_shift_id uuid NOT NULL,
  device_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('shift_finished')),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, event_id),
  FOREIGN KEY (school_id, service_day_shift_id) REFERENCES service_day_shifts (school_id, id),
  FOREIGN KEY (school_id, device_id) REFERENCES devices (school_id, id)
);

-- Decisão da secretaria sobre um pedido não retirado. Uma por pedido; só a conferência muda depois.
CREATE TABLE uncollected_decisions (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  order_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('credited', 'kept')),
  guardian_id uuid,
  wallet_entry_id uuid,
  amount_cents bigint CHECK (amount_cents > 0),
  reason text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 200),
  staff_user_id uuid NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by_staff_id uuid,
  UNIQUE (school_id, id),
  UNIQUE (school_id, order_id),
  FOREIGN KEY (school_id, order_id) REFERENCES orders (school_id, id),
  FOREIGN KEY (school_id, guardian_id) REFERENCES guardians (school_id, id),
  FOREIGN KEY (school_id, wallet_entry_id) REFERENCES wallet_entries (school_id, id),
  FOREIGN KEY (school_id, staff_user_id) REFERENCES staff_users (school_id, id),
  FOREIGN KEY (school_id, reviewed_by_staff_id) REFERENCES staff_users (school_id, id),
  CHECK ((decision = 'credited') = (wallet_entry_id IS NOT NULL)),
  CHECK ((wallet_entry_id IS NULL) = (guardian_id IS NULL) AND (guardian_id IS NULL) = (amount_cents IS NULL)),
  CHECK ((reviewed_at IS NULL) = (reviewed_by_staff_id IS NULL)),
  CHECK (reviewed_at IS NULL OR decision = 'credited')
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['service_day_shifts', 'shift_events', 'uncollected_decisions']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (school_id = app_school_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON service_day_shifts TO app_user;
GRANT SELECT, INSERT ON shift_events, uncollected_decisions TO app_user;
GRANT UPDATE (reviewed_at, reviewed_by_staff_id) ON uncollected_decisions TO app_user;
