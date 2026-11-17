import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { afterEach, describe, expect, it } from "vitest";
import { adminDb, createSchool, guardianCookie, seedFamily, seedServiceDay, staffCookie, walletLedgerMatches } from "../../../test/helpers";
import { buildApp } from "../../app";
import { withTenant } from "../../db/index";
import { fakeMarkPaid, fakeReset } from "../payments/fakeProvider";
import { confirmPayment } from "../payments/service";
import { postEntry } from "../wallet/service";
import { closeServiceDay } from "./service";

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

    const manifest = await closeServiceDay(schoolId, day.serviceDate, { log });
    expect(manifest).toMatchObject({
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

    expect(await closeServiceDay(schoolId, day.serviceDate, { log })).toEqual(manifest);
    const events = await adminDb().selectFrom("outboxEvents").select(sql<string>`data::text`.as("data")).where("schoolId", "=", schoolId).where("type", "=", "service_day.closed").execute();
    expect(events.map((e) => JSON.parse(e.data))).toEqual([{ service_date: day.serviceDate, orders: 2, late_credits: 0 }]);
  });

  it("confirms charges paid at the gateway before closing (reconciliation)", async () => {
    const schoolId = await createSchool();
    const day = await seedServiceDay(schoolId);
    const family = await seedFamily(schoolId, ["Léo"]);
    const created = await order(schoolId, family.guardianId, day.serviceDate, family.studentIds[0]!, [{ menuItemId: day.items[0]!.id, qty: 1 }]);
    const payment = await adminDb().selectFrom("payments").select("providerChargeId").where("checkoutId", "=", created.id).executeTakeFirstOrThrow();
    fakeMarkPaid(payment.providerChargeId!, new Date(Date.now() - 1000));
    const manifest = await closeServiceDay(schoolId, day.serviceDate, { log });
    expect(manifest.totals.orders).toBe(1);
  });

  it("never puts a payment in both the manifest and the wallet, nor in neither, under concurrency", async () => {
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
      const paidAt = new Date();
      const confirmations = pending.map((p) =>
        withTenant(schoolId, (trx) => confirmPayment(trx, { schoolId, paymentId: p.paymentId, paidAt })),
      );
      const half = Math.floor(confirmations.length / 2);
      const [manifest] = await Promise.all([
        closeServiceDay(schoolId, day.serviceDate, { log, reconcile: false }),
        ...confirmations.slice(0, half),
      ]).then(async (r) => [r[0], await Promise.all(confirmations.slice(half))] as const);

      const inManifest = new Set(manifest.by_class.flatMap((c) => c.orders.map((o) => o.order_id)));
      for (const p of pending) {
        const checkout = await adminDb().selectFrom("checkouts").select("status").where("id", "=", p.checkoutId).executeTakeFirstOrThrow();
        const orderRow = await adminDb().selectFrom("orders").select("id").where("checkoutId", "=", p.checkoutId).executeTakeFirstOrThrow();
        const credits = await adminDb().selectFrom("walletEntries").select("id").where("sourceId", "=", p.paymentId).where("kind", "=", "late_payment_credit").execute();
        const served = inManifest.has(orderRow.id);
        expect(served !== (credits.length === 1)).toBe(true);
        expect(checkout.status).toBe(served ? "paid" : "late_credited");
        expect(await walletLedgerMatches(schoolId, p.guardianId)).toBe(true);
      }
    }
  });
});

describe("service day close routes", () => {
  it("closes through the admin route and serves the manifest only after closing", async () => {
    const schoolId = await createSchool();
    const day = await seedServiceDay(schoolId);
    const { cookies } = await staffCookie(schoolId, "secretaria");
    const before = await buildApp().inject({ method: "GET", url: `/api/admin/v1/service-days/${day.serviceDate}/manifest`, cookies });
    expect(before.statusCode).toBe(409);
    expect(before.json().error.code).toBe("service_day_open");
    const closed = await buildApp().inject({ method: "POST", url: `/api/admin/v1/service-days/${day.serviceDate}/close`, cookies });
    expect(closed.statusCode).toBe(200);
    const after = await buildApp().inject({ method: "GET", url: `/api/admin/v1/service-days/${day.serviceDate}/manifest`, cookies });
    expect(after.json()).toEqual(closed.json());
    const kitchen = await staffCookie(schoolId, "cozinha");
    expect((await buildApp().inject({ method: "POST", url: `/api/admin/v1/service-days/${day.serviceDate}/close`, cookies: kitchen.cookies })).statusCode).toBe(403);
    expect((await buildApp().inject({ method: "POST", url: "/api/admin/v1/service-days/2031-01-01/close", cookies })).statusCode).toBe(404);
  });
});
