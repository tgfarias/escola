import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { afterEach, describe, expect, it } from "vitest";
import { adminDb, createSchool, guardianCookie, seedFamily, staffCookie, walletLedgerMatches } from "../../../test/helpers";
import { buildApp } from "../../app";
import { withTenant } from "../../db/index";
import { fakeFailNextCreate, fakeReset } from "../payments/fakeProvider";
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
