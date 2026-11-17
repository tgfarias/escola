import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { describe, expect, it } from "vitest";
import { adminDb, createSchool, guardianCookie, seedFamily, staffCookie, walletLedgerMatches as ledgerMatches } from "../../../test/helpers";
import { buildApp } from "../../app";
import { withTenant } from "../../db/index";
import { balanceOf, postEntry } from "./service";

describe("wallet ledger", () => {
  it("posts entries once per source and kind, keeping balance = sum of entries", async () => {
    const schoolId = await createSchool();
    const { guardianId } = await seedFamily(schoolId);
    const sourceId = uuidv7();
    const post = (kind: "cancel_credit" | "checkout_hold", amountCents: number, src = sourceId) =>
      withTenant(schoolId, (trx) => postEntry(trx, { schoolId, guardianId, kind, amountCents, sourceType: "checkout", sourceId: src }));

    expect(await post("cancel_credit", 1500)).toEqual({ posted: true, balanceCents: 1500 });
    expect(await post("cancel_credit", 1500)).toEqual({ posted: false, balanceCents: 1500 });
    expect(await post("checkout_hold", -900, uuidv7())).toEqual({ posted: true, balanceCents: 600 });
    expect(await withTenant(schoolId, (trx) => balanceOf(trx, guardianId))).toBe(600);
    expect(await ledgerMatches(schoolId, guardianId)).toBe(true);
  });

  it("refuses to go negative and leaves nothing behind", async () => {
    const schoolId = await createSchool();
    const { guardianId } = await seedFamily(schoolId);
    await expect(
      withTenant(schoolId, (trx) =>
        postEntry(trx, { schoolId, guardianId, kind: "checkout_hold", amountCents: -1, sourceType: "checkout", sourceId: uuidv7() }),
      ),
    ).rejects.toMatchObject({ code: "insufficient_balance" });
    const entries = await adminDb().selectFrom("walletEntries").select("id").where("schoolId", "=", schoolId).execute();
    expect(entries).toEqual([]);
  });

  it("serializes concurrent entries on the same wallet", async () => {
    const schoolId = await createSchool();
    const { guardianId } = await seedFamily(schoolId);
    await Promise.all(
      Array.from({ length: 10 }, () =>
        withTenant(schoolId, (trx) =>
          postEntry(trx, { schoolId, guardianId, kind: "cancel_credit", amountCents: 100, sourceType: "checkout", sourceId: uuidv7() }),
        ),
      ),
    );
    expect(await withTenant(schoolId, (trx) => balanceOf(trx, guardianId))).toBe(1000);
    expect(await ledgerMatches(schoolId, guardianId)).toBe(true);
  });
});

describe("wallet routes", () => {
  it("shows the guardian balance, entries and /me balance", async () => {
    const schoolId = await createSchool();
    const { guardianId } = await seedFamily(schoolId);
    await withTenant(schoolId, (trx) =>
      postEntry(trx, { schoolId, guardianId, kind: "cancel_credit", amountCents: 1200, sourceType: "checkout", sourceId: uuidv7() }),
    );
    const cookies = await guardianCookie(schoolId, guardianId);
    const wallet = await buildApp().inject({ method: "GET", url: "/api/v1/wallet", cookies });
    expect(wallet.json()).toMatchObject({ balanceCents: 1200, entries: [{ kind: "cancel_credit", amountCents: 1200 }] });
    const me = await buildApp().inject({ method: "GET", url: "/api/v1/me", cookies });
    expect(me.json().walletBalanceCents).toBe(1200);
  });

  it("lets an admin adjust a balance idempotently, with audit", async () => {
    const schoolId = await createSchool();
    const { guardianId } = await seedFamily(schoolId);
    const { cookies, staffUserId } = await staffCookie(schoolId, "admin");
    const k = uuidv7();
    const adjust = (payload: Record<string, unknown>, key = k) =>
      buildApp().inject({
        method: "POST",
        url: `/api/admin/v1/guardians/${guardianId}/wallet/adjustments`,
        cookies,
        headers: { "idempotency-key": key },
        payload,
      });
    expect((await adjust({ amountCents: 500, reason: "crédito de cortesia" })).json()).toEqual({ balanceCents: 500 });
    expect((await adjust({ amountCents: 500, reason: "crédito de cortesia" })).json()).toEqual({ balanceCents: 500 });
    const negative = await adjust({ amountCents: -600, reason: "correção" }, uuidv7());
    expect(negative.statusCode).toBe(409);
    expect(negative.json().error.code).toBe("insufficient_balance");

    const audit = await adminDb()
      .selectFrom("auditLog")
      .select(["actorId", "action", sql<string>`detail::text`.as("detail")])
      .where("schoolId", "=", schoolId)
      .where("action", "=", "wallet.adjust")
      .execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actorId).toBe(staffUserId);
    expect(JSON.parse(audit[0]!.detail)).toEqual({ guardian_id: guardianId, amount_cents: 500 });
  });

  it("restricts adjustments to admins and known guardians", async () => {
    const schoolId = await createSchool();
    const { guardianId } = await seedFamily(schoolId);
    const office = await staffCookie(schoolId, "secretaria");
    const admin = await staffCookie(schoolId, "admin");
    const call = (cookies: Record<string, string>, id: string) =>
      buildApp().inject({
        method: "POST",
        url: `/api/admin/v1/guardians/${id}/wallet/adjustments`,
        cookies,
        headers: { "idempotency-key": uuidv7() },
        payload: { amountCents: 100, reason: "x" },
      });
    expect((await call(office.cookies, guardianId)).statusCode).toBe(403);
    expect((await call(admin.cookies, uuidv7())).statusCode).toBe(404);
  });
});
