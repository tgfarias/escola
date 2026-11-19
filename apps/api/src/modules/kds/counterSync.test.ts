import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { describe, expect, it } from "vitest";
import { adminDb, createSchool, kitchenCookie, seedFamily, staffCookie, walletLedgerMatches } from "../../../test/helpers";
import { buildApp } from "../../app";
import { SESSION_COOKIE } from "../../platform/session";

async function setup(limitCents?: number) {
  const schoolId = await createSchool();
  if (limitCents !== undefined) await adminDb().updateTable("schools").set({ debtLimitCents: limitCents }).where("id", "=", schoolId).execute();
  const fam = await seedFamily(schoolId, ["Léo", "Bia"]);
  const misto = uuidv7();
  const suco = uuidv7();
  await adminDb()
    .insertInto("menuItems")
    .values([
      { id: misto, schoolId, name: `Misto ${misto.slice(-6)}`, priceCents: 900 },
      { id: suco, schoolId, name: `Suco ${suco.slice(-6)}`, priceCents: 450 },
    ])
    .execute();
  const tablet = await kitchenCookie(schoolId);
  return { schoolId, guardianId: fam.guardianId, leo: fam.studentIds[0]!, bia: fam.studentIds[1]!, misto, suco, cookies: tablet.cookies };
}

type Setup = Awaited<ReturnType<typeof setup>>;
// Instantes do tablet sempre no passado recente (o servidor limita a 5 min à frente).
const at = (secondsAgo = 1) => new Date(Date.now() - secondsAgo * 1000).toISOString();
const sale = (studentId: string, menuItemId: string, qty = 1, id: string = uuidv7()) => ({ id, studentId, items: [{ menuItemId, qty }], occurredAt: at() });
const push = (s: Setup, sales: object[], cookies = s.cookies) =>
  buildApp().inject({ method: "POST", url: "/api/kds/v1/counter-sales", cookies, payload: { sales } });
const pushVoids = (s: Setup, voids: object[]) => buildApp().inject({ method: "POST", url: "/api/kds/v1/counter-voids", cookies: s.cookies, payload: { voids } });

async function balance(guardianId: string) {
  return (await adminDb().selectFrom("wallets").select("balanceCents").where("guardianId", "=", guardianId).executeTakeFirst())?.balanceCents ?? 0;
}

describe("kds roster", () => {
  it("lists active students with consented restrictions, the financial guardian's balance, the limit and active items", async () => {
    const s = await setup(3000);
    await adminDb().updateTable("students").set({ dietaryRestrictions: "sem lactose" }).where("id", "in", [s.leo, s.bia]).execute();
    await adminDb().updateTable("guardianStudents").set({ restrictionConsentAt: new Date() }).where("studentId", "=", s.leo).execute();
    await adminDb().updateTable("guardianStudents").set({ financial: false }).where("studentId", "=", s.bia).execute();
    await adminDb().updateTable("menuItems").set({ active: false }).where("id", "=", s.suco).execute();
    const res = await buildApp().inject({ method: "GET", url: "/api/kds/v1/roster", cookies: s.cookies });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.debtLimitCents).toBe(3000);
    expect(body.items).toEqual([{ id: s.misto, name: expect.any(String), priceCents: 900 }]);
    const byId = Object.fromEntries(body.students.map((st: { id: string }) => [st.id, st]));
    expect(byId[s.leo]).toMatchObject({ firstName: "Léo", restrictions: "sem lactose", guardian: { id: s.guardianId, firstName: "Ana", balanceCents: 0 } });
    expect(byId[s.bia]).toMatchObject({ firstName: "Bia", restrictions: null, guardian: null });
    expect(res.cookies.find((c) => c.name === SESSION_COOKIE)?.maxAge).toBe((30 + 90) * 86400);
  });
});

describe("kds counter sync", () => {
  it("charges once per sale id, also on replay", async () => {
    const s = await setup();
    const batch = [sale(s.leo, s.misto), sale(s.bia, s.suco, 2)];
    const first = await push(s, batch);
    expect(first.json()).toEqual({ accepted: batch.map((b) => b.id), rejected: [] });
    expect((await push(s, batch)).json()).toEqual({ accepted: batch.map((b) => b.id), rejected: [] });
    expect(await balance(s.guardianId)).toBe(-1800);
    const charges = await adminDb().selectFrom("walletEntries").select("id").where("schoolId", "=", s.schoolId).where("kind", "=", "counter_charge").execute();
    expect(charges).toHaveLength(2);
    expect(await walletLedgerMatches(s.schoolId, s.guardianId)).toBe(true);
  });

  it("rejects unknown or inactive students and items, and students without a financial guardian", async () => {
    const s = await setup();
    await adminDb().updateTable("menuItems").set({ active: false }).where("id", "=", s.suco).execute();
    await adminDb().updateTable("guardianStudents").set({ financial: false }).where("studentId", "=", s.bia).execute();
    const bad = [sale(uuidv7(), s.misto), sale(s.leo, s.suco), sale(s.leo, uuidv7()), sale(s.bia, s.misto)];
    const ok = sale(s.leo, s.misto);
    const res = await push(s, [...bad, ok]);
    expect(res.json()).toEqual({ accepted: [ok.id], rejected: bad.map((b) => b.id) });
    expect(await balance(s.guardianId)).toBe(-900);
  });

  it("always records an offline sale, flagging it over the limit", async () => {
    const s = await setup(1000);
    const big = sale(s.leo, s.misto, 2);
    expect((await push(s, [big])).json().accepted).toEqual([big.id]);
    const row = await adminDb().selectFrom("counterSales").select(["overLimit", "source"]).where("id", "=", big.id).executeTakeFirstOrThrow();
    expect(row).toEqual({ overLimit: true, source: "kitchen" });
    expect(await balance(s.guardianId)).toBe(-1800);
  });

  it("limits occurred_at to 5 minutes ahead of the database clock", async () => {
    const s = await setup();
    const future = { ...sale(s.leo, s.misto), occurredAt: new Date(Date.now() + 3_600_000).toISOString() };
    await push(s, [future]);
    const { rows } = await sql<{ ok: boolean }>`SELECT occurred_at <= now() + interval '5 minutes' AS ok FROM counter_sales WHERE id = ${future.id}`.execute(adminDb());
    expect(rows[0]!.ok).toBe(true);
  });

  it("voids the tablet's own sales of the same day once, and nothing else", async () => {
    const s = await setup();
    const mine = sale(s.leo, s.misto);
    const old = sale(s.bia, s.misto);
    await push(s, [mine, old]);
    await adminDb().updateTable("counterSales").set({ occurredAt: sql<Date>`now() - interval '2 days'` }).where("id", "=", old.id).execute();
    const office = await staffCookie(s.schoolId, "secretaria");
    const staffSale = await buildApp().inject({
      method: "POST",
      url: "/api/admin/v1/counter-sales",
      cookies: office.cookies,
      headers: { "idempotency-key": uuidv7() },
      payload: { studentId: s.leo, items: [{ menuItemId: s.suco, qty: 1 }] },
    });
    const staffSaleId = staffSale.json().saleId as string;
    const unknown = uuidv7();
    const voids = [mine.id, old.id, staffSaleId, unknown].map((saleId) => ({ saleId, occurredAt: at() }));
    expect((await pushVoids(s, voids)).json()).toEqual({ accepted: [mine.id], rejected: [old.id, staffSaleId, unknown] });
    expect((await pushVoids(s, [{ saleId: mine.id, occurredAt: at() }])).json()).toEqual({ accepted: [mine.id], rejected: [] });
    const voidEntries = await adminDb().selectFrom("walletEntries").select("amountCents").where("schoolId", "=", s.schoolId).where("kind", "=", "counter_void").execute();
    expect(voidEntries).toEqual([{ amountCents: 900 }]);
    expect(await walletLedgerMatches(s.schoolId, s.guardianId)).toBe(true);
  });

  it("applies batches from two tablets on the same wallets concurrently", async () => {
    const s = await setup();
    const other = await seedFamily(s.schoolId, ["Caio"]);
    const second = await kitchenCookie(s.schoolId);
    const caio = other.studentIds[0]!;
    const a = [sale(s.leo, s.misto), sale(caio, s.misto)];
    const b = [sale(caio, s.suco), sale(s.bia, s.suco)];
    const [ra, rb] = await Promise.all([push(s, a), push(s, b, second.cookies)]);
    expect(ra.json().rejected).toEqual([]);
    expect(rb.json().rejected).toEqual([]);
    expect(await balance(s.guardianId)).toBe(-1350);
    expect(await balance(other.guardianId)).toBe(-1350);
    expect(await walletLedgerMatches(s.schoolId, s.guardianId)).toBe(true);
    expect(await walletLedgerMatches(s.schoolId, other.guardianId)).toBe(true);
  });
});
