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
    // A expirada há pouco segue conferida por 24 h (o Pix pode ter sido pago e o webhook perdido), sem efeito.
    expect(await reconcileDue({ log, schoolIds: [schoolId] })).toEqual({ schools: 1, confirmed: 0, expired: 0, failed: 0 });
    await adminDb().updateTable("topups").set({ createdAt: new Date(Date.now() - 25 * 3600_000) }).where("id", "=", stale.topupId).execute();
    expect(await reconcileDue({ log, schoolIds: [schoolId] })).toEqual({ schools: 0, confirmed: 0, expired: 0, failed: 0 });
  });

  it("also confirms cancelled and expired top-ups paid in the last 24 hours, but not older ones", async () => {
    const schoolId = await createSchool();
    const ana = await seedFamily(schoolId, ["Léo"]);
    const bruno = await seedFamily(schoolId, ["Caio"]);
    const carla = await seedFamily(schoolId, ["Duda"]);
    const cancelled = await topup(schoolId, ana.guardianId, 2000);
    const second = await topup(schoolId, ana.guardianId, 3000); // cancela a primeira
    const expired = await topup(schoolId, bruno.guardianId, 1500);
    await adminDb().updateTable("payments").set({ expiresAt: new Date(Date.now() - 60_000) }).where("id", "=", expired.paymentId).execute();
    const old = await topup(schoolId, carla.guardianId, 1000);
    await adminDb().updateTable("payments").set({ expiresAt: new Date(Date.now() - 60_000) }).where("id", "=", old.paymentId).execute();
    await adminDb().updateTable("payments").set({ expiresAt: new Date(Date.now() - 60_000) }).where("id", "=", second.paymentId).execute();
    expect(await reconcileDue({ log, schoolIds: [schoolId] })).toMatchObject({ confirmed: 0, expired: 3 });
    // Nenhuma recarga pendente: a escola continua na agenda pelas canceladas/expiradas recentes.
    await adminDb().updateTable("topups").set({ createdAt: new Date(Date.now() - 25 * 3600_000) }).where("id", "=", old.topupId).execute();

    for (const t of [cancelled, expired, old]) fakeMarkPaid(t.chargeId, new Date(Date.now() - 30_000));
    expect(await reconcileDue({ log, schoolIds: [schoolId] })).toMatchObject({ confirmed: 2, failed: 0 });
    const statuses = await adminDb().selectFrom("topups").select(["id", "status"]).where("id", "in", [cancelled.topupId, expired.topupId, old.topupId]).execute();
    expect(new Map(statuses.map((t) => [t.id, t.status]))).toEqual(
      new Map([[cancelled.topupId, "paid"], [expired.topupId, "paid"], [old.topupId, "expired"]]),
    );
    const balance = async (guardianId: string) =>
      (await adminDb().selectFrom("wallets").select("balanceCents").where("guardianId", "=", guardianId).executeTakeFirst())?.balanceCents ?? 0;
    expect([await balance(ana.guardianId), await balance(bruno.guardianId), await balance(carla.guardianId)]).toEqual([2000, 1500, 0]);
    expect(await walletLedgerMatches(schoolId, ana.guardianId)).toBe(true);
  });
});
