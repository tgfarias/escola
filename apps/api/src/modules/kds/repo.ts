import { sql } from "kysely";
import type { Trx } from "../../db/index";

/** Novo tablet aguardando pareamento; validade de 10 min pelo relógio do banco. */
export async function insertPendingDevice(trx: Trx, row: { id: string; schoolId: string; codeHash: string }): Promise<Date> {
  const { rows } = await sql<{ pairingExpiresAt: Date }>`
    INSERT INTO devices (id, school_id, kind, pairing_code_hash, pairing_expires_at)
    VALUES (${row.id}, ${row.schoolId}, 'kitchen', ${row.codeHash}, now() + interval '10 minutes')
    RETURNING pairing_expires_at`.execute(trx);
  return rows[0]!.pairingExpiresAt;
}

/** Consome o código: só uma troca vence. */
export async function consumePairingCode(trx: Trx, deviceId: string, codeHash: string): Promise<boolean> {
  const res = await sql`
    UPDATE devices SET pairing_code_hash = NULL, pairing_expires_at = NULL
    WHERE id = ${deviceId} AND kind = 'kitchen' AND pairing_code_hash = ${codeHash}
      AND pairing_expires_at > now() AND revoked_at IS NULL`.execute(trx);
  return Number(res.numAffectedRows ?? 0) === 1;
}

export async function listKitchenDevices(trx: Trx) {
  return trx
    .selectFrom("devices")
    .select(["id", "createdAt", "pairingCodeHash", "revokedAt"])
    .where("kind", "=", "kitchen")
    .orderBy("createdAt", "desc")
    .execute();
}

export async function revokeKitchenDevice(trx: Trx, deviceId: string): Promise<"revoked" | "already" | "missing"> {
  const res = await sql`UPDATE devices SET revoked_at = now() WHERE id = ${deviceId} AND kind = 'kitchen' AND revoked_at IS NULL`.execute(trx);
  if (Number(res.numAffectedRows ?? 0) === 1) return "revoked";
  const row = await trx.selectFrom("devices").select("id").where("id", "=", deviceId).where("kind", "=", "kitchen").executeTakeFirst();
  return row ? "already" : "missing";
}

/** Relógio do banco: única fonte de tempo para as regras (CLAUDE.md 15). */
export async function dbNow(trx: Trx): Promise<Date> {
  const { rows } = await sql<{ now: Date }>`SELECT now() AS now`.execute(trx);
  return rows[0]!.now;
}

/** Pedidos do lote que aceitam entrega: existem, dia fechado, estado confirmado ou entregue. Trava os dias antes (FOR SHARE). */
export async function deliverableOrders(trx: Trx, orderIds: string[]): Promise<Set<string>> {
  if (orderIds.length === 0) return new Set();
  await sql`
    SELECT d.id FROM service_days d
    WHERE d.id IN (SELECT c.service_day_id FROM orders o JOIN checkouts c ON c.id = o.checkout_id WHERE o.id = ANY(${orderIds}::uuid[]))
    ORDER BY d.id FOR SHARE`.execute(trx);
  const { rows } = await sql<{ id: string }>`
    SELECT o.id FROM orders o
    JOIN checkouts c ON c.id = o.checkout_id
    JOIN service_days d ON d.id = c.service_day_id
    WHERE o.id = ANY(${orderIds}::uuid[]) AND d.status = 'closed' AND o.status IN ('confirmed', 'delivered')
    ORDER BY o.id FOR UPDATE OF o`.execute(trx);
  return new Set(rows.map((r) => r.id));
}

export async function insertEvents(
  trx: Trx,
  schoolId: string,
  deviceId: string,
  events: { eventId: string; orderId: string; type: string; occurredAt: string }[],
): Promise<void> {
  if (events.length === 0) return;
  await trx
    .insertInto("deliveryEvents")
    .values(events.map((e) => ({ eventId: e.eventId, schoolId, orderId: e.orderId, deviceId, type: e.type, occurredAt: new Date(e.occurredAt) })))
    .onConflict((oc) => oc.column("eventId").doNothing())
    .execute();
}

/** event_ids do lote que existem nesta escola (inseridos agora ou antes). */
export async function existingEventIds(trx: Trx, eventIds: string[]): Promise<Set<string>> {
  if (eventIds.length === 0) return new Set();
  const rows = await trx.selectFrom("deliveryEvents").select("eventId").where("eventId", "in", eventIds).execute();
  return new Set(rows.map((r) => r.eventId));
}

/** Aplica o evento vencedor (maior occurred_at, empate pelo maior event_id) a cada pedido. Ordem de uuid = ordem do texto em hex minúsculo, igual à regra do cliente. */
export async function applyLatestState(trx: Trx, orderIds: string[]): Promise<void> {
  if (orderIds.length === 0) return;
  await sql`
    WITH latest AS (
      SELECT DISTINCT ON (order_id) order_id, type
      FROM delivery_events
      WHERE order_id = ANY(${orderIds}::uuid[])
      ORDER BY order_id, occurred_at DESC, event_id DESC
    )
    UPDATE orders o SET status = CASE WHEN l.type = 'delivered' THEN 'delivered' ELSE 'confirmed' END
    FROM latest l
    WHERE o.id = l.order_id
      AND ((l.type = 'delivered' AND o.status = 'confirmed') OR (l.type = 'undelivered' AND o.status = 'delivered'))`.execute(trx);
}

export async function changesSince(trx: Trx, serviceDate: string, since: string | null) {
  const { rows } = await sql<{ eventId: string; orderId: string; type: "delivered" | "undelivered"; occurredAt: Date; deviceId: string; receivedAt: string }>`
    SELECT e.event_id, e.order_id, e.type, e.occurred_at, e.device_id, e.received_at::text AS received_at
    FROM delivery_events e JOIN orders o ON o.id = e.order_id
    WHERE o.service_date = ${serviceDate}::date
      AND (${since}::timestamptz IS NULL OR e.received_at > ${since}::timestamptz - interval '1 minute')
    ORDER BY e.received_at, e.event_id`.execute(trx);
  return rows;
}
