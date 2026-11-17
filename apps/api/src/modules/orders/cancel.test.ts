import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { afterEach, describe, expect, it } from "vitest";
import { adminDb, createSchool, guardianCookie, seedFamily, seedServiceDay, walletLedgerMatches } from "../../../test/helpers";
import { buildApp } from "../../app";
import { withTenant } from "../../db/index";
import { fakeReset } from "../payments/fakeProvider";
import { confirmPayment } from "../payments/service";
import { postEntry } from "../wallet/service";

afterEach(() => fakeReset());

async function setup(walletCents: number) {
  const schoolId = await createSchool();
  const family = await seedFamily(schoolId, ["Léo"]);
  const day = await seedServiceDay(schoolId);
  if (walletCents > 0) {
    await withTenant(schoolId, (trx) =>
      postEntry(trx, { schoolId, guardianId: family.guardianId, kind: "cancel_credit", amountCents: walletCents, sourceType: "checkout", sourceId: uuidv7() }),
    );
  }
  const cookies = await guardianCookie(schoolId, family.guardianId);
  const order = {
    serviceDate: day.serviceDate,
    orders: [{ studentId: family.studentIds[0]!, items: [{ menuItemId: day.items[0]!.id, qty: 1 }] }],
  };
  const create = () =>
    buildApp().inject({ method: "POST", url: "/api/v1/checkouts", cookies, headers: { "idempotency-key": uuidv7() }, payload: order });
  const cancel = (id: string, c = cookies) => buildApp().inject({ method: "POST", url: `/api/v1/checkouts/${id}/cancel`, cookies: c });
  return { schoolId, family, day, cookies, create, cancel };
}

const balance = async (guardianId: string) =>
  (await adminDb().selectFrom("wallets").select("balanceCents").where("guardianId", "=", guardianId).executeTakeFirstOrThrow()).balanceCents;

describe("POST /api/v1/checkouts/:id/cancel", () => {
  it("cancels a paid checkout into wallet credit and frees the student for a new order", async () => {
    const s = await setup(900);
    const paid = (await s.create()).json();
    expect(paid.status).toBe("paid");
    const res = await s.cancel(paid.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "cancelled", orders: [{ status: "cancelled" }] });
    expect(await balance(s.family.guardianId)).toBe(900);
    expect((await s.cancel(paid.id)).json().status).toBe("cancelled");
    expect(await balance(s.family.guardianId)).toBe(900);

    const again = (await s.create()).json();
    expect(again).toMatchObject({ status: "paid", walletAppliedCents: 900 });
    expect(await walletLedgerMatches(s.schoolId, s.family.guardianId)).toBe(true);
  });

  it("expires a pending checkout, releasing the hold and the payment", async () => {
    const s = await setup(300);
    const pending = (await s.create()).json();
    expect(pending).toMatchObject({ status: "pending_payment", walletAppliedCents: 300 });
    const res = await s.cancel(pending.id);
    expect(res.json()).toMatchObject({ status: "expired", orders: [{ status: "expired" }], payment: { status: "expired" } });
    expect(await balance(s.family.guardianId)).toBe(300);
    expect(await walletLedgerMatches(s.schoolId, s.family.guardianId)).toBe(true);
  });

  it("turns a Pix paid after cancelling into wallet credit", async () => {
    const s = await setup(0);
    const pending = (await s.create()).json();
    await s.cancel(pending.id);
    const payment = await adminDb().selectFrom("payments").select("id").where("checkoutId", "=", pending.id).executeTakeFirstOrThrow();
    const outcome = await withTenant(s.schoolId, (trx) =>
      confirmPayment(trx, { schoolId: s.schoolId, paymentId: payment.id, paidAt: new Date(Date.parse(pending.cutoffAt) - 60_000) }),
    );
    expect(outcome).toBe("late_credited");
    expect(await balance(s.family.guardianId)).toBe(900);
  });

  it("refuses after the cutoff, for late-credited checkouts and for other guardians", async () => {
    const s = await setup(900);
    const paid = (await s.create()).json();
    const stranger = await seedFamily(s.schoolId, ["Caio"]);
    expect((await s.cancel(paid.id, await guardianCookie(s.schoolId, stranger.guardianId))).statusCode).toBe(404);

    await sql`UPDATE service_days SET cutoff_at = now() - interval '1 minute', freeze_at = now() + interval '4 minutes' WHERE id = ${s.day.serviceDayId}`.execute(adminDb());
    const late = await s.cancel(paid.id);
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe("cutoff_passed");

    await sql`UPDATE checkouts SET status = 'late_credited' WHERE id = ${paid.id}`.execute(adminDb());
    expect((await s.cancel(paid.id)).json().error.code).toBe("checkout_not_cancellable");
  });
});
