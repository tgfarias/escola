import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import type { Trx } from "../../db/index";
import type { Charge } from "./provider";

export async function insertPayment(
  trx: Trx,
  row: { schoolId: string; checkoutId: string; provider: string; amountCents: number; expiresAt: Date },
): Promise<string> {
  const id = uuidv7();
  await trx.insertInto("payments").values({ id, method: "pix", ...row }).execute();
  return id;
}

export type PaymentRef = { checkoutId: string } | { topupId: string };

/** Pix de recarga: vale 60 min pelo relógio do banco. */
export async function insertTopupPayment(
  trx: Trx,
  row: { schoolId: string; topupId: string; provider: string; amountCents: number },
): Promise<string> {
  const id = uuidv7();
  await trx.insertInto("payments").values({ id, method: "pix", ...row, expiresAt: sql<Date>`now() + interval '60 minutes'` }).execute();
  return id;
}

export async function unchargedPendingPayment(trx: Trx, ref: PaymentRef) {
  const base = trx
    .selectFrom("payments")
    .select(["id", "provider", "amountCents", "expiresAt"])
    .where("status", "=", "pending")
    .where("providerChargeId", "is", null)
    // Depois do vencimento não se cria cobrança viva (CLAUDE.md regra 15: o tempo vem do banco).
    .where("expiresAt", ">", sql<Date>`now()`);
  return ("checkoutId" in ref ? base.where("checkoutId", "=", ref.checkoutId) : base.where("topupId", "=", ref.topupId)).executeTakeFirst();
}

export async function schoolPaymentConfig(trx: Trx) {
  return trx
    .selectFrom("schools")
    .select(["paymentAccountRef", "paymentWebhookSecretRef", "platformFeeBps", "kitchenPhone"])
    .executeTakeFirstOrThrow();
}

/** Like `schoolPaymentConfig`, but `undefined` when the school does not exist; real errors propagate. */
export async function findSchoolPaymentConfig(trx: Trx) {
  return trx
    .selectFrom("schools")
    .select(["paymentAccountRef", "paymentWebhookSecretRef", "platformFeeBps", "kitchenPhone"])
    .executeTakeFirst();
}

export async function attachCharge(trx: Trx, paymentId: string, charge: Charge): Promise<void> {
  await trx
    .updateTable("payments")
    .set({ providerChargeId: charge.chargeId, pixCopyPaste: charge.pixCopyPaste, pixQrPngBase64: charge.pixQrPngBase64 })
    .where("id", "=", paymentId)
    .where("providerChargeId", "is", null)
    .execute();
}

export async function paymentsForCheckouts(trx: Trx, checkoutIds: string[]) {
  if (checkoutIds.length === 0) return [];
  return trx
    .selectFrom("payments")
    .select(["checkoutId", "status", "amountCents", "pixCopyPaste", "pixQrPngBase64", "expiresAt"])
    .where("checkoutId", "in", checkoutIds)
    .execute();
}

/** Alvo do pagamento: checkout (com o dia de serviço) ou recarga. */
export async function paymentTarget(trx: Trx, paymentId: string) {
  return trx
    .selectFrom("payments")
    .leftJoin("checkouts", "checkouts.id", "payments.checkoutId")
    .select(["payments.id", "payments.checkoutId", "payments.topupId", "payments.amountCents", "checkouts.serviceDayId"])
    .where("payments.id", "=", paymentId)
    .executeTakeFirst();
}

export async function paymentsForTopups(trx: Trx, topupIds: string[]) {
  if (topupIds.length === 0) return [];
  return trx
    .selectFrom("payments")
    .select(["topupId", "status", "amountCents", "pixCopyPaste", "pixQrPngBase64", "expiresAt"])
    .where("topupId", "in", topupIds)
    .execute();
}

export async function expireTopupPayment(trx: Trx, topupId: string): Promise<void> {
  await trx.updateTable("payments").set({ status: "expired" }).where("topupId", "=", topupId).where("status", "=", "pending").execute();
}

/** pending → paid, ou expired → paid (pagamento depois do fechamento). */
export async function markPaid(trx: Trx, paymentId: string, paidAt: Date): Promise<boolean> {
  const row = await trx
    .updateTable("payments")
    .set({ status: "paid", paidAt })
    .where("id", "=", paymentId)
    .where("status", "in", ["pending", "expired"])
    .returning("id")
    .executeTakeFirst();
  return row !== undefined;
}

export async function paymentByCharge(trx: Trx, provider: string, chargeId: string) {
  return trx
    .selectFrom("payments")
    .select(["id", "amountCents"])
    .where("provider", "=", provider)
    .where("providerChargeId", "=", chargeId)
    .executeTakeFirst();
}

export async function recordEvent(
  trx: Trx,
  row: { provider: string; providerEventId: string; schoolId: string; paymentId: string | null; raw: string },
): Promise<boolean> {
  const inserted = await trx
    .insertInto("paymentEvents")
    .values({ id: uuidv7(), ...row })
    .onConflict((oc) => oc.columns(["provider", "providerEventId"]).doNothing())
    .returning("id")
    .executeTakeFirst();
  return inserted !== undefined;
}

export async function expirePending(trx: Trx, checkoutId: string): Promise<void> {
  await trx.updateTable("payments").set({ status: "expired" }).where("checkoutId", "=", checkoutId).where("status", "=", "pending").execute();
}

export async function pendingChargesForDay(trx: Trx, serviceDate: string) {
  return trx
    .selectFrom("payments")
    .innerJoin("checkouts", "checkouts.id", "payments.checkoutId")
    .innerJoin("serviceDays", "serviceDays.id", "checkouts.serviceDayId")
    .select(["payments.id", "payments.provider", "payments.providerChargeId", "payments.amountCents"])
    .where("serviceDays.serviceDate", "=", serviceDate)
    .where("payments.status", "=", "pending")
    .where("payments.providerChargeId", "is not", null)
    .execute();
}
