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
});
