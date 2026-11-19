import Dexie, { type EntityTable } from "dexie";
import type { CounterRosterResponse, KdsManifestResponse } from "@app-lanche/contracts";
import { canSell, isValidSale, rosterRows, type RosterRow, type SaleLine } from "../../ui/counter";
import { mergeEvent, nextOccurredAt, type DeliveryEvent, type OrderState } from "./state";

export type ManifestRow = KdsManifestResponse & { fetchedAt: string };
export type DeliveryOutboxRow = DeliveryEvent & { kind: "delivery"; serviceDate: string };
/** `eventId` = id do lançamento (regra 36): é ele que o servidor devolve em accepted/rejected. */
export type CounterSaleOutboxRow = {
  kind: "counter_sale";
  eventId: string;
  occurredAt: string;
  serviceDate: string;
  studentId: string;
  items: { menuItemId: string; qty: number }[];
  guardianId: string;
  totalCents: number;
};
/** Estorno: `eventId` próprio; o servidor responde pelo `saleId`. */
export type CounterVoidOutboxRow = {
  kind: "counter_void";
  eventId: string;
  occurredAt: string;
  serviceDate: string;
  saleId: string;
  guardianId: string;
  totalCents: number;
};
export type OutboxRow = DeliveryOutboxRow | CounterSaleOutboxRow | CounterVoidOutboxRow;
/** Lista do dia na aba "Lançar" (com "Desfazer"); o status vem da resposta do servidor. */
export type CounterSaleRow = {
  saleId: string;
  serviceDate: string;
  occurredAt: string;
  studentId: string;
  studentFirstName: string;
  guardianId: string;
  lines: SaleLine[];
  totalCents: number;
  status: "pending" | "accepted" | "rejected";
  voided: boolean;
};
export type MetaRow = { key: string; value: string };

export const ROSTER_LIMIT = "roster:limit";
export const ROSTER_ITEMS = "roster:items";
export const ROSTER_FETCHED_AT = "roster:fetchedAt";

class KdsDb extends Dexie {
  manifest!: EntityTable<ManifestRow, "serviceDate">;
  orderState!: EntityTable<OrderState, "orderId">;
  outbox!: EntityTable<OutboxRow, "eventId">;
  meta!: EntityTable<MetaRow, "key">;
  roster!: EntityTable<RosterRow, "studentId">;
  counterSales!: EntityTable<CounterSaleRow, "saleId">;

  constructor() {
    super("app-lanche-kds");
    // A future schema version must keep the `outbox` store and its key (eventId): pending deliveries live there.
    this.version(1).stores({
      manifest: "serviceDate",
      orderState: "orderId, serviceDate",
      outbox: "eventId, occurredAt, serviceDate",
      meta: "key",
    });
    // v2 (F5B): same outbox store and key, plus a `kind` index; rows written by v1 are deliveries.
    this.version(2)
      .stores({
        manifest: "serviceDate",
        orderState: "orderId, serviceDate",
        outbox: "eventId, occurredAt, serviceDate, kind",
        meta: "key",
        roster: "studentId, guardianId",
        counterSales: "saleId, serviceDate",
      })
      .upgrade((tx) =>
        tx
          .table("outbox")
          .toCollection()
          .modify((row: { kind?: string }) => {
            row.kind ??= "delivery";
          }),
      );
  }
}

export const kdsDb = new KdsDb();

export async function getMeta(key: string): Promise<string | null> {
  return (await kdsDb.meta.get(key))?.value ?? null;
}

export async function setMeta(key: string, value: string): Promise<void> {
  await kdsDb.meta.put({ key, value });
}

/** CLAUDE.md 33: uma transação atualiza orderState e insere na outbox. */
export async function markOrder(orderId: string, serviceDate: string, delivered: boolean): Promise<void> {
  await kdsDb.transaction("rw", kdsDb.orderState, kdsDb.outbox, async () => {
    const current = await kdsDb.orderState.get(orderId);
    // The tap must supersede the state on screen even if that state came from a tablet with a clock ahead.
    const ev: DeliveryEvent = {
      eventId: crypto.randomUUID(),
      orderId,
      type: delivered ? "delivered" : "undelivered",
      occurredAt: nextOccurredAt(new Date().toISOString(), current?.occurredAt),
    };
    const next = mergeEvent(current, ev, serviceDate);
    if (next) await kdsDb.orderState.put(next);
    await kdsDb.outbox.add({ ...ev, kind: "delivery", serviceDate });
  });
}

/** Eventos vindos do servidor (outros tablets): só alteram o estado se forem mais recentes. */
export async function applyRemoteEvents(serviceDate: string, events: DeliveryEvent[]): Promise<void> {
  await kdsDb.transaction("rw", kdsDb.orderState, async () => {
    for (const ev of events) {
      const next = mergeEvent(await kdsDb.orderState.get(ev.orderId), ev, serviceDate);
      if (next) await kdsDb.orderState.put(next);
    }
  });
}

export class CounterSaleRefused extends Error {
  constructor(public readonly reason: "over_limit" | "no_guardian" | "unknown_student" | "empty" | "invalid") {
    super(reason);
  }
}

/** Soma ao saldo local de todos os alunos do responsável. Chame dentro de uma transação que inclua `roster`. */
export async function adjustRosterBalance(guardianId: string, deltaCents: number): Promise<void> {
  await kdsDb.roster
    .where("guardianId")
    .equals(guardianId)
    .modify((r) => {
      r.balanceCents += deltaCents;
    });
}

/**
 * Lançamento no balcão (regras 32–34 valem também aqui): uma transação confere o limite com o último saldo baixado,
 * grava na outbox e na lista do dia e ajusta o saldo local. Devolve o id do lançamento.
 */
export async function recordCounterSale(input: { serviceDate: string; studentId: string; lines: SaleLine[] }): Promise<string> {
  return kdsDb.transaction("rw", [kdsDb.roster, kdsDb.outbox, kdsDb.counterSales, kdsDb.meta], async () => {
    const student = await kdsDb.roster.get(input.studentId);
    if (!student) throw new CounterSaleRefused("unknown_student");
    if (!student.guardianId) throw new CounterSaleRefused("no_guardian");
    if (input.lines.length === 0) throw new CounterSaleRefused("empty");
    if (!isValidSale(student.studentId, input.lines)) throw new CounterSaleRefused("invalid");
    const totalCents = input.lines.reduce((sum, l) => sum + l.qty * l.unitPriceCents, 0);
    const limit = Number((await kdsDb.meta.get(ROSTER_LIMIT))?.value ?? "0");
    if (!canSell(student.balanceCents, totalCents, limit)) throw new CounterSaleRefused("over_limit");
    const saleId = crypto.randomUUID();
    const occurredAt = new Date().toISOString();
    // Typed row first: Dexie's InsertType over the union only keeps the common keys.
    const row: CounterSaleOutboxRow = {
      kind: "counter_sale",
      eventId: saleId,
      occurredAt,
      serviceDate: input.serviceDate,
      studentId: student.studentId,
      items: input.lines.map(({ menuItemId, qty }) => ({ menuItemId, qty })),
      guardianId: student.guardianId,
      totalCents,
    };
    await kdsDb.outbox.add(row);
    await kdsDb.counterSales.add({
      saleId,
      serviceDate: input.serviceDate,
      occurredAt,
      studentId: student.studentId,
      studentFirstName: student.firstName,
      guardianId: student.guardianId,
      lines: input.lines,
      totalCents,
      status: "pending",
      voided: false,
    });
    await adjustRosterBalance(student.guardianId, -totalCents);
    return saleId;
  });
}

/** "Desfazer": estorno na outbox e saldo local devolvido, na mesma transação. */
export async function voidCounterSale(saleId: string): Promise<void> {
  await kdsDb.transaction("rw", kdsDb.roster, kdsDb.outbox, kdsDb.counterSales, async () => {
    const sale = await kdsDb.counterSales.get(saleId);
    if (!sale || sale.voided || sale.status === "rejected") return;
    await kdsDb.counterSales.update(saleId, { voided: true });
    const row: CounterVoidOutboxRow = {
      kind: "counter_void",
      eventId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      serviceDate: sale.serviceDate,
      saleId,
      guardianId: sale.guardianId,
      totalCents: sale.totalCents,
    };
    await kdsDb.outbox.add(row);
    await adjustRosterBalance(sale.guardianId, sale.totalCents);
  });
}

/** Roster novo do servidor; o saldo local reaplica o que ainda está na outbox. */
export async function replaceRoster(res: CounterRosterResponse): Promise<void> {
  await kdsDb.transaction("rw", kdsDb.roster, kdsDb.outbox, kdsDb.meta, async () => {
    const pending = await kdsDb.outbox.where("kind").anyOf("counter_sale", "counter_void").toArray();
    await kdsDb.roster.clear();
    await kdsDb.roster.bulkPut(rosterRows(res, pending));
    await kdsDb.meta.bulkPut([
      { key: ROSTER_LIMIT, value: String(res.debtLimitCents) },
      { key: ROSTER_ITEMS, value: JSON.stringify(res.items) },
      { key: ROSTER_FETCHED_AT, value: new Date().toISOString() },
    ]);
  });
}
