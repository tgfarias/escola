import type { WalletAdjustmentRequest, WalletAdjustmentResponse, WalletEntryKind as Kind, WalletResponse } from "@app-lanche/contracts";
import { uuidv7 } from "uuidv7";
import { withTenant, type Trx } from "../../db/index";
import { audit } from "../../platform/audit";
import { DomainError } from "../../platform/errors";
import { idempotent, requestHash } from "../../platform/idempotency";
import type { SessionClaims } from "../../platform/session";
import * as repo from "./repo";

export type WalletEntryKind = Kind;
export type WalletSourceType = "checkout" | "payment" | "adjustment";

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

/**
 * Lança uma entrada no ledger. A unicidade (origem, tipo) torna a chamada idempotente: se a entrada já existe,
 * nada muda e `posted` é false.
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
  },
): Promise<{ posted: boolean; balanceCents: number }> {
  if (!Number.isSafeInteger(entry.amountCents) || entry.amountCents === 0) throw new Error("invalid wallet amount");
  const wallet = await lockBalance(trx, entry.schoolId, entry.guardianId);
  const posted = await repo.insertEntry(trx, {
    schoolId: entry.schoolId,
    walletId: wallet.walletId,
    kind: entry.kind,
    amountCents: entry.amountCents,
    sourceType: entry.sourceType,
    sourceId: entry.sourceId,
    note: entry.note ?? null,
  });
  // Repetição: a entrada já existe e o saldo já a contém.
  if (!posted) return { posted: false, balanceCents: wallet.balanceCents };
  const balanceCents = wallet.balanceCents + entry.amountCents;
  // Lançar aqui desfaz a transação inteira, inclusive a entrada recém-inserida.
  if (balanceCents < 0) throw new DomainError("insufficient_balance");
  await repo.setBalance(trx, wallet.walletId, balanceCents);
  return { posted: true, balanceCents };
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
