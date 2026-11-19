import type { WalletAdjustmentRequest, WalletAdjustmentResponse, WalletEntryKind as Kind, WalletResponse } from "@app-lanche/contracts";
import { uuidv7 } from "uuidv7";
import { withTenant, type Trx } from "../../db/index";
import { audit } from "../../platform/audit";
import { DomainError } from "../../platform/errors";
import { idempotent, requestHash } from "../../platform/idempotency";
import { enqueueEvent } from "../../platform/outbox";
import type { SessionClaims } from "../../platform/session";
import * as repo from "./repo";

export type WalletEntryKind = Kind;
export type WalletSourceType = "checkout" | "payment" | "adjustment" | "counter_sale" | "topup";
export type PostedEntry = { posted: boolean; entryId: string | null; previousBalanceCents: number; balanceCents: number };

/** Cria a carteira se faltar e trava a linha (CLAUDE.md regra 9). */
export async function lockBalance(
  trx: Trx,
  schoolId: string,
  guardianId: string,
): Promise<{ walletId: string; balanceCents: number }> {
  await repo.ensureWallet(trx, schoolId, guardianId);
  const wallet = await repo.lockWallet(trx, guardianId);
  return { walletId: wallet.id, balanceCents: wallet.balanceCents };
}

/** Cria as carteiras que faltam e trava todas, em ordem de guardian_id (lotes do balcão). */
export async function lockBalances(trx: Trx, schoolId: string, guardianIds: string[]): Promise<void> {
  const ids = [...new Set(guardianIds)].sort();
  for (const id of ids) await repo.ensureWallet(trx, schoolId, id);
  await repo.lockWallets(trx, ids);
}

/**
 * Lança uma entrada no ledger. A unicidade (origem, tipo) torna a chamada idempotente: se a entrada já existe,
 * nada muda e `posted` é false.
 *
 * Piso (`minBalanceCents`, padrão 0; null = sem piso): só um débito que deixaria o saldo abaixo dele é recusado.
 * Crédito sempre entra, mesmo com a carteira negativa (spec F5B).
 */
export async function postEntry(
  trx: Trx,
  entry: {
    schoolId: string;
    guardianId: string;
    kind: WalletEntryKind;
    amountCents: number;
    sourceType: WalletSourceType;
    sourceId: string;
    note?: string;
    id?: string;
    minBalanceCents?: number | null;
  },
): Promise<PostedEntry> {
  if (!Number.isSafeInteger(entry.amountCents) || entry.amountCents === 0) throw new Error("invalid wallet amount");
  const wallet = await lockBalance(trx, entry.schoolId, entry.guardianId);
  const entryId = entry.id ?? uuidv7();
  const posted = await repo.insertEntry(trx, {
    id: entryId,
    schoolId: entry.schoolId,
    walletId: wallet.walletId,
    kind: entry.kind,
    amountCents: entry.amountCents,
    sourceType: entry.sourceType,
    sourceId: entry.sourceId,
    note: entry.note ?? null,
  });
  // Repetição: a entrada já existe e o saldo já a contém.
  if (!posted) return { posted: false, entryId: null, previousBalanceCents: wallet.balanceCents, balanceCents: wallet.balanceCents };
  const balanceCents = wallet.balanceCents + entry.amountCents;
  const floor = entry.minBalanceCents === undefined ? 0 : entry.minBalanceCents;
  // Lançar aqui desfaz a transação inteira, inclusive a entrada recém-inserida.
  if (entry.amountCents < 0 && floor !== null && balanceCents < floor) throw new DomainError("insufficient_balance");
  await repo.setBalance(trx, wallet.walletId, balanceCents);
  return { posted: true, entryId, previousBalanceCents: wallet.balanceCents, balanceCents };
}

/** Grava o aviso de débito (ou o pedido de pagamento da secretaria) para o responsável. Só primeiro nome (regra 29). */
export async function enqueueDebtNotice(
  trx: Trx,
  schoolId: string,
  guardianId: string,
  amountDueCents: number,
  type: "wallet.debt_notice" | "wallet.payment_requested" = "wallet.debt_notice",
): Promise<void> {
  const guardian = await repo.guardianContact(trx, guardianId);
  await enqueueEvent(trx, schoolId, {
    type,
    data: { guardian_id: guardianId, phone: guardian.phoneE164, first_name: guardian.firstName, amount_due_cents: amountDueCents },
  });
}

/** Saldo passou de >= 0 para < 0: marca o aviso (a agenda repete a cada 3 dias) e grava wallet.debt_notice. */
export async function noticeDebtStart(
  trx: Trx,
  schoolId: string,
  guardianId: string,
  previousBalanceCents: number,
  balanceCents: number,
): Promise<void> {
  if (!(previousBalanceCents >= 0 && balanceCents < 0)) return;
  await repo.markDebtNotice(trx, guardianId);
  await enqueueDebtNotice(trx, schoolId, guardianId, -balanceCents);
}

export async function balanceOf(trx: Trx, guardianId: string): Promise<number> {
  return repo.readBalance(trx, guardianId);
}

export async function getWallet(session: SessionClaims): Promise<WalletResponse> {
  return withTenant(session.schoolId, async (trx) => ({
    balanceCents: await repo.readBalance(trx, session.sub),
    entries: (await repo.listEntries(trx, session.sub, 50)).map((e) => ({
      id: e.id,
      kind: e.kind as WalletEntryKind,
      amountCents: e.amountCents,
      createdAt: e.createdAt.toISOString(),
    })),
  }));
}

export async function adjustBalance(
  session: SessionClaims,
  key: string,
  guardianId: string,
  body: WalletAdjustmentRequest,
): Promise<WalletAdjustmentResponse> {
  const schoolId = session.schoolId;
  const hash = requestHash({ route: `POST /api/admin/v1/guardians/${guardianId}/wallet/adjustments`, actorId: session.sub, body });
  return withTenant(schoolId, async (trx) => {
    const { response } = await idempotent(trx, { schoolId, key, requestHash: hash }, async () => {
      if (!(await repo.guardianExists(trx, guardianId))) throw new DomainError("not_found");
      const { balanceCents } = await postEntry(trx, {
        schoolId,
        guardianId,
        kind: "manual_adjustment",
        amountCents: body.amountCents,
        sourceType: "adjustment",
        sourceId: uuidv7(),
        note: body.reason,
      });
      await audit(trx, {
        schoolId,
        actorKind: "staff",
        actorId: session.sub,
        action: "wallet.adjust",
        detail: { guardian_id: guardianId, amount_cents: body.amountCents },
      });
      return { balanceCents };
    });
    return response;
  });
}
