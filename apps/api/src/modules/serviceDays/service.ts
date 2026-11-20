import type { KdsManifestResponse, ManifestContent, ManifestResponse } from "@app-lanche/contracts";
import type { FastifyBaseLogger } from "fastify";
import { withTenant, type Trx } from "../../db/index";
import { DomainError } from "../../platform/errors";
import { enqueueEvent } from "../../platform/outbox";
import * as catalog from "../catalog/service";
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

async function response(trx: Trx, serviceDayId: string, closedAt: Date): Promise<ManifestResponse> {
  const manifest = await repo.readManifest(trx, serviceDayId);
  return {
    status: "closed",
    closed_at: closedAt.toISOString(),
    manifest_version: manifest.version,
    kitchen_phone: await repo.kitchenPhone(trx),
    ...(JSON.parse(manifest.content) as ManifestContent),
  };
}

export async function closeServiceDay(
  schoolId: string,
  serviceDate: string,
  options: { log: FastifyBaseLogger; reconcile?: boolean },
): Promise<ManifestResponse> {
  if (options.reconcile !== false) await payments.reconcileServiceDay(schoolId, serviceDate, options.log);
  return withTenant(schoolId, async (trx) => {
    // Travas na ordem service_days → checkouts → payments → wallets (expireCheckout segue a mesma).
    const day = await catalog.lockServiceDayByDate(trx, serviceDate, "update");
    if (!day) throw new DomainError("not_found");
    if (day.status === "closed") return response(trx, day.id, day.closedAt!);
    // Fechar antes do corte transformaria pagamentos no prazo em crédito atrasado.
    if (day.beforeCutoff) throw new DomainError("service_day_open");

    await orders.expirePendingCheckouts(trx, schoolId, day.id);
    const content = buildManifest(await repo.manifestLines(trx, day.id), await orders.countLateCredited(trx, day.id));
    await repo.insertManifest(trx, { schoolId, serviceDayId: day.id, shift: "matutino", content: JSON.stringify(content) });
    const closedAt = await catalog.markServiceDayClosed(trx, day.id);
    await enqueueEvent(trx, schoolId, {
      type: "service_day.closed",
      data: { service_date: serviceDate, orders: content.totals.orders, late_credits: content.late_credits },
    });
    return response(trx, day.id, closedAt!);
  });
}

export async function getManifest(schoolId: string, serviceDate: string): Promise<ManifestResponse> {
  return withTenant(schoolId, async (trx) => {
    const day = await catalog.lockServiceDayByDate(trx, serviceDate, "share");
    if (!day) throw new DomainError("not_found");
    if (day.status !== "closed") throw new DomainError("service_day_open");
    return response(trx, day.id, day.closedAt!);
  });
}

/** KDS: romaneio congelado ou, com o dia aberto, a prévia dos pedidos já confirmados. */
export async function kdsManifest(schoolId: string, serviceDate: string): Promise<KdsManifestResponse> {
  return withTenant(schoolId, async (trx) => {
    const day = await catalog.lockServiceDayByDate(trx, serviceDate, "share");
    if (!day) throw new DomainError("not_found");
    if (day.status === "closed") {
      const manifest = await repo.readManifest(trx, day.id);
      return { serviceDate, status: "closed", manifestVersion: manifest.version, content: JSON.parse(manifest.content) as ManifestContent };
    }
    const content = buildManifest(await repo.manifestLines(trx, day.id), await orders.countLateCredited(trx, day.id));
    return { serviceDate, status: "open", manifestVersion: null, content };
  });
}

export type DueAction = {
  action: "send_reminders" | "close_service_day" | "send_debt_notices" | "reconcile_topups";
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
      await closeServiceDay(d.schoolId, d.serviceDate, { log: opts.log });
      closed += 1;
    } catch (err) {
      failed += 1;
      opts.log.error({ school_id: d.schoolId, service_date: d.serviceDate, err_name: err instanceof Error ? err.name : "UnknownError" }, "safety close failed");
    }
  }
  return { closed, failed };
}
