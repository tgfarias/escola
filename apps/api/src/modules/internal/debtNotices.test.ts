import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { describe, expect, it } from "vitest";
import { adminDb, createSchool, internalRequest, seedFamily, staffCookie, zoneAtLocalHour } from "../../../test/helpers";
import { buildApp } from "../../app";
import { withTenant } from "../../db/index";
import { listDueActions } from "../serviceDays/service";
import { postEntry } from "../wallet/service";

// Hours 12 (inside 09:00-19:00) and 3 (outside) sit far from the boundaries, so the JS clock used by
// zoneAtLocalHour and the database now() cannot disagree across an hour edge during a test run.
async function indebted(cents = 700) {
  const schoolId = await createSchool();
  await adminDb().updateTable("schools").set({ timezone: zoneAtLocalHour(12) }).where("id", "=", schoolId).execute();
  const fam = await seedFamily(schoolId, ["Léo"]);
  await withTenant(schoolId, (trx) =>
    postEntry(trx, { schoolId, guardianId: fam.guardianId, kind: "counter_charge", amountCents: -cents, sourceType: "counter_sale", sourceId: uuidv7(), minBalanceCents: null }),
  );
  return { schoolId, guardianId: fam.guardianId };
}

const mine = async (schoolId: string) => (await listDueActions()).filter((d) => d.schoolId === schoolId).map((d) => d.action);
const setNoticeAgo = (guardianId: string, interval: string) =>
  adminDb().updateTable("wallets").set({ debtNoticeAt: sql<Date>`now() - ${interval}::interval` }).where("guardianId", "=", guardianId).execute();

describe("debt notices", () => {
  it("are due for a negative wallet not noticed in 3 days, only in local business hours", async () => {
    const s = await indebted();
    expect(await mine(s.schoolId)).toEqual(["send_debt_notices"]);
    await setNoticeAgo(s.guardianId, "2 days");
    expect(await mine(s.schoolId)).toEqual([]);
    await setNoticeAgo(s.guardianId, "3 days 1 minute");
    expect(await mine(s.schoolId)).toEqual(["send_debt_notices"]);
    await adminDb().updateTable("schools").set({ timezone: zoneAtLocalHour(3) }).where("id", "=", s.schoolId).execute();
    expect(await mine(s.schoolId)).toEqual([]);
  });

  it("are listed to n8n and enqueued once per due wallet by the internal route", async () => {
    const s = await indebted(1350);
    const app = buildApp();
    const due = await app.inject(internalRequest("GET", "/internal/v1/schedule/due"));
    expect(due.json().due.filter((d: { school_id: string }) => d.school_id === s.schoolId)).toEqual([
      { action: "send_debt_notices", school_id: s.schoolId, service_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) },
    ]);
    const url = `/internal/v1/schools/${s.schoolId}/debt-notices`;
    expect((await app.inject(internalRequest("POST", url))).json()).toEqual({ enqueued: 1 });
    expect((await app.inject(internalRequest("POST", url))).json()).toEqual({ enqueued: 0 });
    const events = await adminDb().selectFrom("outboxEvents").select(sql<string>`data::text`.as("data")).where("schoolId", "=", s.schoolId).where("type", "=", "wallet.debt_notice").execute();
    expect(events.map((e) => JSON.parse(e.data))).toEqual([expect.objectContaining({ guardian_id: s.guardianId, amount_due_cents: 1350 })]);
  });

  it("hides the top-up reconciliation from n8n", async () => {
    const schoolId = await createSchool();
    const fam = await seedFamily(schoolId, ["Léo"]);
    await adminDb().insertInto("topups").values({ id: uuidv7(), schoolId, guardianId: fam.guardianId, amountCents: 1000, requestedBy: "guardian" }).execute();
    expect(await mine(schoolId)).toEqual(["reconcile_topups"]);
    const due = await buildApp().inject(internalRequest("GET", "/internal/v1/schedule/due"));
    expect(due.json().due.filter((d: { school_id: string }) => d.school_id === schoolId)).toEqual([]);
  });
});

describe("payment requests", () => {
  it("sends the payment link once per key, only with a debt", async () => {
    const s = await indebted(1350);
    const { cookies } = await staffCookie(s.schoolId, "cozinha");
    const key = uuidv7();
    const ask = (guardianId: string, k: string = key) =>
      buildApp().inject({ method: "POST", url: `/api/admin/v1/guardians/${guardianId}/payment-requests`, cookies, headers: { "idempotency-key": k } });
    expect((await ask(s.guardianId)).json()).toEqual({ amountDueCents: 1350 });
    expect((await ask(s.guardianId)).json()).toEqual({ amountDueCents: 1350 });
    const events = await adminDb().selectFrom("outboxEvents").select("type").where("schoolId", "=", s.schoolId).where("type", "=", "wallet.payment_requested").execute();
    expect(events).toHaveLength(1);
    const other = await seedFamily(s.schoolId, ["Bia"]);
    const none = await ask(other.guardianId, uuidv7());
    expect(none.statusCode).toBe(409);
    expect(none.json().error.code).toBe("wallet_no_debt");
    expect((await ask(uuidv7(), uuidv7())).statusCode).toBe(404);
  });
});
