-- F5C Parte B: agenda por turno (spec 4.4). Mesma função e assinatura; nenhuma função SECURITY DEFINER nova.
-- send_reminders: abre quando algum turno aberto entra na antecedência da escola.
-- close_service_day: o dia entra quando algum turno aberto passou do congelamento; atrasado se passou 10 min do corte.
-- finish_shifts (novo, só do job /jobs/v1/shifts/safety-finish): turno fechado e não finalizado depois das 23:00 locais.
CREATE OR REPLACE FUNCTION list_due_actions()
RETURNS TABLE (action text, school_id uuid, service_date date, overdue boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT 'send_reminders'::text, d.school_id, d.service_date, false
  FROM service_days d JOIN schools s ON s.id = d.school_id
  WHERE d.status = 'open'
    AND EXISTS (
      SELECT 1 FROM service_day_shifts sh
      WHERE sh.service_day_id = d.id AND sh.status = 'open'
        AND now() >= sh.cutoff_at - make_interval(mins => s.reminder_lead_minutes)
        AND now() < sh.cutoff_at)
    AND NOT EXISTS (
      SELECT 1 FROM reminder_batches b
      WHERE b.school_id = d.school_id AND b.service_date = d.service_date AND b.completed_at IS NOT NULL)
  UNION ALL
  SELECT 'close_service_day'::text, d.school_id, d.service_date, bool_or(now() >= sh.cutoff_at + interval '10 minutes')
  FROM service_days d JOIN service_day_shifts sh ON sh.service_day_id = d.id
  WHERE sh.status = 'open' AND now() >= sh.freeze_at
  GROUP BY d.school_id, d.service_date
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
  UNION ALL
  SELECT 'finish_shifts'::text, d.school_id, d.service_date, false
  FROM service_days d JOIN schools s ON s.id = d.school_id
  WHERE EXISTS (SELECT 1 FROM service_day_shifts sh WHERE sh.service_day_id = d.id AND sh.status = 'closed')
    AND now() >= ((d.service_date + time '23:00') AT TIME ZONE s.timezone)
  ORDER BY 3, 2, 1
$$;
