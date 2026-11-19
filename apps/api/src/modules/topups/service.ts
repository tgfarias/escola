import type { GuardianTopupRequest, StaffTopupRequest, TopupStatus, TopupView } from "@app-lanche/contracts";
import type { FastifyBaseLogger } from "fastify";
import { uuidv7 } from "uuidv7";
import { withTenant, type Trx } from "../../db/index";
import { audit } from "../../platform/audit";
import { DomainError } from "../../platform/errors";
import { idempotent, requestHash } from "../../platform/idempotency";
import type { SessionClaims } from "../../platform/session";
import * as payments from "../payments/service";
import * as wallet from "../wallet/service";
import * as repo from "./repo";

const MAX_TOPUP_CENTS = 1_000_000;

async function placeTopup(trx: Trx, schoolId: string, guardianId: string, amountCents: number, requestedBy: "guardian" | "staff"): Promise<string> {
  // Travas topups → payments: cancela as pendentes e expira as cobranças delas.
  for (const id of await repo.cancelPendingTopups(trx, guardianId)) await payments.expireTopupPayment(trx, id);
  const id = uuidv7();
  await repo.insertTopup(trx, { id, schoolId, guardianId, amountCents, requestedBy });
  await payments.createTopupPayment(trx, { schoolId, topupId: id, amountCents });
  return id;
}

async function view(schoolId: string, topupId: string, allowed: (guardianId: string) => boolean): Promise<TopupView> {
  return withTenant(schoolId, async (trx) => {
    const t = await repo.topupHeader(trx, topupId);
    if (!t || !allowed(t.guardianId)) throw new DomainError("not_found");
    return {
      id: t.id,
      status: t.status as TopupStatus,
      amountCents: t.amountCents,
      createdAt: t.createdAt.toISOString(),
      paidAt: t.paidAt ? t.paidAt.toISOString() : null,
      balanceCents: await wallet.balanceOf(trx, t.guardianId),
      payment: (await payments.topupPaymentViews(trx, [t.id])).get(t.id) ?? null,
    };
  });
}

export async function createGuardianTopup(session: SessionClaims, key: string, body: GuardianTopupRequest, log: FastifyBaseLogger): Promise<TopupView> {
  const schoolId = session.schoolId;
  const hash = requestHash({ route: "POST /api/v1/topups", actorId: session.sub, body });
  const topupId = await withTenant(schoolId, async (trx) => {
    const { response } = await idempotent(trx, { schoolId, key, requestHash: hash }, async () => {
      let amountCents: number;
      if (body.purpose === "debt") {
        const balance = await wallet.balanceOf(trx, session.sub);
        if (balance >= 0) throw new DomainError("wallet_no_debt");
        amountCents = Math.min(-balance, MAX_TOPUP_CENTS);
      } else {
        amountCents = body.amountCents;
      }
      return { topupId: await placeTopup(trx, schoolId, session.sub, amountCents, "guardian") };
    });
    return response.topupId;
  });
  await payments.ensureCharge(schoolId, { topupId }, log);
  return view(schoolId, topupId, (g) => g === session.sub);
}

export async function getGuardianTopup(session: SessionClaims, topupId: string): Promise<TopupView> {
  return view(session.schoolId, topupId, (g) => g === session.sub);
}

export async function retryGuardianCharge(session: SessionClaims, topupId: string, log: FastifyBaseLogger): Promise<TopupView> {
  await getGuardianTopup(session, topupId);
  await payments.ensureCharge(session.schoolId, { topupId }, log);
  return getGuardianTopup(session, topupId);
}

export async function createStaffTopup(session: SessionClaims, key: string, guardianId: string, body: StaffTopupRequest, log: FastifyBaseLogger): Promise<TopupView> {
  const schoolId = session.schoolId;
  const hash = requestHash({ route: `POST /api/admin/v1/guardians/${guardianId}/topups`, actorId: session.sub, body });
  const topupId = await withTenant(schoolId, async (trx) => {
    const { response } = await idempotent(trx, { schoolId, key, requestHash: hash }, async () => {
      if (!(await repo.guardianExists(trx, guardianId))) throw new DomainError("not_found");
      const id = await placeTopup(trx, schoolId, guardianId, body.amountCents, "staff");
      await audit(trx, { schoolId, actorKind: "staff", actorId: session.sub, action: "wallet.topup_requested", detail: { guardian_id: guardianId, topup_id: id } });
      return { topupId: id };
    });
    return response.topupId;
  });
  await payments.ensureCharge(schoolId, { topupId }, log);
  return view(schoolId, topupId, () => true);
}

export async function getStaffTopup(session: SessionClaims, topupId: string): Promise<TopupView> {
  return view(session.schoolId, topupId, () => true);
}

export async function retryStaffCharge(session: SessionClaims, topupId: string, log: FastifyBaseLogger): Promise<TopupView> {
  await getStaffTopup(session, topupId);
  await payments.ensureCharge(session.schoolId, { topupId }, log);
  return getStaffTopup(session, topupId);
}

/** Primeira trava do ramo de recarga da confirmPayment (topups → payments → wallets). */
export async function lockTopup(trx: Trx, topupId: string): Promise<void> {
  await repo.lockTopup(trx, topupId);
}

/** Chamado só pela confirmPayment, depois de o pagamento passar a `paid`. */
export async function creditTopup(
  trx: Trx,
  input: { schoolId: string; topupId: string; paymentId: string; amountCents: number; paidAt: Date },
): Promise<void> {
  const paid = await repo.markTopupPaid(trx, input.topupId, input.paidAt);
  if (!paid) return;
  const { balanceCents } = await wallet.postEntry(trx, {
    schoolId: input.schoolId,
    guardianId: paid.guardianId,
    kind: "topup_credit",
    amountCents: input.amountCents,
    sourceType: "topup",
    sourceId: input.topupId,
    // Crédito nunca é recusado pelo piso; não cruza para negativo, então não há aviso de débito.
    minBalanceCents: null,
  });
  await wallet.enqueueTopupConfirmed(trx, input.schoolId, paid.guardianId, input.amountCents, balanceCents);
}

/** Expira a recarga cujo Pix venceu (travas topups → payments). */
export async function expireTopup(trx: Trx, topupId: string): Promise<boolean> {
  await repo.lockTopup(trx, topupId);
  if (!(await repo.expireTopup(trx, topupId))) return false;
  await payments.expireTopupPayment(trx, topupId);
  return true;
}
