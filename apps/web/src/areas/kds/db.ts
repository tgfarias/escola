import Dexie, { type EntityTable } from "dexie";
import type { KdsManifestResponse } from "@app-lanche/contracts";
import { mergeEvent, nextOccurredAt, type DeliveryEvent, type OrderState } from "./state";

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
    // A future schema version must keep the `outbox` store and its key (eventId): pending deliveries live there.
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
