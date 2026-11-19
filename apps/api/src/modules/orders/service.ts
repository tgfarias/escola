import type { CheckoutListResponse, CheckoutStatus, CheckoutView, CreateCheckoutRequest, OrderStatus } from "@app-lanche/contracts";
import type { FastifyBaseLogger } from "fastify";
import { uuidv7 } from "uuidv7";
import { withTenant, type Trx } from "../../db/index";
import { DomainError, isUniqueViolation } from "../../platform/errors";
import { idempotent, requestHash } from "../../platform/idempotency";
import { enqueueEvent } from "../../platform/outbox";
import type { SessionClaims } from "../../platform/session";
import * as catalog from "../catalog/service";
import * as payments from "../payments/service";
import * as wallet from "../wallet/service";
import * as repo from "./repo";

const ONE_ACTIVE_ORDER = "orders_one_active_per_student";

export async function createCheckout(
  session: SessionClaims,
  key: string,
  body: CreateCheckoutRequest,
  log: FastifyBaseLogger,
): Promise<CheckoutView> {
  const schoolId = session.schoolId;
  const hash = requestHash({ route: "POST /api/v1/checkouts", actorId: session.sub, body });
  let checkoutId: string;
  try {
    checkoutId = await withTenant(schoolId, async (trx) => {
      const { response } = await idempotent(trx, { schoolId, key, requestHash: hash }, () => placeCheckout(trx, session, body));
      return response.checkoutId;
    });
  } catch (err) {
    if (isUniqueViolation(err, ONE_ACTIVE_ORDER)) throw new DomainError("order_already_exists");
    throw err;
  }
  await payments.ensureCharge(schoolId, checkoutId, log);
  return getCheckout(session, checkoutId);
}

async function placeCheckout(trx: Trx, session: SessionClaims, body: CreateCheckoutRequest): Promise<{ checkoutId: string }> {
  const schoolId = session.schoolId;
  const guardianId = session.sub;

  const day = await catalog.lockServiceDayByDate(trx, body.serviceDate, "share");
  if (!day) throw new DomainError("not_found");
  if (day.status !== "open" || !day.beforeCutoff) throw new DomainError("cutoff_passed");

  const studentIds = body.orders.map((o) => o.studentId);
  if (new Set(studentIds).size !== studentIds.length) throw new DomainError("invalid_order");
  const students = await repo.guardianActiveStudents(trx, guardianId, studentIds);
  if (students.length !== studentIds.length) throw new DomainError("invalid_order");

  const prices = await catalog.serviceDayPrices(trx, day.id);
  let totalCents = 0;
  for (const order of body.orders) {
    const itemIds = order.items.map((i) => i.menuItemId);
    if (new Set(itemIds).size !== itemIds.length) throw new DomainError("invalid_order");
    for (const item of order.items) {
      const price = prices.get(item.menuItemId);
      if (!price) throw new DomainError("invalid_order");
      totalCents += price.priceCents * item.qty;
    }
  }

  const checkoutId = uuidv7();
  await repo.insertCheckout(trx, { id: checkoutId, schoolId, guardianId, serviceDayId: day.id, totalCents });
  for (const order of body.orders) {
    const orderId = uuidv7();
    await repo.insertOrder(trx, { id: orderId, schoolId, checkoutId, studentId: order.studentId, serviceDate: day.serviceDate });
    await repo.insertOrderItems(
      trx,
      order.items.map((i) => ({
        id: uuidv7(),
        schoolId,
        orderId,
        menuItemId: i.menuItemId,
        qty: i.qty,
        unitPriceCents: prices.get(i.menuItemId)!.priceCents,
      })),
    );
  }

  // A carteira é a última trava da transação (ordem: service_days → … → wallets).
  const { balanceCents } = await wallet.lockBalance(trx, schoolId, guardianId);
  // Carteira negativa (débito do balcão) não reduz nem aumenta o Pix: só saldo positivo é aplicado.
  const appliedCents = Math.max(0, Math.min(balanceCents, totalCents));
  if (appliedCents > 0) {
    await wallet.postEntry(trx, {
      schoolId,
      guardianId,
      kind: "checkout_hold",
      amountCents: -appliedCents,
      sourceType: "checkout",
      sourceId: checkoutId,
    });
    await repo.setWalletApplied(trx, checkoutId, appliedCents);
  }

  if (appliedCents === totalCents) {
    await confirmCheckout(trx, schoolId, checkoutId);
  } else {
    await payments.createPendingPayment(trx, {
      schoolId,
      checkoutId,
      amountCents: totalCents - appliedCents,
      expiresAt: day.cutoffAt,
    });
  }
  return { checkoutId };
}

/**
 * Ordem única de travas: service_days → checkouts → payments → wallets. Quem confirma, cancela, expira ou fecha
 * o dia trava o checkout antes de mexer no pagamento; inverter a ordem causa deadlock com confirmPayment.
 */
export async function lockCheckout(trx: Trx, checkoutId: string): Promise<{ status: CheckoutStatus } | undefined> {
  const row = await repo.lockCheckout(trx, checkoutId);
  return row && { status: row.status as CheckoutStatus };
}

/** `pending_payment → paid` e pedidos `pending → confirmed`. Chamada pelo checkout pago com saldo e por confirmPayment. */
export async function confirmCheckout(trx: Trx, schoolId: string, checkoutId: string): Promise<boolean> {
  const checkout = await repo.transitionCheckout(trx, checkoutId, ["pending_payment"], "paid");
  if (!checkout) return false;
  await repo.transitionOrders(trx, checkoutId, "pending", "confirmed");
  const [header] = await repo.checkoutHeaders(trx, [checkoutId]);
  const guardian = await repo.guardianContact(trx, checkout.guardianId);
  await enqueueEvent(trx, schoolId, {
    type: "payment.confirmed",
    data: {
      guardian_id: checkout.guardianId,
      phone: guardian.phoneE164,
      first_name: guardian.firstName,
      checkout_id: checkoutId,
      service_date: header!.serviceDate,
      students: await repo.studentFirstNames(trx, checkoutId),
      total_cents: checkout.totalCents,
    },
  });
  return true;
}

async function views(trx: Trx, checkoutIds: string[]): Promise<CheckoutView[]> {
  const headers = await repo.checkoutHeaders(trx, checkoutIds);
  const lines = await repo.orderLines(trx, checkoutIds);
  const paymentByCheckout = await payments.paymentViews(trx, checkoutIds);
  return headers.map((h) => {
    const orders = new Map<string, CheckoutView["orders"][number]>();
    for (const l of lines.filter((x) => x.checkoutId === h.id)) {
      const order =
        orders.get(l.orderId) ??
        { id: l.orderId, studentId: l.studentId, studentFirstName: l.firstName, status: l.status as OrderStatus, items: [] };
      order.items.push({ menuItemId: l.menuItemId, name: l.name, qty: l.qty, unitPriceCents: l.unitPriceCents });
      orders.set(l.orderId, order);
    }
    const payment = paymentByCheckout.get(h.id) ?? null;
    return {
      id: h.id,
      serviceDate: h.serviceDate,
      cutoffAt: h.cutoffAt.toISOString(),
      status: h.status as CheckoutStatus,
      totalCents: h.totalCents,
      walletAppliedCents: h.walletAppliedCents,
      amountDueCents: payment?.status === "pending" ? payment.amountCents : 0,
      orders: [...orders.values()],
      payment,
    };
  });
}

export async function getCheckout(session: SessionClaims, checkoutId: string): Promise<CheckoutView> {
  return withTenant(session.schoolId, async (trx) => {
    const [header] = await repo.checkoutHeaders(trx, [checkoutId]);
    if (!header || header.guardianId !== session.sub) throw new DomainError("not_found");
    return (await views(trx, [checkoutId]))[0]!;
  });
}

/** Tenta de novo criar o Pix de um checkout pendente sem cobrança (gateway fora do ar na criação). */
export async function retryCharge(session: SessionClaims, checkoutId: string, log: FastifyBaseLogger): Promise<CheckoutView> {
  await withTenant(session.schoolId, async (trx) => {
    const [header] = await repo.checkoutHeaders(trx, [checkoutId]);
    if (!header || header.guardianId !== session.sub) throw new DomainError("not_found");
  });
  await payments.ensureCharge(session.schoolId, checkoutId, log);
  return getCheckout(session, checkoutId);
}

export async function listCheckouts(session: SessionClaims, serviceDate: string): Promise<CheckoutListResponse> {
  return withTenant(session.schoolId, async (trx) => ({
    checkouts: await views(trx, await repo.guardianCheckoutIds(trx, session.sub, serviceDate)),
  }));
}

export async function creditLatePayment(
  trx: Trx,
  input: { schoolId: string; checkoutId: string; paymentId: string; amountCents: number },
): Promise<void> {
  const checkout = await repo.transitionCheckout(trx, input.checkoutId, ["pending_payment", "expired"], "late_credited");
  if (!checkout) throw new Error(`checkout ${input.checkoutId} cannot be late-credited`);
  await repo.transitionOrders(trx, input.checkoutId, "pending", "expired_late");

  const base = { schoolId: input.schoolId, guardianId: checkout.guardianId };
  let { balanceCents } = await wallet.postEntry(trx, {
    ...base,
    kind: "late_payment_credit",
    amountCents: input.amountCents,
    sourceType: "payment",
    sourceId: input.paymentId,
  });
  if (checkout.walletAppliedCents > 0) {
    ({ balanceCents } = await wallet.postEntry(trx, {
      ...base,
      kind: "hold_release",
      amountCents: checkout.walletAppliedCents,
      sourceType: "checkout",
      sourceId: input.checkoutId,
    }));
  }

  const guardian = await repo.guardianContact(trx, checkout.guardianId);
  await enqueueEvent(trx, input.schoolId, {
    type: "payment.late_credited",
    data: {
      guardian_id: checkout.guardianId,
      phone: guardian.phoneE164,
      first_name: guardian.firstName,
      amount_cents: input.amountCents,
      wallet_balance_cents: balanceCents,
    },
  });
}

export async function expireCheckout(trx: Trx, schoolId: string, checkoutId: string): Promise<boolean> {
  const checkout = await repo.transitionCheckout(trx, checkoutId, ["pending_payment"], "expired");
  if (!checkout) return false;
  await repo.transitionOrders(trx, checkoutId, "pending", "expired");
  await payments.expirePendingPayment(trx, checkoutId);
  if (checkout.walletAppliedCents > 0) {
    await wallet.postEntry(trx, {
      schoolId,
      guardianId: checkout.guardianId,
      kind: "hold_release",
      amountCents: checkout.walletAppliedCents,
      sourceType: "checkout",
      sourceId: checkoutId,
    });
  }
  return true;
}

export async function cancelCheckout(session: SessionClaims, checkoutId: string): Promise<CheckoutView> {
  const schoolId = session.schoolId;
  await withTenant(schoolId, async (trx) => {
    const [first] = await repo.checkoutHeaders(trx, [checkoutId]);
    if (!first || first.guardianId !== session.sub) throw new DomainError("not_found");
    // Travas na ordem service_days → checkouts → payments → wallets.
    const day = await catalog.lockServiceDayById(trx, first.serviceDayId, "share");
    // Relido sob a trava: um webhook pode ter confirmado o pagamento entre as duas leituras.
    const { status } = (await lockCheckout(trx, checkoutId))!;
    if (status === "cancelled" || status === "expired") return;
    if (status === "late_credited") throw new DomainError("checkout_not_cancellable");
    if (day.status !== "open" || !day.beforeCutoff) throw new DomainError("cutoff_passed");
    if (status === "paid") {
      const cancelled = await repo.transitionCheckout(trx, checkoutId, ["paid"], "cancelled");
      if (!cancelled) return;
      await repo.transitionOrders(trx, checkoutId, "confirmed", "cancelled");
      await wallet.postEntry(trx, {
        schoolId,
        guardianId: cancelled.guardianId,
        kind: "cancel_credit",
        amountCents: cancelled.totalCents,
        sourceType: "checkout",
        sourceId: checkoutId,
      });
      return;
    }
    await expireCheckout(trx, schoolId, checkoutId);
  });
  return getCheckout(session, checkoutId);
}

export async function expirePendingCheckouts(trx: Trx, schoolId: string, serviceDayId: string): Promise<number> {
  let expired = 0;
  for (const id of await repo.checkoutIdsByStatus(trx, serviceDayId, "pending_payment")) {
    if (await expireCheckout(trx, schoolId, id)) expired += 1;
  }
  return expired;
}

export async function countLateCredited(trx: Trx, serviceDayId: string): Promise<number> {
  return (await repo.checkoutIdsByStatus(trx, serviceDayId, "late_credited")).length;
}
