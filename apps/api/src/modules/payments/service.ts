import type { PaymentStatus, PaymentView } from "@app-lanche/contracts";
import type { FastifyBaseLogger } from "fastify";
import { withTenant, type Trx } from "../../db/index";
import { DomainError } from "../../platform/errors";
import { getSecret } from "../../platform/secrets";
import * as catalog from "../catalog/service";
import * as orders from "../orders/service";
import * as topups from "../topups/service";
import * as repo from "./repo";
import type { PaymentRef } from "./repo";
import { defaultProviderName, getProvider } from "./registry";

export type { PaymentRef } from "./repo";

export async function createPendingPayment(
  trx: Trx,
  input: { schoolId: string; checkoutId: string; amountCents: number; expiresAt: Date },
): Promise<string> {
  return repo.insertPayment(trx, { ...input, provider: defaultProviderName() });
}

/** Cria a cobrança no gateway fora de transação (CLAUDE.md regra 20). Idempotente pelo id do pagamento. */
export async function ensureCharge(schoolId: string, ref: PaymentRef, log: FastifyBaseLogger): Promise<void> {
  const pending = await withTenant(schoolId, async (trx) => {
    const payment = await repo.unchargedPendingPayment(trx, ref);
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
      description: "checkoutId" in ref ? "Lanche escolar" : "Créditos do lanche escolar",
      accountRef: school.paymentAccountRef,
      platformFeeBps: school.platformFeeBps,
    });
  } catch {
    log.warn({ event: "charge_create_failed", payment_id: payment.id }, "charge creation failed");
    return;
  }
  try {
    await withTenant(schoolId, (trx) => repo.attachCharge(trx, payment.id, charge));
  } catch {
    // A cobrança existe no gateway; a próxima tentativa recebe a mesma (idempotente pelo id) e a grava.
    log.warn({ event: "charge_attach_failed", payment_id: payment.id }, "charge attach failed");
  }
}

export async function paymentViews(trx: Trx, checkoutIds: string[]): Promise<Map<string, PaymentView>> {
  const rows = await repo.paymentsForCheckouts(trx, checkoutIds);
  return new Map(
    rows.map((p) => [
      p.checkoutId!, // paymentsForCheckouts filtra por checkout_id
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

export async function createTopupPayment(trx: Trx, input: { schoolId: string; topupId: string; amountCents: number }): Promise<string> {
  return repo.insertTopupPayment(trx, { ...input, provider: defaultProviderName() });
}

export async function topupPaymentViews(trx: Trx, topupIds: string[]): Promise<Map<string, PaymentView>> {
  const rows = await repo.paymentsForTopups(trx, topupIds);
  return new Map(
    rows.map((p) => [
      p.topupId!, // paymentsForTopups filtra por topup_id
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

export async function expireTopupPayment(trx: Trx, topupId: string): Promise<void> {
  await repo.expireTopupPayment(trx, topupId);
}

export type ConfirmOutcome = "confirmed" | "late_credited" | "already_processed" | "topup_credited";

/**
 * Única função que confirma pagamento (CLAUDE.md regra 10). Webhook e conciliação chamam esta.
 * Ordem de travas da fase: service_days → checkouts → topups → payments → guardian_students → counter_sales → wallets.
 */
export async function confirmPayment(
  trx: Trx,
  input: { schoolId: string; paymentId: string; paidAt: Date },
): Promise<ConfirmOutcome> {
  const payment = await repo.paymentTarget(trx, input.paymentId);
  if (!payment) throw new Error(`payment ${input.paymentId} not found`);

  if (payment.topupId !== null) {
    // Recarga: travas topups → payments → wallets. Sem corte: paga depois de expirada ou cancelada também credita.
    await topups.lockTopup(trx, payment.topupId);
    if (!(await repo.markPaid(trx, payment.id, input.paidAt))) return "already_processed";
    await topups.creditTopup(trx, {
      schoolId: input.schoolId,
      topupId: payment.topupId,
      paymentId: payment.id,
      amountCents: payment.amountCents,
      paidAt: input.paidAt,
    });
    return "topup_credited";
  }

  // payments_one_target garante checkout_id quando não há topup_id; a FK composta garante o checkout.
  const { checkoutId, serviceDayId } = payment;
  if (checkoutId === null || serviceDayId === null) throw new Error(`payment ${payment.id} has no target`);
  // Checkout: travas service_days → checkouts → payments → wallets, a mesma do cancelamento e do fechamento.
  const day = await catalog.lockServiceDayById(trx, serviceDayId, "share");
  await orders.lockCheckout(trx, checkoutId);
  if (!(await repo.markPaid(trx, payment.id, input.paidAt))) return "already_processed";

  const onTime = day.status === "open" && input.paidAt.getTime() <= day.cutoffAt.getTime();
  if (onTime && (await orders.confirmCheckout(trx, input.schoolId, checkoutId))) return "confirmed";

  await orders.creditLatePayment(trx, { schoolId: input.schoolId, checkoutId, paymentId: payment.id, amountCents: payment.amountCents });
  return "late_credited";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type WebhookOutcome = ConfirmOutcome | "duplicate" | "ignored" | "unknown_charge" | "amount_mismatch";

export async function handleWebhook(input: {
  providerName: string;
  schoolId: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | undefined>;
  rawBody: string;
  log: FastifyBaseLogger;
}): Promise<WebhookOutcome[]> {
  const provider = getProvider(input.providerName);
  if (!UUID.test(input.schoolId)) throw new DomainError("invalid_signature");
  const { schoolId } = input;
  const school = await withTenant(schoolId, (trx) => repo.findSchoolPaymentConfig(trx));
  if (!school?.paymentWebhookSecretRef) throw new DomainError("invalid_signature");
  // Fora de transação: o provedor pode consultar o gateway (CLAUDE.md regra 20).
  const events = await provider.parseWebhook({
    headers: input.headers,
    query: input.query,
    rawBody: input.rawBody,
    secret: getSecret(school.paymentWebhookSecretRef),
    accountRef: school.paymentAccountRef,
  });

  return withTenant(schoolId, async (trx) => {
    const outcomes: WebhookOutcome[] = [];
    for (const event of events) {
      const payment = event.chargeId ? await repo.paymentByCharge(trx, provider.name, event.chargeId) : undefined;
      const recorded = await repo.recordEvent(trx, {
        provider: provider.name,
        providerEventId: event.eventId,
        schoolId,
        paymentId: payment?.id ?? null,
        raw: input.rawBody,
      });
      if (!recorded) {
        outcomes.push("duplicate");
      } else if (event.kind !== "charge_paid") {
        outcomes.push("ignored");
      } else if (!payment) {
        input.log.warn({ event: "payment_webhook_unknown_charge", school_id: schoolId }, "webhook for unknown charge");
        outcomes.push("unknown_charge");
      } else if (payment.amountCents !== event.amountCents) {
        input.log.error({ event: "payment_amount_mismatch", school_id: schoolId, payment_id: payment.id }, "payment amount mismatch");
        outcomes.push("amount_mismatch");
      } else {
        outcomes.push(await confirmPayment(trx, { schoolId, paymentId: payment.id, paidAt: event.paidAt }));
      }
    }
    return outcomes;
  });
}

export async function expirePendingPayment(trx: Trx, checkoutId: string): Promise<void> {
  await repo.expirePending(trx, checkoutId);
}

type PendingCharge = { id: string; provider: string; providerChargeId: string | null; amountCents: number };

/** Consulta cada cobrança no gateway (fora de transação) e confirma as pagas pela confirmPayment. Devolve quantas confirmou. */
async function confirmPaidCharges(schoolId: string, pending: PendingCharge[], accountRef: string | null, log: FastifyBaseLogger): Promise<number> {
  let confirmed = 0;
  for (const p of pending) {
    let charge;
    try {
      charge = await getProvider(p.provider).getCharge(p.providerChargeId!, accountRef);
    } catch {
      log.warn({ event: "reconcile_charge_failed", payment_id: p.id }, "reconciliation lookup failed");
      continue;
    }
    if (charge.status !== "paid" || !charge.paidAt) continue;
    if (charge.amountCents !== p.amountCents) {
      log.error({ event: "payment_amount_mismatch", school_id: schoolId, payment_id: p.id }, "payment amount mismatch");
      continue;
    }
    const paidAt = charge.paidAt;
    const outcome = await withTenant(schoolId, (trx) => confirmPayment(trx, { schoolId, paymentId: p.id, paidAt }));
    if (outcome !== "already_processed") confirmed += 1;
  }
  return confirmed;
}

/** Consulta no gateway as cobranças pendentes do dia e confirma as pagas pela mesma confirmPayment. */
export async function reconcileServiceDay(schoolId: string, serviceDate: string, log: FastifyBaseLogger): Promise<void> {
  const { pending, school } = await withTenant(schoolId, async (trx) => ({
    pending: await repo.pendingChargesForDay(trx, serviceDate),
    school: await repo.schoolPaymentConfig(trx),
  }));
  await confirmPaidCharges(schoolId, pending, school.paymentAccountRef, log);
}

export async function reconcileTopupCharges(schoolId: string, log: FastifyBaseLogger): Promise<number> {
  const { pending, school } = await withTenant(schoolId, async (trx) => ({
    pending: await repo.pendingTopupCharges(trx),
    school: await repo.schoolPaymentConfig(trx),
  }));
  return confirmPaidCharges(schoolId, pending, school.paymentAccountRef, log);
}
