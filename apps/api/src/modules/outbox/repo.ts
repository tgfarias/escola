import { sql } from "kysely";
import { getDb, type Trx } from "../../db/index";

export type ClaimedEvent = {
  id: string;
  type: string;
  data: string;
  occurredAt: Date;
  /** Mais de 24 h sem entrega, ou OTP já vencido: não deve ser enviado. */
  abandon: boolean;
  /** Valor exato de next_attempt_at gravado pelo arrendamento (texto preserva microssegundos). */
  lease: string;
};

const ABANDON_EXPR = sql`coalesce(
  occurred_at < now() - interval '24 hours'
    OR (type = 'auth.otp_requested' AND (data->>'expires_at')::timestamptz <= now()),
  false)`;

/** Escolas com eventos prontos (função SECURITY DEFINER, spec 6.3). */
export async function listSchoolsWithPendingEvents(): Promise<string[]> {
  // getDb() só para a chamada da função SECURITY DEFINER; todo o resto usa withTenant.
  const { rows } = await sql<{ schoolId: string }>`SELECT school_id FROM list_schools_with_pending_events()`.execute(getDb());
  return rows.map((r) => r.schoolId);
}

/**
 * Reserva até `limit` eventos prontos: trava com SKIP LOCKED e arrenda por 2 min antes de qualquer HTTP,
 * para outro dispatcher não pegar o mesmo evento enquanto este envia.
 */
export async function claim(trx: Trx, limit: number): Promise<ClaimedEvent[]> {
  const { rows } = await sql<ClaimedEvent>`
    WITH c AS (
      SELECT id FROM outbox_events
      WHERE delivered_at IS NULL AND failed_at IS NULL AND next_attempt_at <= now()
      ORDER BY next_attempt_at, id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE outbox_events o SET next_attempt_at = now() + interval '2 minutes'
    FROM c WHERE o.id = c.id
    RETURNING o.id, o.type, o.data::text AS data, o.occurred_at,
      coalesce(o.occurred_at < now() - interval '24 hours'
        OR (o.type = 'auth.otp_requested' AND (o.data->>'expires_at')::timestamptz <= now()), false) AS abandon,
      o.next_attempt_at::text AS lease`.execute(trx);
  return rows.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * Renova o arrendamento do evento logo antes de enviar. Sem linha de volta, outro dispatcher o tomou
 * (ou já foi concluído): quem chamou deve pular. `abandon` é reavaliado agora.
 */
export async function release(trx: Trx, id: string, lease: string): Promise<{ abandon: boolean } | undefined> {
  const { rows } = await sql<{ abandon: boolean }>`
    UPDATE outbox_events SET next_attempt_at = now() + interval '2 minutes'
    WHERE id = ${id} AND next_attempt_at = ${lease}::timestamptz AND delivered_at IS NULL AND failed_at IS NULL
    RETURNING ${ABANDON_EXPR} AS abandon`.execute(trx);
  return rows[0];
}

const SCRUB_OTP = sql`CASE WHEN type = 'auth.otp_requested' THEN '{}'::jsonb ELSE data END`;

export async function markDelivered(trx: Trx, id: string): Promise<void> {
  await sql`
    UPDATE outbox_events SET delivered_at = now(), attempts = attempts + 1, data = ${SCRUB_OTP}
    WHERE id = ${id} AND delivered_at IS NULL AND failed_at IS NULL`.execute(trx);
}

export async function markAttemptFailed(trx: Trx, id: string): Promise<void> {
  await sql`
    UPDATE outbox_events SET
      attempts = attempts + 1,
      next_attempt_at = now() + least(power(2, least(attempts, 6)) * interval '1 minute', interval '60 minutes'),
      failed_at = CASE WHEN occurred_at < now() - interval '24 hours' THEN now() END,
      data = CASE WHEN occurred_at < now() - interval '24 hours' THEN ${SCRUB_OTP} ELSE data END
    WHERE id = ${id} AND delivered_at IS NULL AND failed_at IS NULL`.execute(trx);
}

export async function abandon(trx: Trx, id: string): Promise<void> {
  await sql`
    UPDATE outbox_events SET failed_at = now(), data = ${SCRUB_OTP}
    WHERE id = ${id} AND delivered_at IS NULL AND failed_at IS NULL`.execute(trx);
}
