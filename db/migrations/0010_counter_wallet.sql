-- F5B: lançamento no balcão, débito com limite, recarga por Pix e avisos de débito
-- (spec 2026-11-19-balcao-carteira-design.md).

-- Limite de débito por escola (padrão R$ 50,00). A equipe só altera esta coluna de schools.
ALTER TABLE schools ADD COLUMN debt_limit_cents bigint NOT NULL DEFAULT 5000 CHECK (debt_limit_cents >= 0);
GRANT UPDATE (debt_limit_cents) ON schools TO app_user;

-- Responsável financeiro: no máximo um por aluno. guardian_students não guarda a data do vínculo:
-- o mais antigo é o do responsável cadastrado primeiro (created_at, depois o id UUID v7).
ALTER TABLE guardian_students ADD COLUMN financial boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX guardian_students_one_financial ON guardian_students (school_id, student_id) WHERE financial;
UPDATE guardian_students gs SET financial = true
FROM (
  SELECT DISTINCT ON (l.school_id, l.student_id) l.school_id, l.student_id, l.guardian_id
  FROM guardian_students l JOIN guardians g ON g.id = l.guardian_id
  ORDER BY l.school_id, l.student_id, g.created_at, g.id
) first
WHERE gs.school_id = first.school_id AND gs.student_id = first.student_id AND gs.guardian_id = first.guardian_id;

-- O saldo pode ficar negativo (débito com limite); o piso é regra do serviço (wallet.postEntry).
ALTER TABLE wallets DROP CONSTRAINT wallets_balance_cents_check;
-- Último aviso de débito (wallet.debt_notice); repetido a cada 3 dias enquanto o saldo seguir negativo.
ALTER TABLE wallets ADD COLUMN debt_notice_at timestamptz;

ALTER TABLE wallet_entries DROP CONSTRAINT wallet_entries_kind_check;
ALTER TABLE wallet_entries ADD CONSTRAINT wallet_entries_kind_check CHECK (kind IN (
  'checkout_hold', 'hold_release', 'late_payment_credit', 'cancel_credit', 'refund', 'manual_adjustment',
  'counter_charge', 'counter_void', 'topup_credit'));
ALTER TABLE wallet_entries DROP CONSTRAINT wallet_entries_source_type_check;
ALTER TABLE wallet_entries ADD CONSTRAINT wallet_entries_source_type_check
  CHECK (source_type IN ('checkout', 'payment', 'adjustment', 'counter_sale', 'topup'));
ALTER TABLE wallet_entries DROP CONSTRAINT wallet_entries_check;
ALTER TABLE wallet_entries ADD CONSTRAINT wallet_entries_sign_check CHECK (
  (kind IN ('checkout_hold', 'refund', 'counter_charge') AND amount_cents < 0)
  OR (kind IN ('hold_release', 'late_payment_credit', 'cancel_credit', 'counter_void', 'topup_credit') AND amount_cents > 0)
  OR kind = 'manual_adjustment'
);

-- Um registro por lançamento no balcão. O id vem do tablet (regra 36) ou da API (secretaria).
CREATE TABLE counter_sales (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  student_id uuid NOT NULL,
  guardian_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('kitchen', 'staff')),
  device_id uuid,
  staff_user_id uuid,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  total_cents bigint NOT NULL CHECK (total_cents > 0),
  over_limit boolean NOT NULL,
  wallet_entry_id uuid NOT NULL,
  voided_at timestamptz,
  void_entry_id uuid,
  UNIQUE (school_id, id),
  FOREIGN KEY (school_id, student_id) REFERENCES students (school_id, id),
  FOREIGN KEY (school_id, guardian_id) REFERENCES guardians (school_id, id),
  FOREIGN KEY (school_id, device_id) REFERENCES devices (school_id, id),
  FOREIGN KEY (school_id, staff_user_id) REFERENCES staff_users (school_id, id),
  FOREIGN KEY (school_id, wallet_entry_id) REFERENCES wallet_entries (school_id, id),
  FOREIGN KEY (school_id, void_entry_id) REFERENCES wallet_entries (school_id, id),
  CHECK ((source = 'kitchen') = (device_id IS NOT NULL)),
  CHECK ((source = 'staff') = (staff_user_id IS NOT NULL)),
  CHECK ((voided_at IS NULL) = (void_entry_id IS NULL))
);
CREATE INDEX counter_sales_guardian ON counter_sales (school_id, guardian_id, occurred_at DESC);
CREATE INDEX counter_sales_student ON counter_sales (school_id, student_id, occurred_at DESC);
CREATE INDEX counter_sales_over_limit ON counter_sales (school_id, received_at) WHERE over_limit AND voided_at IS NULL;

CREATE TABLE counter_sale_items (
  school_id uuid NOT NULL REFERENCES schools (id),
  sale_id uuid NOT NULL,
  menu_item_id uuid NOT NULL,
  qty integer NOT NULL CHECK (qty BETWEEN 1 AND 10),
  unit_price_cents bigint NOT NULL CHECK (unit_price_cents > 0),
  PRIMARY KEY (school_id, sale_id, menu_item_id),
  FOREIGN KEY (school_id, sale_id) REFERENCES counter_sales (school_id, id),
  FOREIGN KEY (school_id, menu_item_id) REFERENCES menu_items (school_id, id)
);

-- Recarga por Pix (pagar débito ou colocar créditos). A cobrança fica em payments.topup_id.
CREATE TABLE topups (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  guardian_id uuid NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 1000000),
  status text NOT NULL DEFAULT 'pending_payment' CHECK (status IN ('pending_payment', 'paid', 'expired', 'cancelled')),
  requested_by text NOT NULL CHECK (requested_by IN ('guardian', 'staff')),
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  UNIQUE (school_id, id),
  FOREIGN KEY (school_id, guardian_id) REFERENCES guardians (school_id, id),
  CHECK ((status = 'paid') = (paid_at IS NOT NULL))
);
CREATE INDEX topups_guardian ON topups (school_id, guardian_id, created_at DESC);
CREATE INDEX topups_pending ON topups (school_id) WHERE status = 'pending_payment';

ALTER TABLE payments ALTER COLUMN checkout_id DROP NOT NULL;
ALTER TABLE payments ADD COLUMN topup_id uuid;
ALTER TABLE payments ADD CONSTRAINT payments_topup_fk FOREIGN KEY (school_id, topup_id) REFERENCES topups (school_id, id);
ALTER TABLE payments ADD CONSTRAINT payments_one_target CHECK ((checkout_id IS NULL) <> (topup_id IS NULL));
CREATE UNIQUE INDEX payments_one_per_topup ON payments (school_id, topup_id) WHERE topup_id IS NOT NULL;

ALTER TABLE magic_links DROP CONSTRAINT magic_links_scope_check;
ALTER TABLE magic_links ADD CONSTRAINT magic_links_scope_check CHECK (scope IN ('order', 'documents', 'wallet'));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['counter_sales', 'counter_sale_items', 'topups']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (school_id = app_school_id())', t);
  END LOOP;
END $$;

-- Lançamento é imutável; só o estorno marca voided_at/void_entry_id. Itens são append-only.
GRANT SELECT, INSERT ON counter_sales, counter_sale_items TO app_user;
GRANT UPDATE (voided_at, void_entry_id) ON counter_sales TO app_user;
GRANT SELECT, INSERT, UPDATE ON topups TO app_user;

-- Agenda (spec 4.4): mesma função e assinatura, com duas ações novas. Nenhuma função SECURITY DEFINER nova.
CREATE OR REPLACE FUNCTION list_due_actions()
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
  UNION ALL
  -- Aviso de débito: no máximo a cada 3 dias enquanto negativo, só das 09:00 às 19:00 no fuso da escola.
  SELECT 'send_debt_notices'::text, s.id, (now() AT TIME ZONE s.timezone)::date, false
  FROM schools s
  WHERE (now() AT TIME ZONE s.timezone)::time >= time '09:00'
    AND (now() AT TIME ZONE s.timezone)::time < time '19:00'
    AND EXISTS (
      SELECT 1 FROM wallets w
      WHERE w.school_id = s.id AND w.balance_cents < 0
        AND (w.debt_notice_at IS NULL OR w.debt_notice_at <= now() - interval '3 days'))
  UNION ALL
  -- Recargas pendentes: conciliação e expiração pelo job do Cloud Scheduler, nunca pelo n8n (regra 21).
  SELECT 'reconcile_topups'::text, s.id, (now() AT TIME ZONE s.timezone)::date, false
  FROM schools s
  WHERE EXISTS (SELECT 1 FROM topups t WHERE t.school_id = s.id AND t.status = 'pending_payment')
  ORDER BY 3, 2, 1
$$;
