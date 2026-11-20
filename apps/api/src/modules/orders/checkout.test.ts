import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { afterEach, describe, expect, it } from "vitest";
import { adminDb, createSchool, guardianCookie, markDayClosed, seedFamily, seedServiceDay, walletLedgerMatches } from "../../../test/helpers";
import { buildApp } from "../../app";
import { withTenant } from "../../db/index";
import { fakeFailNextCreate, fakeReset } from "../payments/fakeProvider";
import { postEntry } from "../wallet/service";

afterEach(() => fakeReset());

async function setup(opts: { walletCents?: number; cutoffInMinutes?: number } = {}) {
  const schoolId = await createSchool();
  const family = await seedFamily(schoolId, ["Léo", "Bia"]);
  const day = await seedServiceDay(schoolId, { cutoffInMinutes: opts.cutoffInMinutes ?? 60 });
  if (opts.walletCents) {
    await withTenant(schoolId, (trx) =>
      postEntry(trx, {
        schoolId,
        guardianId: family.guardianId,
        kind: "cancel_credit",
        amountCents: opts.walletCents!,
        sourceType: "checkout",
        sourceId: uuidv7(),
      }),
    );
  }
  const cookies = await guardianCookie(schoolId, family.guardianId);
  const [misto, suco] = day.items;
  return { schoolId, family, day, cookies, misto: misto!, suco: suco! };
}

function post(cookies: Record<string, string>, payload: object, key: string = uuidv7()) {
  return buildApp().inject({ method: "POST", url: "/api/v1/checkouts", cookies, headers: { "idempotency-key": key }, payload });
}

const oneOrder = (s: Awaited<ReturnType<typeof setup>>, studentIndex = 0) => ({
  serviceDate: s.day.serviceDate,
  orders: [
    {
      studentId: s.family.studentIds[studentIndex]!,
      items: [
        { menuItemId: s.misto.id, qty: 1 },
        { menuItemId: s.suco.id, qty: 1 },
      ],
    },
  ],
});

async function outbox(schoolId: string, type: string) {
  const rows = await adminDb()
    .selectFrom("outboxEvents")
    .select(sql<string>`data::text`.as("data"))
    .where("schoolId", "=", schoolId)
    .where("type", "=", type)
    .execute();
  return rows.map((r) => JSON.parse(r.data));
}

describe("POST /api/v1/checkouts", () => {
  it("does not apply a negative balance: the Pix covers the whole total", async () => {
    const s = await setup();
    await withTenant(s.schoolId, (trx) =>
      postEntry(trx, {
        schoolId: s.schoolId,
        guardianId: s.family.guardianId,
        kind: "counter_charge",
        amountCents: -700,
        sourceType: "counter_sale",
        sourceId: uuidv7(),
        minBalanceCents: null,
      }),
    );
    const res = await post(s.cookies, oneOrder(s));
    expect(res.json()).toMatchObject({ status: "pending_payment", walletAppliedCents: 0 });
    expect(res.json().amountDueCents).toBe(res.json().totalCents);
    expect(await walletLedgerMatches(s.schoolId, s.family.guardianId)).toBe(true);
  });

  it("pays two children entirely from the wallet in one checkout", async () => {
    const s = await setup({ walletCents: 5000 });
    const res = await post(s.cookies, {
      serviceDate: s.day.serviceDate,
      orders: [
        { studentId: s.family.studentIds[0]!, items: [{ menuItemId: s.misto.id, qty: 2 }] },
        { studentId: s.family.studentIds[1]!, items: [{ menuItemId: s.suco.id, qty: 1 }] },
      ],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ status: "paid", totalCents: 2250, walletAppliedCents: 2250, amountDueCents: 0, payment: null });
    expect(body.orders.map((o: { status: string }) => o.status)).toEqual(["confirmed", "confirmed"]);
    const events = await outbox(s.schoolId, "payment.confirmed");
    expect(events).toEqual([
      expect.objectContaining({ checkout_id: body.id, students: ["Léo", "Bia"], total_cents: 2250, first_name: "Ana" }),
    ]);
    expect(await walletLedgerMatches(s.schoolId, s.family.guardianId)).toBe(true);
  });

  it("applies a partial balance and creates a Pix charge for the rest", async () => {
    const s = await setup({ walletCents: 500 });
    const res = await post(s.cookies, oneOrder(s));
    const body = res.json();
    expect(body).toMatchObject({ status: "pending_payment", totalCents: 1350, walletAppliedCents: 500, amountDueCents: 850 });
    expect(body.payment).toMatchObject({ status: "pending", amountCents: 850, expiresAt: body.cutoffAt });
    expect(body.payment.pixCopyPaste).toMatch(/^00020101FAKEfake_/);
    expect(body.orders[0].status).toBe("pending");
    const wallet = await adminDb().selectFrom("wallets").select("balanceCents").where("guardianId", "=", s.family.guardianId).executeTakeFirstOrThrow();
    expect(wallet.balanceCents).toBe(0);
    expect(await walletLedgerMatches(s.schoolId, s.family.guardianId)).toBe(true);
  });

  it("refuses after the cutoff and on a closed day", async () => {
    const late = await setup({ cutoffInMinutes: -1 });
    const res = await post(late.cookies, oneOrder(late));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("cutoff_passed");

    const closed = await setup();
    await markDayClosed(closed.day.serviceDayId);
    expect((await post(closed.cookies, oneOrder(closed))).json().error.code).toBe("cutoff_passed");
  });

  it("rejects another guardian's student, items off the menu and repeated students, writing nothing", async () => {
    const s = await setup();
    const stranger = await seedFamily(s.schoolId, ["Caio"]);
    const bad = [
      { serviceDate: s.day.serviceDate, orders: [{ studentId: stranger.studentIds[0]!, items: [{ menuItemId: s.misto.id, qty: 1 }] }] },
      { serviceDate: s.day.serviceDate, orders: [{ studentId: s.family.studentIds[0]!, items: [{ menuItemId: uuidv7(), qty: 1 }] }] },
      {
        serviceDate: s.day.serviceDate,
        orders: [
          { studentId: s.family.studentIds[0]!, items: [{ menuItemId: s.misto.id, qty: 1 }] },
          { studentId: s.family.studentIds[0]!, items: [{ menuItemId: s.suco.id, qty: 1 }] },
        ],
      },
    ];
    for (const payload of bad) {
      const res = await post(s.cookies, payload);
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("invalid_order");
    }
    const checkouts = await adminDb().selectFrom("checkouts").select("id").where("guardianId", "=", s.family.guardianId).execute();
    expect(checkouts).toEqual([]);
    const missingDay = await post(s.cookies, { ...oneOrder(s), serviceDate: "2031-01-01" });
    expect(missingDay.statusCode).toBe(404);
  });

  it("allows one active order per student, also across guardians", async () => {
    const s = await setup();
    expect((await post(s.cookies, oneOrder(s))).statusCode).toBe(200);
    const again = await post(s.cookies, oneOrder(s));
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("order_already_exists");

    const otherGuardian = await seedFamily(s.schoolId, []);
    await adminDb()
      .insertInto("guardianStudents")
      .values({ schoolId: s.schoolId, guardianId: otherGuardian.guardianId, studentId: s.family.studentIds[0]! })
      .execute();
    const other = await post(await guardianCookie(s.schoolId, otherGuardian.guardianId), oneOrder(s));
    expect(other.json().error.code).toBe("order_already_exists");
  });

  it("handles a double tap with different keys: one checkout wins", async () => {
    const s = await setup();
    const [a, b] = await Promise.all([post(s.cookies, oneOrder(s)), post(s.cookies, oneOrder(s))]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
  });

  it("replays the same Idempotency-Key and rejects it for a different body", async () => {
    const s = await setup({ walletCents: 500 });
    const key = uuidv7();
    const first = await post(s.cookies, oneOrder(s), key);
    const second = await post(s.cookies, oneOrder(s), key);
    expect(second.json().id).toBe(first.json().id);
    const holds = await adminDb().selectFrom("walletEntries").select("id").where("schoolId", "=", s.schoolId).where("kind", "=", "checkout_hold").execute();
    expect(holds).toHaveLength(1);
    const reused = await post(s.cookies, oneOrder(s, 1), key);
    expect(reused.statusCode).toBe(422);
    expect(reused.json().error.code).toBe("idempotency_key_reused");
    const missing = await buildApp().inject({ method: "POST", url: "/api/v1/checkouts", cookies: s.cookies, payload: oneOrder(s) });
    expect(missing.json().error.code).toBe("idempotency_key_required");
  });

  it("keeps the checkout when the gateway is down and creates the charge on retry", async () => {
    const s = await setup();
    const key = uuidv7();
    fakeFailNextCreate();
    const first = await post(s.cookies, oneOrder(s), key);
    expect(first.statusCode).toBe(200);
    expect(first.json().payment).toMatchObject({ status: "pending", pixCopyPaste: null });
    const retry = await post(s.cookies, oneOrder(s), key);
    expect(retry.json().payment.pixCopyPaste).toMatch(/^00020101FAKE/);
  });

  it("does not create a charge on replay once the cutoff has passed", async () => {
    const s = await setup();
    const key = uuidv7();
    fakeFailNextCreate();
    const first = (await post(s.cookies, oneOrder(s), key)).json();
    await sql`UPDATE payments SET expires_at = now() - interval '1 minute' WHERE checkout_id = ${first.id}`.execute(adminDb());
    const replay = await post(s.cookies, oneOrder(s), key);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().payment.pixCopyPaste).toBeNull();
    const row = await adminDb().selectFrom("payments").select("providerChargeId").where("checkoutId", "=", first.id).executeTakeFirstOrThrow();
    expect(row.providerChargeId).toBeNull();
  });
});

describe("POST /api/v1/checkouts/:id/charge", () => {
  const charge = (id: string, cookies: Record<string, string>) =>
    buildApp().inject({ method: "POST", url: `/api/v1/checkouts/${id}/charge`, cookies });

  it("creates the missing Pix for the checkout's guardian only", async () => {
    const s = await setup();
    fakeFailNextCreate();
    const created = (await post(s.cookies, oneOrder(s))).json();
    expect(created.payment.pixCopyPaste).toBeNull();

    const stranger = await seedFamily(s.schoolId, ["Caio"]);
    const denied = await charge(created.id, await guardianCookie(s.schoolId, stranger.guardianId));
    expect(denied.statusCode).toBe(404);

    const res = await charge(created.id, s.cookies);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: created.id, status: "pending_payment", payment: { pixCopyPaste: expect.stringMatching(/^00020101FAKE/) } });
    expect((await charge(created.id, s.cookies)).json()).toEqual(res.json());
  });

  it("answers without a Pix when the charge cannot be stored, and stores it on the next retry", async () => {
    const s = await setup();
    fakeFailNextCreate(2);
    const first = (await post(s.cookies, oneOrder(s, 0))).json();
    const other = (await post(s.cookies, oneOrder(s, 1))).json();
    const payment = await adminDb().selectFrom("payments").select("id").where("checkoutId", "=", first.id).executeTakeFirstOrThrow();
    // Another payment already holds the charge id the gateway will return, so attaching it fails.
    await sql`UPDATE payments SET provider_charge_id = ${`fake_${payment.id}`} WHERE checkout_id = ${other.id}`.execute(adminDb());

    const failed = await charge(first.id, s.cookies);
    expect(failed.statusCode).toBe(200);
    expect(failed.json().payment.pixCopyPaste).toBeNull();

    await sql`UPDATE payments SET provider_charge_id = NULL WHERE checkout_id = ${other.id}`.execute(adminDb());
    expect((await charge(first.id, s.cookies)).json().payment.pixCopyPaste).toBe(`00020101FAKEfake_${payment.id}`);
  });
});

describe("GET /api/v1/checkouts", () => {
  it("returns a checkout only to its guardian and lists by date", async () => {
    const s = await setup();
    const created = (await post(s.cookies, oneOrder(s))).json();
    const got = await buildApp().inject({ method: "GET", url: `/api/v1/checkouts/${created.id}`, cookies: s.cookies });
    expect(got.json()).toEqual(created);

    const stranger = await seedFamily(s.schoolId, ["Caio"]);
    const denied = await buildApp().inject({
      method: "GET",
      url: `/api/v1/checkouts/${created.id}`,
      cookies: await guardianCookie(s.schoolId, stranger.guardianId),
    });
    expect(denied.statusCode).toBe(404);

    const list = await buildApp().inject({ method: "GET", url: `/api/v1/checkouts?serviceDate=${s.day.serviceDate}`, cookies: s.cookies });
    expect(list.json()).toEqual({ checkouts: [created] });
  });
});
