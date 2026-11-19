import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { describe, expect, it } from "vitest";
import { adminDb, createSchool, seedFamily, staffCookie, walletLedgerMatches } from "../../../test/helpers";
import { buildApp } from "../../app";

async function setup(limitCents?: number) {
  const schoolId = await createSchool();
  if (limitCents !== undefined) await adminDb().updateTable("schools").set({ debtLimitCents: limitCents }).where("id", "=", schoolId).execute();
  const family = await seedFamily(schoolId, ["Léo", "Bia"]);
  const misto = uuidv7();
  const suco = uuidv7();
  await adminDb()
    .insertInto("menuItems")
    .values([
      { id: misto, schoolId, name: `Misto ${misto.slice(-6)}`, priceCents: 900 },
      { id: suco, schoolId, name: `Suco ${suco.slice(-6)}`, priceCents: 450 },
    ])
    .execute();
  const office = await staffCookie(schoolId, "secretaria");
  return { schoolId, guardianId: family.guardianId, leo: family.studentIds[0]!, bia: family.studentIds[1]!, misto, suco, office };
}

type Setup = Awaited<ReturnType<typeof setup>>;
const sell = (s: Setup, payload: object, key: string = uuidv7()) =>
  buildApp().inject({ method: "POST", url: "/api/admin/v1/counter-sales", cookies: s.office.cookies, headers: { "idempotency-key": key }, payload });
const voidSale = (s: Setup, saleId: string) =>
  buildApp().inject({ method: "POST", url: `/api/admin/v1/counter-sales/${saleId}/void`, cookies: s.office.cookies });

async function balance(guardianId: string): Promise<number> {
  const row = await adminDb().selectFrom("wallets").select("balanceCents").where("guardianId", "=", guardianId).executeTakeFirst();
  return row?.balanceCents ?? 0;
}

async function debtNotices(schoolId: string) {
  const rows = await adminDb()
    .selectFrom("outboxEvents")
    .select(sql<string>`data::text`.as("data"))
    .where("schoolId", "=", schoolId)
    .where("type", "=", "wallet.debt_notice")
    .execute();
  return rows.map((r) => JSON.parse(r.data) as { amount_due_cents: number; first_name: string });
}

describe("staff counter sales", () => {
  it("charges the financial guardian at the current server price and notices the start of the debt once", async () => {
    const s = await setup();
    await adminDb().updateTable("menuItems").set({ priceCents: 1000 }).where("id", "=", s.misto).execute();
    const res = await sell(s, { studentId: s.leo, items: [{ menuItemId: s.misto, qty: 2 }, { menuItemId: s.suco, qty: 1 }] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ totalCents: 2450, balanceCents: -2450, overLimit: false });
    const saleId = res.json().saleId as string;
    const sale = await adminDb().selectFrom("counterSales").selectAll().where("id", "=", saleId).executeTakeFirstOrThrow();
    expect(sale).toMatchObject({ guardianId: s.guardianId, source: "staff", staffUserId: s.office.staffUserId, deviceId: null, totalCents: 2450, overLimit: false });
    const items = await adminDb().selectFrom("counterSaleItems").select(["menuItemId", "qty", "unitPriceCents"]).where("saleId", "=", saleId).orderBy("unitPriceCents").execute();
    expect(items).toEqual([
      { menuItemId: s.suco, qty: 1, unitPriceCents: 450 },
      { menuItemId: s.misto, qty: 2, unitPriceCents: 1000 },
    ]);
    const entry = await adminDb().selectFrom("walletEntries").select(["id", "kind", "amountCents"]).where("id", "=", sale.walletEntryId).executeTakeFirstOrThrow();
    expect(entry).toMatchObject({ kind: "counter_charge", amountCents: -2450 });
    await sell(s, { studentId: s.bia, items: [{ menuItemId: s.suco, qty: 1 }] });
    expect(await debtNotices(s.schoolId)).toEqual([expect.objectContaining({ amount_due_cents: 2450, first_name: "Ana" })]);
    expect(await walletLedgerMatches(s.schoolId, s.guardianId)).toBe(true);
  });

  it("refuses over the limit without confirmation and records the sale flagged with it", async () => {
    const s = await setup(1000);
    const body = { studentId: s.leo, items: [{ menuItemId: s.misto, qty: 2 }] };
    const refused = await sell(s, body);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("insufficient_balance");
    expect(await adminDb().selectFrom("counterSales").select("id").where("schoolId", "=", s.schoolId).execute()).toEqual([]);
    const forced = await sell(s, { ...body, allowOverLimit: true });
    expect(forced.json()).toMatchObject({ totalCents: 1800, balanceCents: -1800, overLimit: true });
  });

  it("rejects inactive items, unknown students and students without a financial guardian", async () => {
    const s = await setup();
    await adminDb().updateTable("menuItems").set({ active: false }).where("id", "=", s.suco).execute();
    expect((await sell(s, { studentId: s.leo, items: [{ menuItemId: s.suco, qty: 1 }] })).json().error.code).toBe("invalid_order");
    expect((await sell(s, { studentId: uuidv7(), items: [{ menuItemId: s.misto, qty: 1 }] })).statusCode).toBe(422);
    await adminDb().updateTable("guardianStudents").set({ financial: false }).where("studentId", "=", s.bia).execute();
    expect((await sell(s, { studentId: s.bia, items: [{ menuItemId: s.misto, qty: 1 }] })).statusCode).toBe(422);
    expect(await balance(s.guardianId)).toBe(0);
  });

  it("replays the same Idempotency-Key without a second sale", async () => {
    const s = await setup();
    const key = uuidv7();
    const body = { studentId: s.leo, items: [{ menuItemId: s.misto, qty: 1 }] };
    const first = await sell(s, body, key);
    const again = await sell(s, body, key);
    expect(again.json()).toEqual(first.json());
    expect(await balance(s.guardianId)).toBe(-900);
  });

  it("voids once, crediting the sale's guardian, with audit", async () => {
    const s = await setup();
    const saleId = (await sell(s, { studentId: s.leo, items: [{ menuItemId: s.misto, qty: 1 }] })).json().saleId as string;
    const first = await voidSale(s, saleId);
    expect(first.json()).toEqual({ saleId, balanceCents: 0 });
    expect((await voidSale(s, saleId)).json()).toEqual({ saleId, balanceCents: 0 });
    const voids = await adminDb().selectFrom("walletEntries").select("amountCents").where("schoolId", "=", s.schoolId).where("kind", "=", "counter_void").execute();
    expect(voids).toEqual([{ amountCents: 900 }]);
    const sale = await adminDb().selectFrom("counterSales").select(["voidedAt", "voidEntryId"]).where("id", "=", saleId).executeTakeFirstOrThrow();
    expect(sale.voidedAt).not.toBeNull();
    const audit = await adminDb().selectFrom("auditLog").select("action").where("schoolId", "=", s.schoolId).where("action", "like", "counter.%").orderBy("createdAt").execute();
    expect(audit.map((a) => a.action)).toEqual(["counter.sale", "counter.void"]);
    expect((await voidSale(s, uuidv7())).statusCode).toBe(404);
    expect(await walletLedgerMatches(s.schoolId, s.guardianId)).toBe(true);
  });

  it("serves the roster to the office and keeps the kitchen role out of sales", async () => {
    const s = await setup();
    await adminDb().updateTable("menuItems").set({ active: false }).where("id", "=", s.suco).execute();
    const roster = await buildApp().inject({ method: "GET", url: "/api/admin/v1/counter/roster", cookies: s.office.cookies });
    expect(roster.json()).toMatchObject({ debtLimitCents: 5000, items: [{ id: s.misto, priceCents: 900 }] });
    expect(roster.json().students).toHaveLength(2);
    expect(roster.json().students[0].guardian).toMatchObject({ id: s.guardianId, firstName: "Ana", balanceCents: 0 });
    const kitchen = await staffCookie(s.schoolId, "cozinha");
    const res = await buildApp().inject({
      method: "POST",
      url: "/api/admin/v1/counter-sales",
      cookies: kitchen.cookies,
      headers: { "idempotency-key": uuidv7() },
      payload: { studentId: s.leo, items: [{ menuItemId: s.misto, qty: 1 }] },
    });
    expect(res.statusCode).toBe(403);
  });
});
