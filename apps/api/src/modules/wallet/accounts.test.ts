import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { describe, expect, it } from "vitest";
import { adminDb, createSchool, kitchenCookie, seedFamily, staffCookie } from "../../../test/helpers";
import { buildApp } from "../../app";
import { withTenant } from "../../db/index";
import { applySales } from "../counter/service";

async function setup() {
  const schoolId = await createSchool();
  await adminDb().updateTable("schools").set({ debtLimitCents: 1000 }).where("id", "=", schoolId).execute();
  const ana = await seedFamily(schoolId, ["Léo", "Bia"]);
  const bruno = await seedFamily(schoolId, ["Caio"]);
  await adminDb().updateTable("guardians").set({ firstName: "Bruno" }).where("id", "=", bruno.guardianId).execute();
  const carla = await seedFamily(schoolId, ["Duda"]);
  await adminDb().updateTable("guardians").set({ firstName: "Carla" }).where("id", "=", carla.guardianId).execute();
  const misto = uuidv7();
  await adminDb().insertInto("menuItems").values({ id: misto, schoolId, name: `Misto ${misto.slice(-6)}`, priceCents: 900 }).execute();
  const { deviceId } = await kitchenCookie(schoolId);
  const sell = (studentId: string, qty = 1) =>
    withTenant(schoolId, async (trx) => {
      const id = uuidv7();
      await applySales(trx, schoolId, { source: "kitchen", deviceId }, [{ id, studentId, items: [{ menuItemId: misto, qty }], occurredAt: null }], "record");
      return id;
    });
  return { schoolId, ana, bruno, carla, sell, deviceId };
}

const get = (cookies: Record<string, string>, url: string) => buildApp().inject({ method: "GET", url, cookies });

describe("accounts", () => {
  it("lists every guardian with debts first, the students they pay for and recent over-limit sales", async () => {
    const s = await setup();
    await s.sell(s.ana.studentIds[0]!);
    const biaSale = await s.sell(s.ana.studentIds[1]!, 2); // -2700 < -1000: over_limit
    await s.sell(s.bruno.studentIds[0]!);
    const { cookies } = await staffCookie(s.schoolId, "cozinha");
    const res = await get(cookies, "/api/admin/v1/accounts");
    expect(res.statusCode).toBe(200);
    expect(res.json().debtLimitCents).toBe(1000);
    expect(res.json().accounts).toEqual([
      { guardianId: s.ana.guardianId, firstName: "Ana", students: ["Bia", "Léo"], balanceCents: -2700 },
      { guardianId: s.bruno.guardianId, firstName: "Bruno", students: ["Caio"], balanceCents: -900 },
      { guardianId: s.carla.guardianId, firstName: "Carla", students: ["Duda"], balanceCents: 0 },
    ]);
    expect(res.json().overLimitSales).toEqual([
      expect.objectContaining({ saleId: biaSale, guardianId: s.ana.guardianId, guardianFirstName: "Ana", studentFirstName: "Bia", totalCents: 1800 }),
    ]);
  });

  it("shows the statement with student names, over-limit flags and voids", async () => {
    const s = await setup();
    const leoSale = await s.sell(s.ana.studentIds[0]!);
    await s.sell(s.ana.studentIds[1]!);
    const office = await staffCookie(s.schoolId, "secretaria");
    await buildApp().inject({ method: "POST", url: `/api/admin/v1/counter-sales/${leoSale}/void`, cookies: office.cookies });
    const res = await get(office.cookies, `/api/admin/v1/guardians/${s.ana.guardianId}/statement`);
    expect(res.json()).toMatchObject({ guardian: { id: s.ana.guardianId, firstName: "Ana" }, balanceCents: -900, debtLimitCents: 1000 });
    expect(res.json().entries.map((e: { kind: string; studentFirstName: string | null; overLimit: boolean; voided: boolean; amountCents: number }) =>
      [e.kind, e.studentFirstName, e.amountCents, e.overLimit, e.voided])).toEqual([
      ["counter_void", "Léo", 900, false, true],
      ["counter_charge", "Bia", -900, true, false],
      ["counter_charge", "Léo", -900, false, true],
    ]);
    expect((await get(office.cookies, `/api/admin/v1/guardians/${uuidv7()}/statement`)).statusCode).toBe(404);
  });

  it("lets everyone on staff read the debt limit and only admins change it", async () => {
    const s = await setup();
    const admin = await staffCookie(s.schoolId, "admin");
    const office = await staffCookie(s.schoolId, "secretaria");
    const put = (cookies: Record<string, string>, payload: object) =>
      buildApp().inject({ method: "PUT", url: "/api/admin/v1/school/settings", cookies, payload });
    expect((await get(office.cookies, "/api/admin/v1/school/settings")).json()).toEqual({ debtLimitCents: 1000 });
    expect((await put(office.cookies, { debtLimitCents: 8000 })).statusCode).toBe(403);
    expect((await put(admin.cookies, { debtLimitCents: -1 })).statusCode).toBe(400);
    expect((await put(admin.cookies, { debtLimitCents: 8000 })).json()).toEqual({ debtLimitCents: 8000 });
    expect((await get(office.cookies, "/api/admin/v1/school/settings")).json()).toEqual({ debtLimitCents: 8000 });
    const audit = await adminDb()
      .selectFrom("auditLog")
      .select(["action", sql<string>`detail::text`.as("detail")])
      .where("schoolId", "=", s.schoolId)
      .where("action", "=", "school.debt_limit_changed")
      .execute();
    expect(audit.map((a) => JSON.parse(a.detail))).toEqual([{ previous_debt_limit_cents: 1000, debt_limit_cents: 8000 }]);
  });

  it("does not show another school's guardian in the list or the statement", async () => {
    const s = await setup();
    const otherSchool = await createSchool();
    const stranger = await seedFamily(otherSchool, ["Zeca"]);
    const office = await staffCookie(s.schoolId, "secretaria");
    const list = await get(office.cookies, "/api/admin/v1/accounts");
    expect(list.json().accounts.map((a: { guardianId: string }) => a.guardianId)).not.toContain(stranger.guardianId);
    expect((await get(office.cookies, `/api/admin/v1/guardians/${stranger.guardianId}/statement`)).statusCode).toBe(404);
  });
});
