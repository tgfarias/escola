import { uuidv7 } from "uuidv7";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adminDb, createSchool, guardianCookie, seedFamily, seedServiceDay } from "../../../test/helpers";
import { buildApp } from "../../app";
import * as repo from "../payments/repo";
import { fakeReset } from "../payments/fakeProvider";

const SECRET = process.env.PAYMENT_WEBHOOK_SECRET_TEST!;

afterEach(() => {
  vi.restoreAllMocks();
  fakeReset();
});

async function pendingPayment() {
  const schoolId = await createSchool();
  await adminDb().updateTable("schools").set({ paymentWebhookSecretRef: "PAYMENT_WEBHOOK_SECRET_TEST" }).where("id", "=", schoolId).execute();
  const family = await seedFamily(schoolId, ["Léo"]);
  const day = await seedServiceDay(schoolId);
  const res = await buildApp().inject({
    method: "POST",
    url: "/api/v1/checkouts",
    cookies: await guardianCookie(schoolId, family.guardianId),
    headers: { "idempotency-key": uuidv7() },
    payload: { serviceDate: day.serviceDate, orders: [{ studentId: family.studentIds[0]!, items: [{ menuItemId: day.items[0]!.id, qty: 1 }] }] },
  });
  const payment = await adminDb()
    .selectFrom("payments")
    .select(["id", "providerChargeId", "amountCents", "expiresAt"])
    .where("checkoutId", "=", res.json().id)
    .executeTakeFirstOrThrow();
  return { schoolId, checkoutId: res.json().id as string, payment };
}

function send(schoolId: string, body: Record<string, unknown>, opts: { token?: string; provider?: string } = {}) {
  return buildApp().inject({
    method: "POST",
    url: `/webhooks/payments/${opts.provider ?? "fake"}/${schoolId}`,
    headers: { "content-type": "application/json", "x-fake-token": opts.token ?? SECRET },
    payload: JSON.stringify(body),
  });
}

const paid = (p: Awaited<ReturnType<typeof pendingPayment>>, id = uuidv7(), amount = p.payment.amountCents) => ({
  id,
  event: "charge.paid",
  charge_id: p.payment.providerChargeId,
  amount_cents: amount,
  paid_at: new Date(p.payment.expiresAt.getTime() - 60_000).toISOString(),
});

async function checkoutStatus(id: string) {
  return (await adminDb().selectFrom("checkouts").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status;
}

async function eventCount(schoolId: string) {
  return (await adminDb().selectFrom("paymentEvents").select("id").where("schoolId", "=", schoolId).execute()).length;
}

describe("payment webhook", () => {
  it("confirms a paid charge and stores the raw event", async () => {
    const p = await pendingPayment();
    const res = await send(p.schoolId, paid(p));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
    expect(await checkoutStatus(p.checkoutId)).toBe("paid");
    expect(await eventCount(p.schoolId)).toBe(1);
  });

  it("answers 200 without reprocessing a repeated event, also concurrently", async () => {
    const p = await pendingPayment();
    const body = paid(p);
    const [a, b] = await Promise.all([send(p.schoolId, body), send(p.schoolId, body)]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect((await send(p.schoolId, body)).statusCode).toBe(200);
    expect(await eventCount(p.schoolId)).toBe(1);
    const confirmed = await adminDb().selectFrom("outboxEvents").select("id").where("schoolId", "=", p.schoolId).where("type", "=", "payment.confirmed").execute();
    expect(confirmed).toHaveLength(1);
  });

  it("handles out-of-order and second paid events without double effects", async () => {
    const p = await pendingPayment();
    await send(p.schoolId, paid(p));
    expect((await send(p.schoolId, { id: uuidv7(), event: "charge.created", charge_id: p.payment.providerChargeId })).statusCode).toBe(200);
    expect((await send(p.schoolId, paid(p))).statusCode).toBe(200);
    expect(await checkoutStatus(p.checkoutId)).toBe("paid");
    const credits = await adminDb().selectFrom("walletEntries").select("id").where("schoolId", "=", p.schoolId).execute();
    expect(credits).toEqual([]);
  });

  it("does not confirm when the amount differs", async () => {
    const p = await pendingPayment();
    const res = await send(p.schoolId, paid(p, uuidv7(), p.payment.amountCents + 1));
    expect(res.statusCode).toBe(200);
    expect(await checkoutStatus(p.checkoutId)).toBe("pending_payment");
    expect(await eventCount(p.schoolId)).toBe(1);
  });

  it("rejects a wrong token, another school's token and unknown schools, storing nothing", async () => {
    const p = await pendingPayment();
    expect((await send(p.schoolId, paid(p), { token: "x".repeat(40) })).statusCode).toBe(401);
    const other = await createSchool();
    process.env.PAYMENT_WEBHOOK_SECRET_OTHER = "other-school-webhook-secret-with-32-chars";
    await adminDb().updateTable("schools").set({ paymentWebhookSecretRef: "PAYMENT_WEBHOOK_SECRET_OTHER" }).where("id", "=", other).execute();
    expect((await send(other, paid(p))).statusCode).toBe(401);
    expect(await eventCount(other)).toBe(0);
    expect((await send(uuidv7(), paid(p))).statusCode).toBe(401);
    expect((await send("not-a-uuid", paid(p))).statusCode).toBe(401);
    expect((await send(p.schoolId, paid(p), { provider: "nope" })).statusCode).toBe(404);
    expect(await eventCount(p.schoolId)).toBe(0);
    expect(await checkoutStatus(p.checkoutId)).toBe("pending_payment");
  });

  it("accepts an event for an unknown charge without effects", async () => {
    const p = await pendingPayment();
    const res = await send(p.schoolId, { ...paid(p), charge_id: "fake_unknown" });
    expect(res.statusCode).toBe(200);
    expect(await checkoutStatus(p.checkoutId)).toBe("pending_payment");
  });

  it("answers 500, not 401, when reading the school config fails", async () => {
    const p = await pendingPayment();
    vi.spyOn(repo, "findSchoolPaymentConfig").mockRejectedValueOnce(new Error("connection lost"));
    const res = await send(p.schoolId, paid(p));
    expect(res.statusCode).toBe(500);
    expect(await eventCount(p.schoolId)).toBe(0);
  });
});
