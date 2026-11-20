import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { describe, expect, it } from "vitest";
import { adminDb, createSchool, guardianCookie, markDayClosed, moveCutoff, seedFamily, seedServiceDay, walletLedgerMatches } from "../../../test/helpers";
import { buildApp } from "../../app";
import { withTenant } from "../../db/index";
import { postEntry } from "../wallet/service";
import { confirmPayment } from "./service";

/** Checkout de 1350 com 500 de saldo aplicado e Pix pendente de 850. */
async function pendingCheckout() {
  const schoolId = await createSchool();
  const family = await seedFamily(schoolId, ["Léo"]);
  const day = await seedServiceDay(schoolId);
  await withTenant(schoolId, (trx) =>
    postEntry(trx, { schoolId, guardianId: family.guardianId, kind: "cancel_credit", amountCents: 500, sourceType: "checkout", sourceId: uuidv7() }),
  );
  const res = await buildApp().inject({
    method: "POST",
    url: "/api/v1/checkouts",
    cookies: await guardianCookie(schoolId, family.guardianId),
    headers: { "idempotency-key": uuidv7() },
    payload: {
      serviceDate: day.serviceDate,
      orders: [{ studentId: family.studentIds[0]!, items: day.items.map((i) => ({ menuItemId: i.id, qty: 1 })) }],
    },
  });
  const checkoutId = res.json().id as string;
  const payment = await adminDb()
    .selectFrom("payments")
    .innerJoin("checkouts", "checkouts.id", "payments.checkoutId")
    .innerJoin("serviceDays", "serviceDays.id", "checkouts.serviceDayId")
    .select(["payments.id", "serviceDays.cutoffAt"])
    .where("payments.checkoutId", "=", checkoutId)
    .executeTakeFirstOrThrow();
  return { schoolId, family, day, checkoutId, paymentId: payment.id, cutoffAt: payment.cutoffAt };
}

async function state(schoolId: string, checkoutId: string) {
  const db = adminDb();
  const checkout = await db.selectFrom("checkouts").select("status").where("id", "=", checkoutId).executeTakeFirstOrThrow();
  const orders = await db.selectFrom("orders").select("status").where("checkoutId", "=", checkoutId).execute();
  const payment = await db.selectFrom("payments").select(["status", "paidAt"]).where("checkoutId", "=", checkoutId).executeTakeFirstOrThrow();
  const entries = await db
    .selectFrom("walletEntries")
    .select(["kind", "amountCents"])
    .where("schoolId", "=", schoolId)
    // Entries of one transaction share created_at (now() is the transaction start) and UUIDv7 ids are not
    // ordered within a millisecond: break ties by kind so the expected order is stable.
    .orderBy("createdAt")
    .orderBy("kind")
    .execute();
  const events = await db
    .selectFrom("outboxEvents")
    .select(["type", sql<string>`data::text`.as("data")])
    .where("schoolId", "=", schoolId)
    .where("type", "like", "payment.%")
    .execute();
  return {
    checkout: checkout.status,
    orders: orders.map((o) => o.status),
    payment,
    entries,
    events: events.map((e) => ({ type: e.type, data: JSON.parse(e.data) })),
  };
}

const confirm = (schoolId: string, paymentId: string, paidAt: Date) =>
  withTenant(schoolId, (trx) => confirmPayment(trx, { schoolId, paymentId, paidAt }));

describe("confirmPayment", () => {
  it("confirms a payment made before the cutoff", async () => {
    const c = await pendingCheckout();
    const paidAt = new Date(c.cutoffAt.getTime() - 60_000);
    expect(await confirm(c.schoolId, c.paymentId, paidAt)).toBe("confirmed");
    const s = await state(c.schoolId, c.checkoutId);
    expect(s.checkout).toBe("paid");
    expect(s.orders).toEqual(["confirmed"]);
    expect(s.payment).toEqual({ status: "paid", paidAt });
    expect(s.events).toEqual([{ type: "payment.confirmed", data: expect.objectContaining({ checkout_id: c.checkoutId, total_cents: 1350 }) }]);
  });

  it("does nothing the second time", async () => {
    const c = await pendingCheckout();
    const paidAt = new Date(c.cutoffAt.getTime() - 60_000);
    await confirm(c.schoolId, c.paymentId, paidAt);
    const before = await state(c.schoolId, c.checkoutId);
    expect(await confirm(c.schoolId, c.paymentId, paidAt)).toBe("already_processed");
    expect(await state(c.schoolId, c.checkoutId)).toEqual(before);
  });

  it("credits the wallet when paid after the cutoff, releasing the hold once", async () => {
    const c = await pendingCheckout();
    const paidAt = new Date(c.cutoffAt.getTime() + 1000);
    expect(await confirm(c.schoolId, c.paymentId, paidAt)).toBe("late_credited");
    const s = await state(c.schoolId, c.checkoutId);
    expect(s.checkout).toBe("late_credited");
    expect(s.orders).toEqual(["expired_late"]);
    expect(s.payment.status).toBe("paid");
    expect(s.entries.map((e) => [e.kind, e.amountCents])).toEqual([
      ["cancel_credit", 500],
      ["checkout_hold", -500],
      ["hold_release", 500],
      ["late_payment_credit", 850],
    ]);
    expect(s.events).toEqual([
      {
        type: "payment.late_credited",
        data: expect.objectContaining({ guardian_id: c.family.guardianId, amount_cents: 850, wallet_balance_cents: 1350 }),
      },
    ]);
    expect(await walletLedgerMatches(c.schoolId, c.family.guardianId)).toBe(true);
  });

  it("credits the wallet when the day is already closed, even if paid on time", async () => {
    const c = await pendingCheckout();
    await markDayClosed(c.day.serviceDayId);
    expect(await confirm(c.schoolId, c.paymentId, new Date(c.cutoffAt.getTime() - 60_000))).toBe("late_credited");
    expect((await state(c.schoolId, c.checkoutId)).checkout).toBe("late_credited");
  });

  it("credits a payment made after its own shift's cutoff even while the day's later shift is open", async () => {
    const schoolId = await createSchool();
    const day = await seedServiceDay(schoolId, { shifts: { matutino: 60, vespertino: 300 } });
    const fam = await seedFamily(schoolId, ["Léo"], { shift: "matutino" });
    const res = await buildApp().inject({
      method: "POST",
      url: "/api/v1/checkouts",
      cookies: await guardianCookie(schoolId, fam.guardianId),
      headers: { "idempotency-key": uuidv7() },
      payload: { serviceDate: day.serviceDate, orders: [{ studentId: fam.studentIds[0]!, items: [{ menuItemId: day.items[0]!.id, qty: 1 }] }] },
    });
    const checkoutId = res.json().id as string;
    const payment = await adminDb().selectFrom("payments").select("id").where("checkoutId", "=", checkoutId).executeTakeFirstOrThrow();
    await moveCutoff(day.serviceDayId, -60, "matutino");
    const outcome = await withTenant(schoolId, (trx) => confirmPayment(trx, { schoolId, paymentId: payment.id, paidAt: new Date() }));
    expect(outcome).toBe("late_credited");
    const order = await adminDb().selectFrom("orders").select("status").where("checkoutId", "=", checkoutId).executeTakeFirstOrThrow();
    expect(order.status).toBe("expired_late");
    expect(await walletLedgerMatches(schoolId, fam.guardianId)).toBe(true);
  });
});
