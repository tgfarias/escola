import { describe, expect, it } from "vitest";
import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { adminDb, createSchool, kitchenCookie, seedClosedDayWithOrders, seedTenant } from "../../../test/helpers";
import { buildApp } from "../../app";
import { SESSION_COOKIE } from "../../platform/session";
import { closeServiceDay } from "../serviceDays/service";

const log = { warn: () => undefined, info: () => undefined, error: () => undefined } as never;
const ev = (orderId: string, type: "delivered" | "undelivered", at: string, eventId = uuidv7()) => ({ eventId, orderId, type, occurredAt: at });

async function closedDay(schoolId: string, date: string, names = ["Léo", "Bia"]) {
  const seeded = await seedClosedDayWithOrders(schoolId, { serviceDate: date, studentNames: names });
  await closeServiceDay(schoolId, date, { log, reconcile: false });
  return seeded;
}

describe("kds manifest", () => {
  it("serves a preview while open and the frozen manifest after close", async () => {
    const schoolId = await createSchool();
    await seedTenant(schoolId);
    const { cookies } = await kitchenCookie(schoolId);
    const seeded = await seedClosedDayWithOrders(schoolId, { serviceDate: "2031-11-03", studentNames: ["Léo"] });
    const app = buildApp();
    const preview = await app.inject({ method: "GET", url: "/api/kds/v1/manifest/2031-11-03", cookies });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ serviceDate: "2031-11-03", status: "open", manifestVersion: null });
    expect(preview.json().content.by_class[0].orders[0].order_id).toBe(seeded.orderIds[0]);
    await closeServiceDay(schoolId, "2031-11-03", { log, reconcile: false });
    const closed = await app.inject({ method: "GET", url: "/api/kds/v1/manifest/2031-11-03", cookies });
    expect(closed.json()).toMatchObject({ status: "closed", manifestVersion: 1 });
    expect(closed.cookies.find((c) => c.name === SESSION_COOKIE)?.maxAge).toBe(30 * 24 * 60 * 60);
  });

  it("answers 404 for a day without service", async () => {
    const schoolId = await createSchool();
    await seedTenant(schoolId);
    const { cookies } = await kitchenCookie(schoolId);
    const res = await buildApp().inject({ method: "GET", url: "/api/kds/v1/manifest/2031-11-04", cookies });
    expect(res.statusCode).toBe(404);
  });
});

describe("kds events", () => {
  it("accepts a batch once, repeats are no-ops, and the latest event wins", async () => {
    const schoolId = await createSchool();
    await seedTenant(schoolId);
    const { cookies, deviceId } = await kitchenCookie(schoolId);
    const { orderIds } = await closedDay(schoolId, "2031-11-05");
    const [a, b] = orderIds as [string, string];
    const batch = [
      ev(a, "delivered", "2031-11-05T10:00:00Z"),
      ev(b, "delivered", "2031-11-05T10:00:01Z"),
      ev(b, "undelivered", "2031-11-05T10:00:05Z"),
    ];
    const app = buildApp();
    const first = await app.inject({ method: "POST", url: "/api/kds/v1/events", cookies, payload: { events: batch } });
    expect(first.statusCode).toBe(200);
    expect(first.json().accepted.sort()).toEqual(batch.map((e) => e.eventId).sort());
    expect(first.json().rejected).toEqual([]);
    const repeat = await app.inject({ method: "POST", url: "/api/kds/v1/events", cookies, payload: { events: batch } });
    expect(repeat.json().accepted.sort()).toEqual(batch.map((e) => e.eventId).sort());
    const stored = await adminDb().selectFrom("deliveryEvents").select(["eventId", "deviceId"]).where("orderId", "in", [a, b]).execute();
    expect(stored).toHaveLength(3);
    expect(new Set(stored.map((s) => s.deviceId))).toEqual(new Set([deviceId]));
    const orders = await adminDb().selectFrom("orders").select(["id", "status"]).where("id", "in", [a, b]).execute();
    expect(Object.fromEntries(orders.map((o) => [o.id, o.status]))).toEqual({ [a]: "delivered", [b]: "confirmed" });
  });

  it("resolves an occurred_at tie by the greater event_id, and an older event does not override", async () => {
    const schoolId = await createSchool();
    await seedTenant(schoolId);
    const { cookies } = await kitchenCookie(schoolId);
    const { orderIds } = await closedDay(schoolId, "2031-11-06", ["Léo"]);
    const order = orderIds[0]!;
    const at = "2031-11-06T10:00:00Z";
    const low = "00000000-0000-7000-8000-000000000001";
    const high = "ffffffff-ffff-7fff-bfff-ffffffffffff";
    const app = buildApp();
    await app.inject({ method: "POST", url: "/api/kds/v1/events", cookies, payload: { events: [ev(order, "delivered", at, high)] } });
    await app.inject({ method: "POST", url: "/api/kds/v1/events", cookies, payload: { events: [ev(order, "undelivered", at, low)] } });
    await app.inject({ method: "POST", url: "/api/kds/v1/events", cookies, payload: { events: [ev(order, "undelivered", "2031-11-06T09:00:00Z")] } });
    const row = await adminDb().selectFrom("orders").select("status").where("id", "=", order).executeTakeFirstOrThrow();
    expect(row.status).toBe("delivered");
  });

  it("rejects events for an open day, for an unknown order and for an order of another school", async () => {
    const schoolId = await createSchool();
    const other = await createSchool();
    await seedTenant(schoolId);
    const seedOther = await seedTenant(other);
    const { cookies } = await kitchenCookie(schoolId);
    const open = await seedClosedDayWithOrders(schoolId, { serviceDate: "2031-11-07", studentNames: ["Léo"] });
    const batch = [
      ev(open.orderIds[0]!, "delivered", "2031-11-07T10:00:00Z"),
      ev(uuidv7(), "delivered", "2031-11-07T10:00:00Z"),
      ev(seedOther.orderId, "delivered", "2031-11-07T10:00:00Z"),
    ];
    const res = await buildApp().inject({ method: "POST", url: "/api/kds/v1/events", cookies, payload: { events: batch } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accepted: [], rejected: batch.map((e) => e.eventId) });
    const count = await adminDb().selectFrom("deliveryEvents").select("eventId").where("eventId", "in", batch.map((e) => e.eventId)).execute();
    expect(count).toHaveLength(0);
  });

  it("serves changes from other tablets since a cursor", async () => {
    const schoolId = await createSchool();
    await seedTenant(schoolId);
    const t1 = await kitchenCookie(schoolId);
    const t2 = await kitchenCookie(schoolId);
    const { orderIds } = await closedDay(schoolId, "2031-11-10");
    const app = buildApp();
    const e1 = ev(orderIds[0]!, "delivered", "2031-11-10T10:00:00Z");
    await app.inject({ method: "POST", url: "/api/kds/v1/events", cookies: t1.cookies, payload: { events: [e1] } });
    const all = await app.inject({ method: "GET", url: "/api/kds/v1/changes?date=2031-11-10", cookies: t2.cookies });
    expect(all.statusCode).toBe(200);
    expect(all.json().events).toEqual([{ ...e1, occurredAt: new Date(e1.occurredAt).toISOString(), deviceId: t1.deviceId }]);
    const cursor = all.json().cursor as string;
    expect(cursor).toBeTruthy();
    const e2 = ev(orderIds[1]!, "delivered", "2031-11-10T10:01:00Z");
    await app.inject({ method: "POST", url: "/api/kds/v1/events", cookies: t1.cookies, payload: { events: [e2] } });
    const since = await app.inject({ method: "GET", url: `/api/kds/v1/changes?date=2031-11-10&since=${encodeURIComponent(cursor)}`, cookies: t2.cookies });
    const ids = since.json().events.map((e: { eventId: string }) => e.eventId);
    expect(ids).toContain(e2.eventId);
    // A janela de 1 min pode repetir e1; o cliente deduplica por event_id.
    expect(ids.every((id: string) => id === e1.eventId || id === e2.eventId)).toBe(true);
  });

  it("does not show events of another school", async () => {
    const a = await createSchool();
    const b = await createSchool();
    await seedTenant(a);
    await seedTenant(b);
    const ka = await kitchenCookie(a);
    const kb = await kitchenCookie(b);
    const { orderIds } = await closedDay(a, "2031-11-11", ["Léo"]);
    const app = buildApp();
    await app.inject({ method: "POST", url: "/api/kds/v1/events", cookies: ka.cookies, payload: { events: [ev(orderIds[0]!, "delivered", "2031-11-11T10:00:00Z")] } });
    const res = await app.inject({ method: "GET", url: "/api/kds/v1/changes?date=2031-11-11", cookies: kb.cookies });
    expect(res.json().events).toEqual([]);
  });

  it("answers 400 for a since cursor that is not a timestamp", async () => {
    const schoolId = await createSchool();
    await seedTenant(schoolId);
    const { cookies } = await kitchenCookie(schoolId);
    for (const since of ["banana", "1", "foo 2020"]) {
      const res = await buildApp().inject({ method: "GET", url: `/api/kds/v1/changes?date=2031-11-12&since=${encodeURIComponent(since)}`, cookies });
      expect(res.statusCode).toBe(400);
    }
  });

  it("returns every event of a burst and a cursor equal to its received_at", async () => {
    const schoolId = await createSchool();
    await seedTenant(schoolId);
    const { cookies, deviceId } = await kitchenCookie(schoolId);
    const { orderIds } = await closedDay(schoolId, "2031-11-13", ["Léo"]);
    const db = adminDb();
    const receivedAt = new Date("2031-11-13T10:00:00.123Z");
    await db
      .insertInto("deliveryEvents")
      .values(Array.from({ length: 1001 }, (_, i) => ({ eventId: uuidv7(), schoolId, orderId: orderIds[0]!, deviceId, type: i % 2 ? "undelivered" : "delivered", occurredAt: new Date(receivedAt.getTime() + i), receivedAt })))
      .execute();
    const res = await buildApp().inject({ method: "GET", url: "/api/kds/v1/changes?date=2031-11-13", cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json().events).toHaveLength(1001);
    const stored = await db.selectFrom("deliveryEvents").select(sql<string>`received_at::text`.as("r")).where("orderId", "=", orderIds[0]!).limit(1).executeTakeFirstOrThrow();
    expect(res.json().cursor).toBe(stored.r);
  });

  it("rejects and does not store an event for a cancelled order", async () => {
    const schoolId = await createSchool();
    await seedTenant(schoolId);
    const { cookies } = await kitchenCookie(schoolId);
    const { orderIds } = await closedDay(schoolId, "2031-11-14", ["Léo"]);
    await adminDb().updateTable("orders").set({ status: "cancelled" }).where("id", "=", orderIds[0]!).execute();
    const e = ev(orderIds[0]!, "delivered", "2031-11-14T10:00:00Z");
    const res = await buildApp().inject({ method: "POST", url: "/api/kds/v1/events", cookies, payload: { events: [e] } });
    expect(res.json()).toEqual({ accepted: [], rejected: [e.eventId] });
    const rows = await adminDb().selectFrom("deliveryEvents").select("eventId").where("eventId", "=", e.eventId).execute();
    expect(rows).toHaveLength(0);
  });
});
