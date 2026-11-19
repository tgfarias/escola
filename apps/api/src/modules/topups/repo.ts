import { sql } from "kysely";
import type { Trx } from "../../db/index";

/**
 * Grava a recarga pendente. Devolve false se outra transação gravou uma pendente para o mesmo responsável no meio
 * tempo (índice topups_one_pending): quem chama cancela de novo e repete.
 */
export async function insertTopup(
  trx: Trx,
  row: { id: string; schoolId: string; guardianId: string; amountCents: number; requestedBy: "guardian" | "staff" },
): Promise<boolean> {
  const inserted = await trx
    .insertInto("topups")
    .values(row)
    .onConflict((oc) => oc.columns(["schoolId", "guardianId"]).where(sql<boolean>`status = 'pending_payment'`).doNothing())
    .returning("id")
    .executeTakeFirst();
  return inserted !== undefined;
}

/** Uma recarga pendente por responsável: as anteriores viram `cancelled`. */
export async function cancelPendingTopups(trx: Trx, guardianId: string): Promise<string[]> {
  const rows = await trx
    .updateTable("topups")
    .set({ status: "cancelled" })
    .where("guardianId", "=", guardianId)
    .where("status", "=", "pending_payment")
    .returning("id")
    .execute();
  return rows.map((r) => r.id);
}

export async function lockTopup(trx: Trx, id: string): Promise<void> {
  await trx.selectFrom("topups").select("id").where("id", "=", id).forUpdate().executeTakeFirst();
}

/** pending_payment | expired | cancelled → paid. Recarga não tem corte. */
export async function markTopupPaid(trx: Trx, id: string, paidAt: Date) {
  return trx
    .updateTable("topups")
    .set({ status: "paid", paidAt })
    .where("id", "=", id)
    .where("status", "in", ["pending_payment", "expired", "cancelled"])
    .returning(["guardianId"])
    .executeTakeFirst();
}

export async function topupHeader(trx: Trx, id: string) {
  return trx
    .selectFrom("topups")
    .select(["id", "guardianId", "status", "amountCents", "createdAt", "paidAt"])
    .where("id", "=", id)
    .executeTakeFirst();
}

export async function guardianExists(trx: Trx, id: string): Promise<boolean> {
  return (await trx.selectFrom("guardians").select("id").where("id", "=", id).executeTakeFirst()) !== undefined;
}

/** Recargas pendentes cujo Pix venceu (relógio do banco). */
export async function overdueTopupIds(trx: Trx): Promise<string[]> {
  const { rows } = await sql<{ id: string }>`
    SELECT t.id FROM topups t JOIN payments p ON p.topup_id = t.id
    WHERE t.status = 'pending_payment' AND p.expires_at <= now()
    ORDER BY t.id`.execute(trx);
  return rows.map((r) => r.id);
}

export async function expireTopup(trx: Trx, id: string): Promise<boolean> {
  const row = await trx.updateTable("topups").set({ status: "expired" }).where("id", "=", id).where("status", "=", "pending_payment").returning("id").executeTakeFirst();
  return row !== undefined;
}
