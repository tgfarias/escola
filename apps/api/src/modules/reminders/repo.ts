import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import type { Trx } from "../../db/index";

/** Um lote por escola e data: repetir o prepare reaproveita o mesmo lote. */
export async function ensureBatch(trx: Trx, schoolId: string, serviceDate: string): Promise<string> {
  await trx
    .insertInto("reminderBatches")
    .values({ id: uuidv7(), schoolId, serviceDate })
    .onConflict((oc) => oc.columns(["schoolId", "serviceDate"]).doNothing())
    .execute();
  const row = await trx.selectFrom("reminderBatches").select("id").where("serviceDate", "=", serviceDate).executeTakeFirstOrThrow();
  return row.id;
}

export async function batchExists(trx: Trx, batchId: string): Promise<boolean> {
  const row = await trx.selectFrom("reminderBatches").select("id").where("id", "=", batchId).executeTakeFirst();
  return row !== undefined;
}

/**
 * Responsáveis com ao menos um filho ativo sem pedido confirmado/entregue na data, que ainda não
 * constam como `sent` no lote; ordenados por id a partir do cursor. Traz `limit + 1` para saber se há próxima página.
 */
export async function candidates(trx: Trx, input: { batchId: string; serviceDate: string; cursor: string | null; limit: number }) {
  const { rows } = await sql<{ guardianId: string; phone: string; firstName: string; students: string[] }>`
    SELECT g.id AS guardian_id, g.phone_e164 AS phone, g.first_name,
           array_agg(st.first_name ORDER BY st.first_name, st.id) AS students
    FROM guardians g
    JOIN guardian_students gs ON gs.guardian_id = g.id
    JOIN students st ON st.id = gs.student_id AND st.active
    LEFT JOIN LATERAL (
      SELECT true AS ordered FROM orders o
      WHERE o.student_id = st.id AND o.service_date = ${input.serviceDate}::date AND o.status IN ('confirmed', 'delivered')
      LIMIT 1
    ) o ON true
    WHERE (${input.cursor}::uuid IS NULL OR g.id > ${input.cursor}::uuid)
      AND NOT EXISTS (
        SELECT 1 FROM message_deliveries md
        WHERE md.batch_id = ${input.batchId}::uuid AND md.guardian_id = g.id AND md.status = 'sent')
    GROUP BY g.id
    HAVING bool_or(o.ordered IS NULL)
    ORDER BY g.id
    LIMIT ${input.limit + 1}`.execute(trx);
  return rows;
}

export async function markPrepared(trx: Trx, schoolId: string, batchId: string, guardianIds: string[]): Promise<void> {
  if (guardianIds.length === 0) return;
  await trx
    .insertInto("messageDeliveries")
    .values(guardianIds.map((guardianId) => ({ id: uuidv7(), schoolId, batchId, guardianId })))
    .onConflict((oc) => oc.columns(["schoolId", "batchId", "guardianId"]).doNothing())
    .execute();
}

export async function completeBatch(trx: Trx, batchId: string): Promise<void> {
  await trx.updateTable("reminderBatches").set({ completedAt: sql`now()` }).where("id", "=", batchId).where("completedAt", "is", null).execute();
}

/** Hora local do corte no fuso da escola, calculada pelo banco. */
export async function cutoffLocalTime(trx: Trx, serviceDayId: string): Promise<string> {
  const { rows } = await sql<{ local: string }>`
    SELECT to_char(d.cutoff_at AT TIME ZONE s.timezone, 'HH24:MI') AS local
    FROM service_days d JOIN schools s ON s.id = d.school_id WHERE d.id = ${serviceDayId}`.execute(trx);
  return rows[0]!.local;
}

/** "sent" é terminal: um resultado atrasado não o desfaz. */
export async function recordResult(
  trx: Trx,
  batchId: string,
  r: { guardianId: string; status: "sent" | "failed"; waMessageId: string | null; error: string | null },
): Promise<void> {
  await trx
    .updateTable("messageDeliveries")
    .set({ status: r.status, waMessageId: r.waMessageId, error: r.error, updatedAt: sql`now()` })
    .where("batchId", "=", batchId)
    .where("guardianId", "=", r.guardianId)
    .where("status", "<>", "sent")
    .execute();
}
