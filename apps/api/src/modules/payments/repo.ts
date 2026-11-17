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

export async function unchargedPendingPayment(trx: Trx, checkoutId: string) {
  return trx
    .selectFrom("payments")
    .select(["id", "provider", "amountCents", "expiresAt"])
    .where("checkoutId", "=", checkoutId)
    .where("status", "=", "pending")
    .where("providerChargeId", "is", null)
    .executeTakeFirst();
}

export async function schoolPaymentConfig(trx: Trx) {
  return trx
    .selectFrom("schools")
    .select(["paymentAccountRef", "paymentWebhookSecretRef", "platformFeeBps", "kitchenPhone"])
    .executeTakeFirstOrThrow();
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

export async function paymentContext(trx: Trx, paymentId: string) {
  return trx
    .selectFrom("payments")
    .innerJoin("checkouts", "checkouts.id", "payments.checkoutId")
    .select(["payments.id", "payments.checkoutId", "payments.amountCents", "checkouts.serviceDayId"])
    .where("payments.id", "=", paymentId)
    .executeTakeFirst();
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
