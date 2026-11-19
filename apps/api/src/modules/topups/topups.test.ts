import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { afterEach, describe, expect, it } from "vitest";
import { adminDb, createSchool, guardianCookie, seedFamily, seedServiceDay, staffCookie, walletLedgerMatches } from "../../../test/helpers";
import { buildApp } from "../../app";
import { withTenant } from "../../db/index";
import { fakeFailNextCreate, fakeReset } from "../payments/fakeProvider";
import { confirmPayment } from "../payments/service";
import { postEntry } from "../wallet/service";

const SECRET = process.env.PAYMENT_WEBHOOK_SECRET_TEST!;
afterEach(() => fakeReset());

async function setup() {
  const schoolId = await createSchool();
  await adminDb().updateTable("schools").set({ paymentWebhookSecretRef: "PAYMENT_WEBHOOK_SECRET_TEST" }).where("id", "=", schoolId).execute();
  const fam = await seedFamily(schoolId, ["Léo"]);
  const cookies = await guardianCookie(schoolId, fam.guardianId, "wallet");
  return { schoolId, guardianId: fam.guardianId, cookies };
}

type Setup = Awaited<ReturnType<typeof setup>>;
const create = (s: Setup, payload: object, key: string = uuidv7()) =>
  buildApp().inject({ method: "POST", url: "/api/v1/topups", cookies: s.cookies, headers: { "idempotency-key": key }, payload });

async function debt(s: Setup, cents: number) {
  await withTenant(s.schoolId, (trx) =>
    postEntry(trx, { schoolId: s.schoolId, guardianId: s.guardianId, kind: "counter_charge", amountCents: -cents, sourceType: "counter_sale", sourceId: uuidv7(), minBalanceCents: null }),
  );
}

async function paymentOf(topupId: string) {
  return adminDb().selectFrom("payments").select(["id", "status", "providerChargeId", "amountCents"]).where("topupId", "=", topupId).executeTakeFirstOrThrow();
}

function webhook(schoolId: string, chargeId: string, amountCents: number, eventId: string = uuidv7()) {
  return buildApp().inject({
    method: "POST",
    url: `/webhooks/payments/fake/${schoolId}`,
    headers: { "content-type": "application/json", "x-fake-token": SECRET },
    payload: JSON.stringify({ id: eventId, event: "charge.paid", charge_id: chargeId, amount_cents: amountCents, paid_at: new Date(Date.now() - 1000).toISOString() }),
  });
}

describe("guardian top-ups", () => {
  it("creates a credit top-up with a Pix and cancels the previous pending one", async () => {
    const s = await setup();
    const first = await create(s, { purpose: "credit", amountCents: 2000 });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ status: "pending_payment", amountCents: 2000, balanceCents: 0, payment: { status: "pending", amountCents: 2000 } });
    expect(first.json().payment.pixCopyPaste).toMatch(/FAKE/);
    const second = await create(s, { purpose: "credit", amountCents: 3000 });
    expect(second.json().status).toBe("pending_payment");
    const old = await adminDb().selectFrom("topups").select(["status", "requestedBy"]).where("id", "=", first.json().id).executeTakeFirstOrThrow();
    expect(old).toEqual({ status: "cancelled", requestedBy: "guardian" });
    expect((await paymentOf(first.json().id)).status).toBe("expired");
    const { rows } = await sql<{ minutes: number }>`
      SELECT round(extract(epoch FROM expires_at - created_at) / 60)::int AS minutes FROM payments WHERE topup_id = ${second.json().id}`.execute(adminDb());
    expect(rows[0]!.minutes).toBe(60);
  });

  it("charges the current debt and refuses without one", async () => {
    const s = await setup();
    const none = await create(s, { purpose: "debt" });
    expect(none.statusCode).toBe(409);
    expect(none.json().error.code).toBe("wallet_no_debt");
    await debt(s, 1350);
    expect((await create(s, { purpose: "debt" })).json()).toMatchObject({ amountCents: 1350, balanceCents: -1350 });
    expect((await create(s, { purpose: "credit", amountCents: 999 })).statusCode).toBe(400);
  });

  it("credits the wallet once when the webhook confirms, even after the top-up was cancelled", async () => {
    const s = await setup();
    await debt(s, 500);
    const a = (await create(s, { purpose: "credit", amountCents: 2000 })).json();
    const b = (await create(s, { purpose: "credit", amountCents: 1000 })).json(); // cancela a
    const pa = await paymentOf(a.id);
    const pb = await paymentOf(b.id);
    const eventId = uuidv7();
    expect((await webhook(s.schoolId, pb.providerChargeId!, 1000, eventId)).statusCode).toBe(200);
    expect((await webhook(s.schoolId, pb.providerChargeId!, 1000, eventId)).statusCode).toBe(200);
    expect((await webhook(s.schoolId, pb.providerChargeId!, 1000)).statusCode).toBe(200);
    expect((await webhook(s.schoolId, pa.providerChargeId!, 2000)).statusCode).toBe(200); // pago depois de cancelada
    const topups = await adminDb().selectFrom("topups").select(["id", "status"]).where("guardianId", "=", s.guardianId).execute();
    expect(new Map(topups.map((t) => [t.id, t.status]))).toEqual(new Map([[a.id, "paid"], [b.id, "paid"]]));
    const credits = await adminDb().selectFrom("walletEntries").select("amountCents").where("schoolId", "=", s.schoolId).where("kind", "=", "topup_credit").orderBy("amountCents").execute();
    expect(credits).toEqual([{ amountCents: 1000 }, { amountCents: 2000 }]);
    const view = await buildApp().inject({ method: "GET", url: `/api/v1/topups/${b.id}`, cookies: s.cookies });
    expect(view.json()).toMatchObject({ status: "paid", balanceCents: 2500, payment: { status: "paid" } });
    const events = await adminDb()
      .selectFrom("outboxEvents")
      .select(sql<string>`data::text`.as("data"))
      .where("schoolId", "=", s.schoolId)
      .where("type", "=", "wallet.topup_confirmed")
      .orderBy("occurredAt")
      .execute();
    expect(events.map((e) => JSON.parse(e.data))).toEqual([
      expect.objectContaining({ amount_cents: 1000, wallet_balance_cents: 500, first_name: "Ana" }),
      expect.objectContaining({ amount_cents: 2000, wallet_balance_cents: 2500 }),
    ]);
    expect(await walletLedgerMatches(s.schoolId, s.guardianId)).toBe(true);
  });

  it("retries the charge when the gateway was down", async () => {
    const s = await setup();
    fakeFailNextCreate(1);
    const t = (await create(s, { purpose: "credit", amountCents: 2000 })).json();
    expect(t.payment.pixCopyPaste).toBeNull();
    const retried = await buildApp().inject({ method: "POST", url: `/api/v1/topups/${t.id}/charge`, cookies: s.cookies });
    expect(retried.json().payment.pixCopyPaste).toMatch(/FAKE/);
  });

  it("keeps top-ups private to their guardian and scope", async () => {
    const s = await setup();
    const t = (await create(s, { purpose: "credit", amountCents: 2000 })).json();
    const other = await seedFamily(s.schoolId, ["Bia"]);
    const get = async (cookies: Record<string, string>) => (await buildApp().inject({ method: "GET", url: `/api/v1/topups/${t.id}`, cookies })).statusCode;
    expect(await get(await guardianCookie(s.schoolId, other.guardianId))).toBe(404);
    expect(await get(await guardianCookie(s.schoolId, s.guardianId, "documents"))).toBe(403);
    expect(await get(await guardianCookie(s.schoolId, s.guardianId, "order"))).toBe(200);
  });

  it("keeps one pending top-up per guardian when several are created at once", async () => {
    const s = await setup();
    const results = await Promise.all([2000, 3000, 4000, 5000].map((amountCents) => create(s, { purpose: "credit", amountCents })));
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200, 200]);
    const rows = await adminDb().selectFrom("topups").select("status").where("guardianId", "=", s.guardianId).execute();
    expect(rows.map((r) => r.status).sort()).toEqual(["cancelled", "cancelled", "cancelled", "pending_payment"]);
    const payments = await adminDb()
      .selectFrom("payments")
      .innerJoin("topups", "topups.id", "payments.topupId")
      .select(["topups.status as topup", "payments.status as payment"])
      .where("topups.guardianId", "=", s.guardianId)
      .execute();
    expect(payments.map((p) => `${p.topup}:${p.payment}`).sort()).toEqual(["cancelled:expired", "cancelled:expired", "cancelled:expired", "pending_payment:pending"]);
  });

  it("refuses a second pending top-up for the same guardian in the database", async () => {
    const s = await setup();
    const t = (await create(s, { purpose: "credit", amountCents: 2000 })).json();
    await expect(
      adminDb().insertInto("topups").values({ id: uuidv7(), schoolId: s.schoolId, guardianId: s.guardianId, amountCents: 100, requestedBy: "staff" }).execute(),
    ).rejects.toThrow(/topups_one_pending/);
    expect(t.status).toBe("pending_payment");
  });

  it("neither reports nor announces a credit the ledger already had", async () => {
    const s = await setup();
    const t = (await create(s, { purpose: "credit", amountCents: 2000 })).json();
    const p = await paymentOf(t.id);
    await withTenant(s.schoolId, (trx) =>
      postEntry(trx, { schoolId: s.schoolId, guardianId: s.guardianId, kind: "topup_credit", amountCents: 2000, sourceType: "topup", sourceId: t.id }),
    );
    const outcome = await withTenant(s.schoolId, (trx) => confirmPayment(trx, { schoolId: s.schoolId, paymentId: p.id, paidAt: new Date() }));
    expect(outcome).toBe("already_processed");
    const events = await adminDb().selectFrom("outboxEvents").select("type").where("schoolId", "=", s.schoolId).where("type", "=", "wallet.topup_confirmed").execute();
    expect(events).toEqual([]);
    expect(await walletLedgerMatches(s.schoolId, s.guardianId)).toBe(true);
  });

  it("processes each event of a mixed webhook delivery in its own transaction", async () => {
    const s = await setup();
    const day = await seedServiceDay(s.schoolId);
    const checkout = await buildApp().inject({
      method: "POST",
      url: "/api/v1/checkouts",
      cookies: await guardianCookie(s.schoolId, s.guardianId),
      headers: { "idempotency-key": uuidv7() },
      payload: { serviceDate: day.serviceDate, orders: [{ studentId: (await adminDb().selectFrom("guardianStudents").select("studentId").where("guardianId", "=", s.guardianId).executeTakeFirstOrThrow()).studentId, items: [{ menuItemId: day.items[0]!.id, qty: 1 }] }] },
    });
    const cp = await adminDb().selectFrom("payments").select(["id", "providerChargeId", "amountCents"]).where("checkoutId", "=", checkout.json().id).executeTakeFirstOrThrow();
    const t = (await create(s, { purpose: "credit", amountCents: 2000 })).json();
    const tp = await paymentOf(t.id);
    const paidAt = new Date(Date.now() - 1000).toISOString();
    const event = (chargeId: string, amountCents: number) => ({ id: uuidv7(), event: "charge.paid", charge_id: chargeId, amount_cents: amountCents, paid_at: paidAt });
    const res = await buildApp().inject({
      method: "POST",
      url: `/webhooks/payments/fake/${s.schoolId}`,
      headers: { "content-type": "application/json", "x-fake-token": SECRET },
      payload: JSON.stringify([event(tp.providerChargeId!, 2000), event(cp.providerChargeId!, cp.amountCents)]),
    });
    expect(res.statusCode).toBe(200);
    expect((await adminDb().selectFrom("topups").select("status").where("id", "=", t.id).executeTakeFirstOrThrow()).status).toBe("paid");
    expect((await adminDb().selectFrom("checkouts").select("status").where("id", "=", checkout.json().id).executeTakeFirstOrThrow()).status).toBe("paid");
    const { rows } = await sql<{ tx: string }>`
      SELECT xmin::text AS tx FROM payment_events WHERE school_id = ${s.schoolId}`.execute(adminDb());
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.tx)).size).toBe(2);
  });

  it("refuses top-up amounts out of bounds", async () => {
    const s = await setup();
    expect((await create(s, { purpose: "credit", amountCents: 100_001 })).statusCode).toBe(400);
    expect((await create(s, { purpose: "credit", amountCents: 1500.5 })).statusCode).toBe(400);
    const { cookies } = await staffCookie(s.schoolId, "secretaria");
    for (const amountCents of [0, 1_000_001]) {
      const res = await buildApp().inject({
        method: "POST",
        url: `/api/admin/v1/guardians/${s.guardianId}/topups`,
        cookies,
        headers: { "idempotency-key": uuidv7() },
        payload: { amountCents },
      });
      expect(res.statusCode).toBe(400);
    }
    expect(await adminDb().selectFrom("topups").select("id").where("guardianId", "=", s.guardianId).execute()).toEqual([]);
  });
});

describe("staff top-ups", () => {
  it("shows a QR for any amount, also to the kitchen role, with audit", async () => {
    const s = await setup();
    const { cookies, staffUserId } = await staffCookie(s.schoolId, "cozinha");
    const res = await buildApp().inject({
      method: "POST",
      url: `/api/admin/v1/guardians/${s.guardianId}/topups`,
      cookies,
      headers: { "idempotency-key": uuidv7() },
      payload: { amountCents: 1350 },
    });
    expect(res.json()).toMatchObject({ status: "pending_payment", amountCents: 1350, payment: { status: "pending" } });
    const row = await adminDb().selectFrom("topups").select("requestedBy").where("id", "=", res.json().id).executeTakeFirstOrThrow();
    expect(row.requestedBy).toBe("staff");
    const view = await buildApp().inject({ method: "GET", url: `/api/admin/v1/topups/${res.json().id}`, cookies });
    expect(view.json().status).toBe("pending_payment");
    const audit = await adminDb().selectFrom("auditLog").select(["actorId", "action"]).where("schoolId", "=", s.schoolId).where("action", "=", "wallet.topup_requested").execute();
    expect(audit).toEqual([{ actorId: staffUserId, action: "wallet.topup_requested" }]);
    const unknown = await buildApp().inject({
      method: "POST",
      url: `/api/admin/v1/guardians/${uuidv7()}/topups`,
      cookies,
      headers: { "idempotency-key": uuidv7() },
      payload: { amountCents: 100 },
    });
    expect(unknown.statusCode).toBe(404);
  });
});
