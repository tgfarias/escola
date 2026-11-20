import type { KdsManifestResponse, ManifestContent, ManifestResponse, ServiceDayCloseResponse, Shift } from "@app-lanche/contracts";
import type { FastifyBaseLogger } from "fastify";
import { withTenant, type Trx } from "../../db/index";
import { DomainError } from "../../platform/errors";
import { enqueueEvent } from "../../platform/outbox";
import * as catalog from "../catalog/service";
import type { LockedShift } from "../catalog/service";
import * as orders from "../orders/service";
import * as payments from "../payments/service";
import * as repo from "./repo";

type Line = Awaited<ReturnType<typeof repo.manifestLines>>[number];

export function buildManifest(lines: Line[], lateCredits: number): ManifestContent {
  const byClass = new Map<string, Map<string, ManifestContent["by_class"][number]["orders"][number]>>();
  const byItem = new Map<string, number>();
  for (const l of lines) {
    const cls = byClass.get(l.className) ?? new Map();
    byClass.set(l.className, cls);
    const order = cls.get(l.orderId) ?? { order_id: l.orderId, student: l.firstName, items: [], restrictions: l.restrictions };
    order.items.push(l.qty > 1 ? `${l.qty}x ${l.itemName}` : l.itemName);
    cls.set(l.orderId, order);
    byItem.set(l.itemName, (byItem.get(l.itemName) ?? 0) + l.qty);
  }
  const by_class = [...byClass.entries()].map(([name, ordersById]) => ({ class: name, orders: [...ordersById.values()] }));
  return {
    totals: {
      orders: by_class.reduce((n, c) => n + c.orders.length, 0),
      by_item: [...byItem.entries()]
        .map(([item, qty]) => ({ item, qty }))
        .sort((a, b) => b.qty - a.qty || a.item.localeCompare(b.item)),
    },
    by_class,
    late_credits: lateCredits,
  };
}

async function manifestOf(trx: Trx, serviceDayId: string, turn: LockedShift, kitchenPhone: string | null): Promise<ManifestResponse> {
  const manifest = await repo.readManifest(trx, serviceDayId, turn.shift);
  return {
    shift: turn.shift,
    status: turn.status as "closed" | "finished",
    closed_at: turn.closedAt!.toISOString(),
    manifest_version: manifest.version,
    kitchen_phone: kitchenPhone,
    ...(JSON.parse(manifest.content) as ManifestContent),
  };
}

/** Fecha um turno já travado (FOR UPDATE, com o dia FOR UPDATE antes): expira os pendentes, congela o romaneio e avisa. */
async function closeLockedShift(trx: Trx, schoolId: string, serviceDate: string, serviceDayId: string, turn: LockedShift): Promise<void> {
  await orders.expirePendingCheckouts(trx, schoolId, serviceDayId, turn.shift);
  const content = buildManifest(
    await repo.manifestLines(trx, serviceDayId, turn.shift),
    await orders.countLateCredited(trx, serviceDayId, turn.shift),
  );
  await repo.insertManifest(trx, { schoolId, serviceDayId, shift: turn.shift, content: JSON.stringify(content) });
  await catalog.markShiftClosed(trx, turn.id);
  await catalog.closeDayIfNoOpenShift(trx, serviceDayId);
  await enqueueEvent(trx, schoolId, {
    type: "service_day.closed",
    data: { service_date: serviceDate, shift: turn.shift, orders: content.totals.orders, late_credits: content.late_credits },
  });
}

export async function closeShift(
  schoolId: string,
  serviceDate: string,
  shift: Shift,
  options: { log: FastifyBaseLogger; reconcile?: boolean },
): Promise<ManifestResponse> {
  if (options.reconcile !== false) await payments.reconcileServiceDay(schoolId, serviceDate, options.log);
  return withTenant(schoolId, async (trx) => {
    // Travas: service_days FOR UPDATE → service_day_shifts FOR UPDATE (regra 16) → checkouts → payments → wallets.
    const day = await catalog.lockServiceDayByDate(trx, serviceDate, "update");
    if (!day) throw new DomainError("not_found");
    const turn = await catalog.lockShift(trx, day.id, shift, "update");
    if (!turn) throw new DomainError("not_found");
    if (turn.status === "open") {
      // Fechar antes do corte transformaria pagamentos no prazo em crédito atrasado.
      if (turn.beforeCutoff) throw new DomainError("service_day_open");
      await closeLockedShift(trx, schoolId, serviceDate, day.id, turn);
    }
    const after = (await catalog.listShifts(trx, day.id)).find((s) => s.shift === shift)!;
    return manifestOf(trx, day.id, after, await repo.kitchenPhone(trx));
  });
}

/**
 * Fecha os turnos prontos do dia. `frozen` (n8n e segurança): passou do congelamento. `past_cutoff` (equipe): passou do corte.
 * Nenhum turno fechado no fim → service_day_open.
 */
export async function closeServiceDay(
  schoolId: string,
  serviceDate: string,
  options: { log: FastifyBaseLogger; reconcile?: boolean; due?: "frozen" | "past_cutoff" },
): Promise<ServiceDayCloseResponse> {
  if (options.reconcile !== false) await payments.reconcileServiceDay(schoolId, serviceDate, options.log);
  const due = options.due ?? "past_cutoff";
  return withTenant(schoolId, async (trx) => {
    const day = await catalog.lockServiceDayByDate(trx, serviceDate, "update");
    if (!day) throw new DomainError("not_found");
    for (const { shift } of await catalog.listShifts(trx, day.id)) {
      const turn = (await catalog.lockShift(trx, day.id, shift, "update"))!; // ordem fixa: matutino, vespertino
      const ready = due === "frozen" ? turn.frozen : !turn.beforeCutoff;
      if (turn.status === "open" && ready) await closeLockedShift(trx, schoolId, serviceDate, day.id, turn);
    }
    const done = (await catalog.listShifts(trx, day.id)).filter((s) => s.status !== "open");
    if (done.length === 0) throw new DomainError("service_day_open");
    const phone = await repo.kitchenPhone(trx);
    const shifts: ManifestResponse[] = [];
    for (const s of done) shifts.push(await manifestOf(trx, day.id, s, phone));
    const status = (await catalog.lockServiceDayById(trx, day.id, "share")).status;
    return { service_date: serviceDate, status, shifts };
  });
}

export async function getManifest(schoolId: string, serviceDate: string, shift: Shift): Promise<ManifestResponse> {
  return withTenant(schoolId, async (trx) => {
    const day = await catalog.lockServiceDayByDate(trx, serviceDate, "share");
    if (!day) throw new DomainError("not_found");
    const turn = await catalog.lockShift(trx, day.id, shift, "share");
    if (!turn) throw new DomainError("not_found");
    if (turn.status === "open") throw new DomainError("service_day_open");
    return manifestOf(trx, day.id, turn, await repo.kitchenPhone(trx));
  });
}

/** KDS: romaneio congelado ou, com o dia aberto, a prévia dos pedidos já confirmados (por ora, só a manhã; Task 7). */
export async function kdsManifest(schoolId: string, serviceDate: string): Promise<KdsManifestResponse> {
  return withTenant(schoolId, async (trx) => {
    const day = await catalog.lockServiceDayByDate(trx, serviceDate, "share");
    if (!day) throw new DomainError("not_found");
    if (day.status === "closed") {
      const manifest = await repo.readManifest(trx, day.id, "matutino");
      return { serviceDate, status: "closed", manifestVersion: manifest.version, content: JSON.parse(manifest.content) as ManifestContent };
    }
    const content = buildManifest(await repo.manifestLines(trx, day.id, "matutino"), await orders.countLateCredited(trx, day.id, "matutino"));
    return { serviceDate, status: "open", manifestVersion: null, content };
  });
}

export type DueAction = {
  action: "send_reminders" | "close_service_day" | "send_debt_notices" | "reconcile_topups" | "finish_shifts";
  schoolId: string;
  serviceDate: string;
  overdue: boolean;
};

export async function listDueActions(): Promise<DueAction[]> {
  return repo.listDueActions();
}

/** Fecha dias que passaram 10 min do corte sem o n8n fechar (spec 5.6). `schoolIds` restringe (testes). */
export async function safetyClose(opts: { log: FastifyBaseLogger; schoolIds?: string[] }): Promise<{ closed: number; failed: number }> {
  const due = (await listDueActions()).filter(
    (d) => d.action === "close_service_day" && d.overdue && (!opts.schoolIds || opts.schoolIds.includes(d.schoolId)),
  );
  let closed = 0;
  let failed = 0;
  for (const d of due) {
    try {
      await closeServiceDay(d.schoolId, d.serviceDate, { log: opts.log, due: "frozen" });
      closed += 1;
    } catch (err) {
      failed += 1;
      opts.log.error({ school_id: d.schoolId, service_date: d.serviceDate, err_name: err instanceof Error ? err.name : "UnknownError" }, "safety close failed");
    }
  }
  return { closed, failed };
}
