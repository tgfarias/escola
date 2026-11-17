import type { PaymentStatus, PaymentView } from "@app-lanche/contracts";
import type { FastifyBaseLogger } from "fastify";
import { withTenant, type Trx } from "../../db/index";
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
