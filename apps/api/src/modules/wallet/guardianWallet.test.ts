import { uuidv7 } from "uuidv7";
import { describe, expect, it } from "vitest";
import { adminDb, createSchool, guardianCookie, kitchenCookie, seedFamily } from "../../../test/helpers";
import { buildApp } from "../../app";
import { withTenant } from "../../db/index";
import { applySales, voidSales } from "../counter/service";

describe("guardian wallet", () => {
  it("shows the debt, the counter entries and, to another guardian, only the sales as information", async () => {
    const schoolId = await createSchool();
    await adminDb().updateTable("schools").set({ debtLimitCents: 1000 }).where("id", "=", schoolId).execute();
    const ana = await seedFamily(schoolId, ["Léo", "Bia"]);
    const [leo, bia] = ana.studentIds as [string, string];
    const rui = uuidv7();
    await adminDb().insertInto("guardians").values({ id: rui, schoolId, phoneE164: "+5511955550001", firstName: "Rui" }).execute();
    await adminDb().insertInto("guardianStudents").values({ schoolId, guardianId: rui, studentId: leo, financial: false }).execute();
    const misto = uuidv7();
    await adminDb().insertInto("menuItems").values({ id: misto, schoolId, name: `Misto ${misto.slice(-6)}`, priceCents: 900 }).execute();
    const { deviceId } = await kitchenCookie(schoolId);
    const kitchen = { source: "kitchen" as const, deviceId };
    const leoSale = uuidv7();
    await withTenant(schoolId, (trx) => applySales(trx, schoolId, kitchen, [{ id: leoSale, studentId: leo, items: [{ menuItemId: misto, qty: 1 }], occurredAt: null }], "record"));
    await withTenant(schoolId, (trx) => applySales(trx, schoolId, kitchen, [{ id: uuidv7(), studentId: bia, items: [{ menuItemId: misto, qty: 2 }], occurredAt: null }], "record"));
    await withTenant(schoolId, (trx) => voidSales(trx, schoolId, kitchen, [{ saleId: leoSale, occurredAt: new Date().toISOString() }]));

    const mine = await buildApp().inject({ method: "GET", url: "/api/v1/wallet", cookies: await guardianCookie(schoolId, ana.guardianId, "wallet") });
    expect(mine.json()).toMatchObject({ balanceCents: -1800, debtLimitCents: 1000, financialFor: ["Bia", "Léo"], otherSales: [] });
    expect(mine.json().entries.map((e: { kind: string; studentFirstName: string; overLimit: boolean; voided: boolean }) => [e.kind, e.studentFirstName, e.overLimit, e.voided])).toEqual([
      ["counter_void", "Léo", false, true],
      ["counter_charge", "Bia", true, false],
      ["counter_charge", "Léo", false, true],
    ]);

    const other = await buildApp().inject({ method: "GET", url: "/api/v1/wallet", cookies: await guardianCookie(schoolId, rui) });
    expect(other.json()).toMatchObject({ balanceCents: 0, financialFor: [], entries: [] });
    expect(other.json().otherSales).toEqual([{ id: leoSale, studentFirstName: "Léo", occurredAt: expect.any(String), totalCents: 900, voided: true }]);
  });

  it("leaves sales of inactive students out of the sales charged to another guardian", async () => {
    const schoolId = await createSchool();
    const ana = await seedFamily(schoolId, ["Léo"]);
    const leo = ana.studentIds[0]!;
    const rui = uuidv7();
    await adminDb().insertInto("guardians").values({ id: rui, schoolId, phoneE164: "+5511955550002", firstName: "Rui" }).execute();
    await adminDb().insertInto("guardianStudents").values({ schoolId, guardianId: rui, studentId: leo, financial: false }).execute();
    const misto = uuidv7();
    await adminDb().insertInto("menuItems").values({ id: misto, schoolId, name: `Misto ${misto.slice(-6)}`, priceCents: 900 }).execute();
    const { deviceId } = await kitchenCookie(schoolId);
    await withTenant(schoolId, (trx) =>
      applySales(trx, schoolId, { source: "kitchen", deviceId }, [{ id: uuidv7(), studentId: leo, items: [{ menuItemId: misto, qty: 1 }], occurredAt: null }], "record"),
    );
    await adminDb().updateTable("students").set({ active: false }).where("id", "=", leo).execute();
    const other = await buildApp().inject({ method: "GET", url: "/api/v1/wallet", cookies: await guardianCookie(schoolId, rui) });
    expect(other.json().otherSales).toEqual([]);
  });

  it("keeps guardian sessions out of the staff account routes", async () => {
    const schoolId = await createSchool();
    const ana = await seedFamily(schoolId, ["Léo"]);
    for (const scope of ["order", "wallet"] as const) {
      const cookies = await guardianCookie(schoolId, ana.guardianId, scope);
      for (const url of ["/api/admin/v1/accounts", `/api/admin/v1/guardians/${ana.guardianId}/statement`, "/api/admin/v1/school/settings"]) {
        expect((await buildApp().inject({ method: "GET", url, cookies })).statusCode).toBe(403);
      }
      const topup = await buildApp().inject({
        method: "POST",
        url: `/api/admin/v1/guardians/${ana.guardianId}/topups`,
        cookies,
        headers: { "idempotency-key": uuidv7() },
        payload: { amountCents: 1000 },
      });
      expect(topup.statusCode).toBe(403);
    }
  });
});
