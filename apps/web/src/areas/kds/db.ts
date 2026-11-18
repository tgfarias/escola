import Dexie, { type EntityTable } from "dexie";
import type { KdsManifestResponse } from "@app-lanche/contracts";
import { mergeEvent, type DeliveryEvent, type OrderState } from "./state";

export type ManifestRow = KdsManifestResponse & { fetchedAt: string };
export type OutboxRow = DeliveryEvent & { serviceDate: string };
export type MetaRow = { key: string; value: string };

class KdsDb extends Dexie {
  manifest!: EntityTable<ManifestRow, "serviceDate">;
  orderState!: EntityTable<OrderState, "orderId">;
  outbox!: EntityTable<OutboxRow, "eventId">;
  meta!: EntityTable<MetaRow, "key">;

  constructor() {
    super("app-lanche-kds");
    this.version(1).stores({
      manifest: "serviceDate",
      orderState: "orderId, serviceDate",
      outbox: "eventId, occurredAt, serviceDate",
      meta: "key",
    });
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
  // If the clock stepped backward the event is still queued; the server applies the same newest-wins rule.
  const ev: DeliveryEvent = {
    eventId: crypto.randomUUID(),
    orderId,
    type: delivered ? "delivered" : "undelivered",
    occurredAt: new Date().toISOString(),
  };
  await kdsDb.transaction("rw", kdsDb.orderState, kdsDb.outbox, async () => {
    const next = mergeEvent(await kdsDb.orderState.get(orderId), ev, serviceDate);
    if (next) await kdsDb.orderState.put(next);
    await kdsDb.outbox.add({ ...ev, serviceDate });
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
