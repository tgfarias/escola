-- F5B, correções finais: uma recarga pendente por responsável, grant mínimo em topups e conciliação das
-- recargas canceladas ou expiradas há pouco (o Pix delas continua pagável no gateway).

-- Duas criações simultâneas não deixam duas recargas pendentes; o serviço cancela e tenta de novo.
CREATE UNIQUE INDEX topups_one_pending ON topups (school_id, guardian_id) WHERE status = 'pending_payment';

-- A aplicação só muda o estado e a data do pagamento de uma recarga.
REVOKE UPDATE ON topups FROM app_user;
GRANT UPDATE (status, paid_at) ON topups TO app_user;

-- Agenda (spec 4.4): mesma função e assinatura. reconcile_topups passa a listar também escolas com recarga
-- cancelada ou expirada nas últimas 24 h e pagamento ainda não pago. Nenhuma função SECURITY DEFINER nova.
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
  -- Recargas: conciliação e expiração pelo job do Cloud Scheduler, nunca pelo n8n (regra 21).
  SELECT 'reconcile_topups'::text, s.id, (now() AT TIME ZONE s.timezone)::date, false
  FROM schools s
  WHERE EXISTS (SELECT 1 FROM topups t WHERE t.school_id = s.id AND t.status = 'pending_payment')
     OR EXISTS (
       SELECT 1 FROM topups t JOIN payments p ON p.school_id = t.school_id AND p.topup_id = t.id
       WHERE t.school_id = s.id AND t.status IN ('cancelled', 'expired') AND t.created_at > now() - interval '24 hours'
         AND p.status IN ('pending', 'expired') AND p.provider_charge_id IS NOT NULL)
  ORDER BY 3, 2, 1
$$;
