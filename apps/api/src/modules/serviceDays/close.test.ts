import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { afterEach, describe, expect, it } from "vitest";
import { adminDb, createSchool, guardianCookie, moveCutoff, seedConfirmedOrders, seedFamily, seedServiceDay, seedTenant, seedTwoShiftFamily, staffCookie, walletLedgerMatches } from "../../../test/helpers";
import { buildApp } from "../../app";
import { withTenant } from "../../db/index";
import { fakeMarkPaid, fakeReset } from "../payments/fakeProvider";
import { confirmPayment } from "../payments/service";
import { postEntry } from "../wallet/service";
import { closeServiceDay, closeShift, safetyClose } from "./service";

afterEach(() => fakeReset());
const log = buildApp().log;

async function order(schoolId: string, guardianId: string, serviceDate: string, studentId: string, items: { menuItemId: string; qty: number }[]) {
  const res = await buildApp().inject({
    method: "POST",
    url: "/api/v1/checkouts",
    cookies: await guardianCookie(schoolId, guardianId),
    headers: { "idempotency-key": uuidv7() },
    payload: { serviceDate, orders: [{ studentId, items }] },
  });
  return res.json() as { id: string; status: string };
}

async function credit(schoolId: string, guardianId: string, amountCents: number) {
  await withTenant(schoolId, (trx) =>
    postEntry(trx, { schoolId, guardianId, kind: "cancel_credit", amountCents, sourceType: "checkout", sourceId: uuidv7() }),
  );
}

async function passCutoff(serviceDayId: string) {
  await moveCutoff(serviceDayId, -1);
}

describe("closeServiceDay", () => {
  it("freezes the manifest, expires unpaid checkouts and is idempotent", async () => {
    const schoolId = await createSchool();
    await adminDb().updateTable("schools").set({ kitchenPhone: "+5511988880000" }).where("id", "=", schoolId).execute();
    const day = await seedServiceDay(schoolId, { items: [{ name: "Misto quente", priceCents: 900 }, { name: "Suco", priceCents: 450 }] });
    const [misto, suco] = day.items;

    const ana = await seedFamily(schoolId, ["Léo"]);
    await sql`UPDATE students SET dietary_restrictions = 'sem lactose' WHERE id = ${ana.studentIds[0]!}`.execute(adminDb());
    await sql`UPDATE guardian_students SET restriction_consent_at = now() WHERE student_id = ${ana.studentIds[0]!}`.execute(adminDb());
    await credit(schoolId, ana.guardianId, 5000);
    const paid = await order(schoolId, ana.guardianId, day.serviceDate, ana.studentIds[0]!, [
      { menuItemId: misto!.id, qty: 2 },
      { menuItemId: suco!.id, qty: 1 },
    ]);
    expect(paid.status).toBe("paid");

    const rui = await seedFamily(schoolId, ["Bia"]);
    await sql`UPDATE students SET dietary_restrictions = 'sem glúten' WHERE id = ${rui.studentIds[0]!}`.execute(adminDb());
    await credit(schoolId, rui.guardianId, 900);
    await order(schoolId, rui.guardianId, day.serviceDate, rui.studentIds[0]!, [{ menuItemId: misto!.id, qty: 1 }]);

    const eva = await seedFamily(schoolId, ["Caio"]);
    await credit(schoolId, eva.guardianId, 200);
    const unpaid = await order(schoolId, eva.guardianId, day.serviceDate, eva.studentIds[0]!, [{ menuItemId: misto!.id, qty: 1 }]);
    expect(unpaid.status).toBe("pending_payment");

    await passCutoff(day.serviceDayId);
    const manifest = (await closeServiceDay(schoolId, day.serviceDate, { log })).shifts[0]!;
    expect(manifest).toMatchObject({
      shift: "matutino",
      status: "closed",
      manifest_version: 1,
      kitchen_phone: "+5511988880000",
      totals: { orders: 2, by_item: [{ item: misto!.name, qty: 3 }, { item: suco!.name, qty: 1 }] },
      late_credits: 0,
    });
    const orders = manifest.by_class[0]!.orders;
    expect(manifest.by_class.map((c) => c.class)).toEqual(["Infantil 3A"]);
    expect(orders.find((o) => o.student === "Léo")).toMatchObject({ items: [`2x ${misto!.name}`, suco!.name], restrictions: "sem lactose" });
    expect(orders.find((o) => o.student === "Bia")).toMatchObject({ restrictions: null });
    expect(orders.find((o) => o.student === "Caio")).toBeUndefined();

    const unpaidState = await adminDb().selectFrom("checkouts").select("status").where("id", "=", unpaid.id).executeTakeFirstOrThrow();
    expect(unpaidState.status).toBe("expired");
    expect(await walletLedgerMatches(schoolId, eva.guardianId)).toBe(true);
    const evaWallet = await adminDb().selectFrom("wallets").select("balanceCents").where("guardianId", "=", eva.guardianId).executeTakeFirstOrThrow();
    expect(evaWallet.balanceCents).toBe(200);

    expect((await closeServiceDay(schoolId, day.serviceDate, { log })).shifts[0]).toEqual(manifest);
    const events = await adminDb().selectFrom("outboxEvents").select(sql<string>`data::text`.as("data")).where("schoolId", "=", schoolId).where("type", "=", "service_day.closed").execute();
    expect(events.map((e) => JSON.parse(e.data))).toEqual([{ service_date: day.serviceDate, shift: "matutino", orders: 2, late_credits: 0 }]);
  });

  it("confirms charges paid at the gateway before closing (reconciliation)", async () => {
    const schoolId = await createSchool();
    const day = await seedServiceDay(schoolId);
    const family = await seedFamily(schoolId, ["Léo"]);
    const created = await order(schoolId, family.guardianId, day.serviceDate, family.studentIds[0]!, [{ menuItemId: day.items[0]!.id, qty: 1 }]);
    const payment = await adminDb().selectFrom("payments").select("providerChargeId").where("checkoutId", "=", created.id).executeTakeFirstOrThrow();
    fakeMarkPaid(payment.providerChargeId!, new Date(Date.now() - 120_000));
    await passCutoff(day.serviceDayId);
    const manifest = await closeServiceDay(schoolId, day.serviceDate, { log });
    expect(manifest.shifts[0]!.totals.orders).toBe(1);
  });

  it("never puts a payment in both the manifest and the wallet, nor in neither, under concurrency", async () => {
    let served = 0;
    let late = 0;
    for (let round = 0; round < 3; round++) {
      const schoolId = await createSchool();
      const day = await seedServiceDay(schoolId);
      const pending: { checkoutId: string; paymentId: string; guardianId: string }[] = [];
      for (let i = 0; i < 12; i++) {
        const family = await seedFamily(schoolId, [`Aluno${i}`]);
        const c = await order(schoolId, family.guardianId, day.serviceDate, family.studentIds[0]!, [{ menuItemId: day.items[0]!.id, qty: 1 }]);
        const p = await adminDb().selectFrom("payments").select("id").where("checkoutId", "=", c.id).executeTakeFirstOrThrow();
        pending.push({ checkoutId: c.id, paymentId: p.id, guardianId: family.guardianId });
      }
      await passCutoff(day.serviceDayId);
      const paidAt = new Date(Date.now() - 120_000);
      const confirm = (p: (typeof pending)[number]) => withTenant(schoolId, (trx) => confirmPayment(trx, { schoolId, paymentId: p.paymentId, paidAt }));
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const half = pending.length / 2;
      const firstBatch = pending.slice(0, half).map(confirm);
      const started: Promise<unknown>[] = [...firstBatch];
      await sleep(20);
      const closing = closeServiceDay(schoolId, day.serviceDate, { log, reconcile: false });
      started.push(closing);
      // New FOR SHARE lockers can join the first batch's share locks ahead of the waiting FOR UPDATE, so the
      // second batch starts once those are released: it then races the close holding (or taking) the day lock.
      await Promise.allSettled(firstBatch);
      await sleep(20);
      started.push(...pending.slice(half).map(confirm));
      const settled = await Promise.allSettled(started);
      expect(settled.filter((r) => r.status === "rejected")).toEqual([]);
      const manifest = (await closing).shifts[0]!;

      const inManifest = new Set(manifest.by_class.flatMap((c) => c.orders.map((o) => o.order_id)));
      for (const p of pending) {
        const checkout = await adminDb().selectFrom("checkouts").select("status").where("id", "=", p.checkoutId).executeTakeFirstOrThrow();
        const orderRow = await adminDb().selectFrom("orders").select("id").where("checkoutId", "=", p.checkoutId).executeTakeFirstOrThrow();
        const credits = await adminDb().selectFrom("walletEntries").select("id").where("sourceId", "=", p.paymentId).where("kind", "=", "late_payment_credit").execute();
        const isServed = inManifest.has(orderRow.id);
        expect(isServed !== (credits.length === 1)).toBe(true);
        expect(checkout.status).toBe(isServed ? "paid" : "late_credited");
        expect(await walletLedgerMatches(schoolId, p.guardianId)).toBe(true);
        if (isServed) served += 1;
        else late += 1;
      }
    }
    expect(served).toBeGreaterThan(0);
    expect(late).toBeGreaterThan(0);
  });
});

describe("service day close routes", () => {
  it("closes through the admin route and serves the manifest only after closing", async () => {
    const schoolId = await createSchool();
    const day = await seedServiceDay(schoolId);
    const { cookies } = await staffCookie(schoolId, "secretaria");
    const before = await buildApp().inject({ method: "GET", url: `/api/admin/v1/service-days/${day.serviceDate}/manifest?shift=matutino`, cookies });
    expect(before.statusCode).toBe(409);
    expect(before.json().error.code).toBe("service_day_open");
    const early = await buildApp().inject({ method: "POST", url: `/api/admin/v1/service-days/${day.serviceDate}/close`, cookies });
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe("service_day_open");
    const stillOpen = await adminDb().selectFrom("serviceDays").select("status").where("id", "=", day.serviceDayId).executeTakeFirstOrThrow();
    expect(stillOpen.status).toBe("open");
    const manifests = await adminDb().selectFrom("manifests").select("id").where("serviceDayId", "=", day.serviceDayId).execute();
    expect(manifests).toEqual([]);
    const closedEvents = await adminDb().selectFrom("outboxEvents").select("id").where("schoolId", "=", schoolId).where("type", "=", "service_day.closed").execute();
    expect(closedEvents).toEqual([]);
    await passCutoff(day.serviceDayId);
    const closed = await buildApp().inject({ method: "POST", url: `/api/admin/v1/service-days/${day.serviceDate}/close`, cookies });
    expect(closed.statusCode).toBe(200);
    const after = await buildApp().inject({ method: "GET", url: `/api/admin/v1/service-days/${day.serviceDate}/manifest?shift=matutino`, cookies });
    expect(after.json()).toEqual(closed.json().shifts[0]);
    const kitchen = await staffCookie(schoolId, "cozinha");
    expect((await buildApp().inject({ method: "POST", url: `/api/admin/v1/service-days/${day.serviceDate}/close`, cookies: kitchen.cookies })).statusCode).toBe(403);
    expect((await buildApp().inject({ method: "POST", url: "/api/admin/v1/service-days/2031-01-01/close", cookies })).statusCode).toBe(404);
  });
});

describe("close per shift", () => {
  it("closes each shift on its own and closes the day with the last one", async () => {
    const schoolId = await createSchool();
    const day = await seedServiceDay(schoolId, { serviceDate: "2031-03-03", shifts: { matutino: -10, vespertino: 120 } });
    const morning = await seedConfirmedOrders(schoolId, { serviceDayId: day.serviceDayId, serviceDate: day.serviceDate, menuItemId: day.items[0]!.id, studentNames: ["Léo"], shift: "matutino" });
    const afternoon = await seedConfirmedOrders(schoolId, { serviceDayId: day.serviceDayId, serviceDate: day.serviceDate, menuItemId: day.items[0]!.id, studentNames: ["Bia"], shift: "vespertino" });

    const first = await closeServiceDay(schoolId, day.serviceDate, { log, reconcile: false, due: "frozen" });
    expect(first.status).toBe("open");
    expect(first.shifts.map((s) => [s.shift, s.status])).toEqual([["matutino", "closed"]]);
    expect(first.shifts[0]!.by_class.flatMap((c) => c.orders.map((o) => o.order_id))).toEqual(morning.orderIds);
    await expect(closeShift(schoolId, day.serviceDate, "vespertino", { log, reconcile: false })).rejects.toMatchObject({ code: "service_day_open" });

    await moveCutoff(day.serviceDayId, -600, "vespertino");
    const second = await closeServiceDay(schoolId, day.serviceDate, { log, reconcile: false, due: "frozen" });
    expect(second.status).toBe("closed");
    expect(second.shifts.map((s) => s.shift)).toEqual(["matutino", "vespertino"]);
    expect(second.shifts[0]).toEqual(first.shifts[0]); // romaneio imutável
    expect(second.shifts[1]!.by_class.flatMap((c) => c.orders.map((o) => o.order_id))).toEqual(afternoon.orderIds);
    const events = await adminDb().selectFrom("outboxEvents").select(sql<string>`data::text`.as("data")).where("schoolId", "=", schoolId).where("type", "=", "service_day.closed").orderBy("occurredAt").orderBy("id").execute();
    expect(events.map((e) => JSON.parse(e.data))).toEqual([
      { service_date: day.serviceDate, shift: "matutino", orders: 1, late_credits: 0 },
      { service_date: day.serviceDate, shift: "vespertino", orders: 1, late_credits: 0 },
    ]);
  });

  it("closes only frozen shifts on the automatic path and every shift past its cutoff on the staff path", async () => {
    const schoolId = await createSchool();
    const day = await seedServiceDay(schoolId, { serviceDate: "2031-03-04", shifts: { matutino: -2, vespertino: 120 } });
    await expect(closeServiceDay(schoolId, day.serviceDate, { log, reconcile: false, due: "frozen" })).rejects.toMatchObject({ code: "service_day_open" });
    const staff = await closeServiceDay(schoolId, day.serviceDate, { log, reconcile: false, due: "past_cutoff" });
    expect(staff.shifts.map((s) => s.shift)).toEqual(["matutino"]);
  });

  it("expires only the unpaid checkouts of the shift being closed", async () => {
    const schoolId = await createSchool();
    const day = await seedServiceDay(schoolId, { serviceDate: "2031-03-05", shifts: { matutino: 60, vespertino: 300 } });
    const f = await seedTwoShiftFamily(schoolId);
    const leo = await order(schoolId, f.guardianId, day.serviceDate, f.leo, [{ menuItemId: day.items[0]!.id, qty: 1 }]);
    const bia = await order(schoolId, f.guardianId, day.serviceDate, f.bia, [{ menuItemId: day.items[0]!.id, qty: 1 }]);
    await moveCutoff(day.serviceDayId, -1, "matutino");
    await closeShift(schoolId, day.serviceDate, "matutino", { log, reconcile: false });
    const status = async (id: string) => (await adminDb().selectFrom("checkouts").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status;
    expect(await status(leo.id)).toBe("expired");
    expect(await status(bia.id)).toBe("pending_payment");
  });

  it("never puts a payment in both the shift manifest and the wallet while the other shift stays open", async () => {
    let served = 0;
    let late = 0;
    for (let round = 0; round < 3; round++) {
      const schoolId = await createSchool();
      const day = await seedServiceDay(schoolId, { shifts: { matutino: 60, vespertino: 300 } });
      const pending: { checkoutId: string; paymentId: string; guardianId: string }[] = [];
      for (let i = 0; i < 12; i++) {
        const family = await seedFamily(schoolId, [`Aluno${i}`], { shift: "matutino" });
        const c = await order(schoolId, family.guardianId, day.serviceDate, family.studentIds[0]!, [{ menuItemId: day.items[0]!.id, qty: 1 }]);
        const p = await adminDb().selectFrom("payments").select("id").where("checkoutId", "=", c.id).executeTakeFirstOrThrow();
        pending.push({ checkoutId: c.id, paymentId: p.id, guardianId: family.guardianId });
      }
      await moveCutoff(day.serviceDayId, -1, "matutino");
      const paidAt = new Date(Date.now() - 120_000);
      const confirm = (p: (typeof pending)[number]) => withTenant(schoolId, (trx) => confirmPayment(trx, { schoolId, paymentId: p.paymentId, paidAt }));
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const half = pending.length / 2;
      const firstBatch = pending.slice(0, half).map(confirm);
      const started: Promise<unknown>[] = [...firstBatch];
      await sleep(20);
      const closing = closeShift(schoolId, day.serviceDate, "matutino", { log, reconcile: false });
      started.push(closing);
      await Promise.allSettled(firstBatch);
      await sleep(20);
      started.push(...pending.slice(half).map(confirm));
      const settled = await Promise.allSettled(started);
      expect(settled.filter((r) => r.status === "rejected")).toEqual([]);
      const manifest = await closing;
      const inManifest = new Set(manifest.by_class.flatMap((c) => c.orders.map((o) => o.order_id)));
      for (const p of pending) {
        const checkout = await adminDb().selectFrom("checkouts").select("status").where("id", "=", p.checkoutId).executeTakeFirstOrThrow();
        const orderRow = await adminDb().selectFrom("orders").select("id").where("checkoutId", "=", p.checkoutId).executeTakeFirstOrThrow();
        const credits = await adminDb().selectFrom("walletEntries").select("id").where("sourceId", "=", p.paymentId).where("kind", "=", "late_payment_credit").execute();
        const isServed = inManifest.has(orderRow.id);
        expect(isServed !== (credits.length === 1)).toBe(true);
        expect(checkout.status).toBe(isServed ? "paid" : "late_credited");
        expect(await walletLedgerMatches(schoolId, p.guardianId)).toBe(true);
        if (isServed) served += 1;
        else late += 1;
      }
      const afternoon = await adminDb().selectFrom("serviceDayShifts").select("status").where("id", "=", day.shiftIds.vespertino!).executeTakeFirstOrThrow();
      expect(afternoon.status).toBe("open");
    }
    expect(served).toBeGreaterThan(0);
    expect(late).toBeGreaterThan(0);
  });

  it("closes one shift through the admin route and serves its manifest", async () => {
    const schoolId = await createSchool();
    const day = await seedServiceDay(schoolId, { serviceDate: "2031-03-06", shifts: { matutino: -1, vespertino: 120 } });
    const { cookies } = await staffCookie(schoolId, "secretaria");
    const app = buildApp();
    const closed = await app.inject({ method: "POST", url: `/api/admin/v1/service-days/${day.serviceDate}/shifts/matutino/close`, cookies });
    expect(closed.statusCode).toBe(200);
    expect(closed.json()).toMatchObject({ shift: "matutino", status: "closed", manifest_version: 1 });
    const read = await app.inject({ method: "GET", url: `/api/admin/v1/service-days/${day.serviceDate}/manifest?shift=matutino`, cookies });
    expect(read.json()).toEqual(closed.json());
    const open = await app.inject({ method: "GET", url: `/api/admin/v1/service-days/${day.serviceDate}/manifest?shift=vespertino`, cookies });
    expect(open.json().error.code).toBe("service_day_open");
    const early = await app.inject({ method: "POST", url: `/api/admin/v1/service-days/${day.serviceDate}/shifts/vespertino/close`, cookies });
    expect(early.json().error.code).toBe("service_day_open");
    expect((await app.inject({ method: "POST", url: `/api/admin/v1/service-days/${day.serviceDate}/shifts/noite/close`, cookies })).statusCode).toBe(400);
  });
});

describe("safetyClose", () => {
  it("closes only days 10 minutes past the cutoff", async () => {
    const schoolId = await createSchool();
    await seedTenant(schoolId);
    const overdue = await seedServiceDay(schoolId, { serviceDate: "2031-08-01", cutoffInMinutes: -11 });
    const frozen = await seedServiceDay(schoolId, { serviceDate: "2031-08-02", cutoffInMinutes: -7 });
    const result = await safetyClose({ log, schoolIds: [schoolId] });
    expect(result).toEqual({ closed: 1, failed: 0 });
    const days = await adminDb().selectFrom("serviceDays").select(["id", "status"]).where("id", "in", [overdue.serviceDayId, frozen.serviceDayId]).execute();
    expect(Object.fromEntries(days.map((d) => [d.id, d.status]))).toEqual({ [overdue.serviceDayId]: "closed", [frozen.serviceDayId]: "open" });
  });
});
