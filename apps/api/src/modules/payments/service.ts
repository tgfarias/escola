import type { PaymentStatus, PaymentView } from "@app-lanche/contracts";
import type { FastifyBaseLogger } from "fastify";
import { withTenant, type Trx } from "../../db/index";
import * as catalog from "../catalog/service";
import * as orders from "../orders/service";
import * as repo from "./repo";
import { defaultProviderName, getProvider } from "./registry";

export async function createPendingPayment(
  trx: Trx,
  input: { schoolId: string; checkoutId: string; amountCents: number; expiresAt: Date },
): Promise<string> {
  return repo.insertPayment(trx, { ...input, provider: defaultProviderName() });
}

/** Cria a cobrança no gateway fora de transação (CLAUDE.md regra 20). Idempotente pelo id do pagamento. */
export async function ensureCharge(schoolId: string, checkoutId: string, log: FastifyBaseLogger): Promise<void> {
  const pending = await withTenant(schoolId, async (trx) => {
    const payment = await repo.unchargedPendingPayment(trx, checkoutId);
    return payment && { payment, school: await repo.schoolPaymentConfig(trx) };
  });
  if (!pending) return;
  const { payment, school } = pending;
  let charge;
  try {
    charge = await getProvider(payment.provider).createCharge({
      paymentId: payment.id,
      schoolId,
      amountCents: payment.amountCents,
      expiresAt: payment.expiresAt,
      description: "Lanche escolar",
      accountRef: school.paymentAccountRef,
      platformFeeBps: school.platformFeeBps,
    });
  } catch {
    log.warn({ event: "charge_create_failed", payment_id: payment.id }, "charge creation failed");
    return;
  }
  await withTenant(schoolId, (trx) => repo.attachCharge(trx, payment.id, charge));
}

export async function paymentViews(trx: Trx, checkoutIds: string[]): Promise<Map<string, PaymentView>> {
  const rows = await repo.paymentsForCheckouts(trx, checkoutIds);
  return new Map(
    rows.map((p) => [
      p.checkoutId,
      {
        status: p.status as PaymentStatus,
        amountCents: p.amountCents,
        pixCopyPaste: p.pixCopyPaste,
        pixQrPngBase64: p.pixQrPngBase64,
        expiresAt: p.expiresAt.toISOString(),
      },
    ]),
  );
}

export type ConfirmOutcome = "confirmed" | "late_credited" | "already_processed";

/** Única função que confirma pagamento (CLAUDE.md regra 10). Webhook e conciliação chamam esta. */
export async function confirmPayment(
  trx: Trx,
  input: { schoolId: string; paymentId: string; paidAt: Date },
): Promise<ConfirmOutcome> {
  const payment = await repo.paymentContext(trx, input.paymentId);
  if (!payment) throw new Error(`payment ${input.paymentId} not found`);
  const day = await catalog.lockServiceDayById(trx, payment.serviceDayId, "share");
  if (!(await repo.markPaid(trx, payment.id, input.paidAt))) return "already_processed";

  const onTime = day.status === "open" && input.paidAt.getTime() <= day.cutoffAt.getTime();
  if (onTime && (await orders.confirmCheckout(trx, input.schoolId, payment.checkoutId))) return "confirmed";

  await orders.creditLatePayment(trx, {
    schoolId: input.schoolId,
    checkoutId: payment.checkoutId,
    paymentId: payment.id,
    amountCents: payment.amountCents,
  });
  return "late_credited";
}
