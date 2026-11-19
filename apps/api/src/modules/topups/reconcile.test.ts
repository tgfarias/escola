import { uuidv7 } from "uuidv7";
import { afterEach, describe, expect, it } from "vitest";
import { adminDb, createSchool, guardianCookie, seedFamily, walletLedgerMatches } from "../../../test/helpers";
import { buildApp } from "../../app";
import { fakeMarkPaid, fakeReset } from "../payments/fakeProvider";
import { reconcileDue } from "./service";

const log = { warn: () => undefined, info: () => undefined, error: () => undefined } as never;
afterEach(() => fakeReset());

async function topup(schoolId: string, guardianId: string, amountCents: number) {
  const res = await buildApp().inject({
    method: "POST",
    url: "/api/v1/topups",
    cookies: await guardianCookie(schoolId, guardianId, "wallet"),
    headers: { "idempotency-key": uuidv7() },
    payload: { purpose: "credit", amountCents },
  });
  const payment = await adminDb().selectFrom("payments").select(["id", "providerChargeId"]).where("topupId", "=", res.json().id).executeTakeFirstOrThrow();
  return { topupId: res.json().id as string, paymentId: payment.id, chargeId: payment.providerChargeId! };
}

describe("top-up reconciliation job", () => {
  it("confirms paid charges, expires overdue top-ups and then has nothing to do", async () => {
    const schoolId = await createSchool();
    const ana = await seedFamily(schoolId, ["Léo"]);
    const bruno = await seedFamily(schoolId, ["Caio"]);
    const paid = await topup(schoolId, ana.guardianId, 2000);
    const stale = await topup(schoolId, bruno.guardianId, 1500);
    fakeMarkPaid(paid.chargeId, new Date(Date.now() - 60_000));
    await adminDb().updateTable("payments").set({ expiresAt: new Date(Date.now() - 60_000) }).where("id", "=", stale.paymentId).execute();

    expect(await reconcileDue({ log, schoolIds: [schoolId] })).toEqual({ schools: 1, confirmed: 1, expired: 1, failed: 0 });
    const statuses = await adminDb().selectFrom("topups").select(["id", "status"]).where("schoolId", "=", schoolId).execute();
    expect(new Map(statuses.map((t) => [t.id, t.status]))).toEqual(new Map([[paid.topupId, "paid"], [stale.topupId, "expired"]]));
    const stalePayment = await adminDb().selectFrom("payments").select("status").where("id", "=", stale.paymentId).executeTakeFirstOrThrow();
    expect(stalePayment.status).toBe("expired");
    const wallet = await adminDb().selectFrom("wallets").select("balanceCents").where("guardianId", "=", ana.guardianId).executeTakeFirstOrThrow();
    expect(wallet.balanceCents).toBe(2000);
    expect(await walletLedgerMatches(schoolId, ana.guardianId)).toBe(true);
    expect(await reconcileDue({ log, schoolIds: [schoolId] })).toEqual({ schools: 0, confirmed: 0, expired: 0, failed: 0 });
  });
});
