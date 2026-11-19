import type {
  CounterRosterResponse,
  CounterSaleResult,
  CounterVoidResult,
  KdsCounterSalesRequest,
  KdsCounterVoidsRequest,
  KdsEventsResponse,
  StaffCounterSaleRequest,
} from "@app-lanche/contracts";
import { uuidv7 } from "uuidv7";
import { withTenant, type Trx } from "../../db/index";
import { audit } from "../../platform/audit";
import { DomainError } from "../../platform/errors";
import { idempotent, requestHash } from "../../platform/idempotency";
import type { SessionClaims } from "../../platform/session";
import * as wallet from "../wallet/service";
import * as repo from "./repo";

export type SaleActor = { source: "kitchen"; deviceId: string } | { source: "staff"; staffUserId: string };
/** record: o tablet offline sempre grava (spec F5B); refuse: secretaria sem confirmação; allow: secretaria confirmou. */
export type LimitPolicy = "record" | "refuse" | "allow";
export type SaleInput = { id: string; studentId: string; items: { menuItemId: string; qty: number }[]; occurredAt: string | null };
export type SaleOutcome =
  | { status: "applied"; totalCents: number; balanceCents: number; overLimit: boolean }
  | { status: "duplicate" }
  | { status: "rejected" };
export type VoidOutcome = { status: "voided" | "already"; balanceCents: number } | { status: "rejected" };

/**
 * Aplica lançamentos de balcão na carteira do responsável financeiro. Id já gravado = `duplicate` (aceito sem efeito);
 * aluno ou item inexistente/inativo, item repetido ou aluno sem financeiro = `rejected`. As carteiras do lote são
 * travadas juntas em ordem de guardian_id. Lançamento não passa por corte nem romaneio (é venda já entregue).
 */
export async function applySales(trx: Trx, schoolId: string, actor: SaleActor, sales: SaleInput[], policy: LimitPolicy): Promise<Map<string, SaleOutcome>> {
  const out = new Map<string, SaleOutcome>();
  const existing = await repo.existingSaleIds(trx, sales.map((s) => s.id));
  const seen = new Set<string>();
  const fresh: SaleInput[] = [];
  for (const s of sales) {
    if (existing.has(s.id) || seen.has(s.id)) out.set(s.id, { status: "duplicate" });
    else fresh.push(s);
    seen.add(s.id);
  }
  const students = await repo.activeStudentIds(trx, [...new Set(fresh.map((s) => s.studentId))]);
  const prices = await repo.activeItemPrices(trx, [...new Set(fresh.flatMap((s) => s.items.map((i) => i.menuItemId)))]);
  const valid = fresh.filter((s) => {
    const itemIds = s.items.map((i) => i.menuItemId);
    return students.has(s.studentId) && itemIds.length > 0 && new Set(itemIds).size === itemIds.length && itemIds.every((id) => prices.has(id));
  });
  const financial = await repo.lockFinancialGuardians(trx, [...new Set(valid.map((s) => s.studentId))]);
  await wallet.lockBalances(trx, schoolId, [...financial.values()]);
  const limit = await repo.debtLimit(trx);

  for (const s of fresh) {
    const guardianId = financial.get(s.studentId);
    if (!valid.includes(s) || !guardianId) {
      out.set(s.id, { status: "rejected" });
      continue;
    }
    const totalCents = s.items.reduce((sum, i) => sum + prices.get(i.menuItemId)! * i.qty, 0);
    const entryId = uuidv7();
    const posted = await wallet.postEntry(trx, {
      id: entryId,
      schoolId,
      guardianId,
      kind: "counter_charge",
      amountCents: -totalCents,
      sourceType: "counter_sale",
      sourceId: s.id,
      minBalanceCents: policy === "refuse" ? -limit : null,
    });
    if (!posted.posted) {
      out.set(s.id, { status: "duplicate" }); // outro envio do mesmo id ganhou a corrida
      continue;
    }
    const overLimit = posted.balanceCents < -limit;
    await repo.insertSale(trx, {
      id: s.id,
      schoolId,
      studentId: s.studentId,
      guardianId,
      source: actor.source,
      deviceId: actor.source === "kitchen" ? actor.deviceId : null,
      staffUserId: actor.source === "staff" ? actor.staffUserId : null,
      occurredAt: s.occurredAt,
      totalCents,
      overLimit,
      walletEntryId: entryId,
    });
    await repo.insertSaleItems(
      trx,
      s.items.map((i) => ({ schoolId, saleId: s.id, menuItemId: i.menuItemId, qty: i.qty, unitPriceCents: prices.get(i.menuItemId)! })),
    );
    await wallet.noticeDebtStart(trx, schoolId, guardianId, posted.previousBalanceCents, posted.balanceCents);
    out.set(s.id, { status: "applied", totalCents, balanceCents: posted.balanceCents, overLimit });
  }
  return out;
}

/**
 * Estorna lançamentos: `counter_void` positivo na carteira gravada no lançamento. O tablet só estorna lançamentos do
 * tablet (`source = 'kitchen'`) do mesmo dia no fuso da escola. Já estornado = `already` (aceito sem efeito).
 */
export async function voidSales(
  trx: Trx,
  schoolId: string,
  actor: SaleActor,
  voids: { saleId: string; occurredAt?: string }[],
): Promise<Map<string, VoidOutcome>> {
  const out = new Map<string, VoidOutcome>();
  const sales = await repo.lockSales(trx, [...new Set(voids.map((v) => v.saleId))]);
  await wallet.lockBalances(trx, schoolId, [...sales.values()].map((s) => s.guardianId));
  for (const v of voids) {
    if (out.has(v.saleId)) continue;
    const sale = sales.get(v.saleId);
    if (!sale) {
      out.set(v.saleId, { status: "rejected" });
      continue;
    }
    if (sale.voidedAt) {
      out.set(v.saleId, { status: "already", balanceCents: await wallet.balanceOf(trx, sale.guardianId) });
      continue;
    }
    if (actor.source === "kitchen" && (sale.source !== "kitchen" || !v.occurredAt || !(await repo.sameSchoolDay(trx, sale.occurredAt, v.occurredAt)))) {
      out.set(v.saleId, { status: "rejected" });
      continue;
    }
    const entryId = uuidv7();
    const posted = await wallet.postEntry(trx, {
      id: entryId,
      schoolId,
      guardianId: sale.guardianId,
      kind: "counter_void",
      amountCents: sale.totalCents,
      sourceType: "counter_sale",
      sourceId: v.saleId,
    });
    if (posted.posted) await repo.markVoided(trx, v.saleId, entryId);
    await audit(trx, {
      schoolId,
      actorKind: actor.source === "kitchen" ? "kitchen" : "staff",
      actorId: actor.source === "kitchen" ? actor.deviceId : actor.staffUserId,
      action: "counter.void",
      detail: { sale_id: v.saleId },
    });
    out.set(v.saleId, { status: "voided", balanceCents: posted.balanceCents });
  }
  return out;
}

function split(allIds: string[], rejected: (id: string) => boolean): KdsEventsResponse {
  const ids = [...new Set(allIds)];
  return { accepted: ids.filter((id) => !rejected(id)), rejected: ids.filter(rejected) };
}

export async function recordKitchenSales(schoolId: string, deviceId: string, body: KdsCounterSalesRequest): Promise<KdsEventsResponse> {
  const outcomes = await withTenant(schoolId, (trx) =>
    applySales(trx, schoolId, { source: "kitchen", deviceId }, body.sales.map((s) => ({ ...s, occurredAt: s.occurredAt })), "record"),
  );
  return split(body.sales.map((s) => s.id), (id) => outcomes.get(id)?.status === "rejected");
}

export async function recordKitchenVoids(schoolId: string, deviceId: string, body: KdsCounterVoidsRequest): Promise<KdsEventsResponse> {
  const outcomes = await withTenant(schoolId, (trx) => voidSales(trx, schoolId, { source: "kitchen", deviceId }, body.voids));
  return split(body.voids.map((v) => v.saleId), (id) => outcomes.get(id)?.status === "rejected");
}

export async function createStaffSale(session: SessionClaims, key: string, body: StaffCounterSaleRequest): Promise<CounterSaleResult> {
  const schoolId = session.schoolId;
  const hash = requestHash({ route: "POST /api/admin/v1/counter-sales", actorId: session.sub, body });
  return withTenant(schoolId, async (trx) => {
    const { response } = await idempotent(trx, { schoolId, key, requestHash: hash }, async () => {
      const saleId = uuidv7();
      const outcomes = await applySales(
        trx,
        schoolId,
        { source: "staff", staffUserId: session.sub },
        [{ id: saleId, studentId: body.studentId, items: body.items, occurredAt: null }],
        body.allowOverLimit ? "allow" : "refuse",
      );
      const outcome = outcomes.get(saleId)!;
      if (outcome.status !== "applied") throw new DomainError("invalid_order");
      await audit(trx, { schoolId, actorKind: "staff", actorId: session.sub, action: "counter.sale", detail: { sale_id: saleId, over_limit: outcome.overLimit } });
      return { saleId, totalCents: outcome.totalCents, balanceCents: outcome.balanceCents, overLimit: outcome.overLimit };
    });
    return response;
  });
}

export async function voidStaffSale(session: SessionClaims, saleId: string): Promise<CounterVoidResult> {
  const outcome = await withTenant(session.schoolId, async (trx) =>
    (await voidSales(trx, session.schoolId, { source: "staff", staffUserId: session.sub }, [{ saleId }])).get(saleId)!,
  );
  if (outcome.status === "rejected") throw new DomainError("not_found");
  return { saleId, balanceCents: outcome.balanceCents };
}

export async function roster(schoolId: string): Promise<CounterRosterResponse> {
  return withTenant(schoolId, async (trx) => ({
    debtLimitCents: await repo.debtLimit(trx),
    items: await repo.rosterItems(trx),
    students: (await repo.rosterStudents(trx)).map((r) => ({
      id: r.id,
      firstName: r.firstName,
      className: r.className,
      restrictions: r.restrictions,
      guardian: r.guardianId ? { id: r.guardianId, firstName: r.guardianFirstName!, balanceCents: r.balanceCents } : null,
    })),
  }));
}
