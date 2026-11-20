import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { describe, expect, it } from "vitest";
import { adminDb, createSchool, guardianCookie, markDayClosed, seedFamily, seedServiceDay, staffCookie } from "../../../test/helpers";
import { buildApp } from "../../app";

const key = () => uuidv7();

async function createItem(cookies: Record<string, string>, name: string, priceCents: number, k = key()) {
  return buildApp().inject({
    method: "POST",
    url: "/api/admin/v1/menu-items",
    cookies,
    headers: { "idempotency-key": k },
    payload: { name, priceCents },
  });
}

describe("menu items", () => {
  it("creates, lists and updates items", async () => {
    const schoolId = await createSchool();
    const { cookies } = await staffCookie(schoolId, "secretaria");
    const created = await createItem(cookies, "  Misto quente ", 900);
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ name: "Misto quente", priceCents: 900, active: true });
    const id = created.json().id as string;

    const patched = await buildApp().inject({
      method: "PATCH",
      url: `/api/admin/v1/menu-items/${id}`,
      cookies,
      payload: { priceCents: 950, active: false },
    });
    expect(patched.json()).toEqual({ id, name: "Misto quente", priceCents: 950, active: false });

    const list = await buildApp().inject({ method: "GET", url: "/api/admin/v1/menu-items", cookies });
    expect(list.json()).toEqual({ items: [{ id, name: "Misto quente", priceCents: 950, active: false }] });
  });

  it("replays a repeated Idempotency-Key and requires one", async () => {
    const schoolId = await createSchool();
    const { cookies } = await staffCookie(schoolId);
    const k = key();
    const a = await createItem(cookies, "Suco", 450, k);
    const b = await createItem(cookies, "Suco", 450, k);
    expect(b.json()).toEqual(a.json());
    const missing = await buildApp().inject({
      method: "POST",
      url: "/api/admin/v1/menu-items",
      cookies,
      payload: { name: "Bolo", priceCents: 500 },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe("idempotency_key_required");
  });

  it("rejects a duplicate name with 409", async () => {
    const schoolId = await createSchool();
    const { cookies } = await staffCookie(schoolId);
    await createItem(cookies, "Suco", 450);
    const dup = await createItem(cookies, "Suco", 500);
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("menu_item_name_taken");
  });

  it("is closed to the kitchen role and to guardians", async () => {
    const schoolId = await createSchool();
    const kitchen = await staffCookie(schoolId, "cozinha");
    expect((await buildApp().inject({ method: "GET", url: "/api/admin/v1/menu-items", cookies: kitchen.cookies })).statusCode).toBe(403);
    const family = await seedFamily(schoolId);
    const guardian = await guardianCookie(schoolId, family.guardianId);
    expect((await buildApp().inject({ method: "GET", url: "/api/admin/v1/menu-items", cookies: guardian })).statusCode).toBe(403);
  });
});

describe("service days", () => {
  async function setup() {
    const schoolId = await createSchool();
    const { cookies } = await staffCookie(schoolId);
    const misto = (await createItem(cookies, "Misto quente", 900)).json().id as string;
    const suco = (await createItem(cookies, "Suco", 450)).json().id as string;
    return { schoolId, cookies, misto, suco };
  }

  const put = (cookies: Record<string, string>, date: string, payload: object) =>
    buildApp().inject({ method: "PUT", url: `/api/admin/v1/service-days/${date}`, cookies, payload });

  it("computes one cutoff per shift that has classes, in the school's timezone", async () => {
    const { schoolId, cookies, misto, suco } = await setup();
    // Sem turma com aluno: só o matutino, no horário padrão da escola (07:30 em São Paulo = 10:30Z).
    const res = await put(cookies, "2030-03-04", { items: [{ menuItemId: misto }, { menuItemId: suco, priceCents: 400 }] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      serviceDate: "2030-03-04",
      cutoffAt: "2030-03-04T10:30:00.000Z",
      freezeAt: "2030-03-04T10:35:00.000Z",
      status: "open",
      shifts: [{ shift: "matutino", cutoffAt: "2030-03-04T10:30:00.000Z", freezeAt: "2030-03-04T10:35:00.000Z", status: "open" }],
      items: [
        { menuItemId: misto, name: "Misto quente", priceCents: 900 },
        { menuItemId: suco, name: "Suco", priceCents: 400 },
      ],
    });
    // Turmas nos dois turnos: o vespertino usa o padrão 13:00 (16:00Z) e o dia espelha o turno mais tarde.
    await seedFamily(schoolId, ["Léo"], { className: "Infantil 3A", shift: "matutino" });
    await seedFamily(schoolId, ["Bia"], { className: "Infantil 5C", shift: "vespertino" });
    const both = await put(cookies, "2030-03-05", { cutoffTimes: { matutino: "09:00" }, items: [{ menuItemId: misto }] });
    expect(both.json()).toMatchObject({
      cutoffAt: "2030-03-05T16:00:00.000Z",
      freezeAt: "2030-03-05T16:05:00.000Z",
      shifts: [
        { shift: "matutino", cutoffAt: "2030-03-05T12:00:00.000Z" },
        { shift: "vespertino", cutoffAt: "2030-03-05T16:00:00.000Z" },
      ],
    });
  });

  it("refuses a cutoff for a shift without classes and a shift whose cutoff already passed", async () => {
    const { schoolId, cookies, misto } = await setup();
    const noClasses = await put(cookies, "2030-03-04", { cutoffTimes: { vespertino: "13:30" }, items: [{ menuItemId: misto }] });
    expect(noClasses.statusCode).toBe(400);
    expect(noClasses.json().error.code).toBe("validation_failed");
    await seedFamily(schoolId, ["Bia"], { className: "Infantil 5C", shift: "vespertino" });
    // Data de hoje com o corte do vespertino às 00:00: já passou.
    const { rows } = await sql<{ d: string }>`SELECT (now() AT TIME ZONE timezone)::date::text AS d FROM schools WHERE id = ${schoolId}`.execute(adminDb());
    const past = await put(cookies, rows[0]!.d, { cutoffTimes: { vespertino: "00:00" }, items: [{ menuItemId: misto }] });
    expect(past.statusCode).toBe(409);
    expect(past.json().error.code).toBe("cutoff_passed");
  });

  it("keeps the times of a shift that is no longer open when the day is saved again", async () => {
    const { schoolId, cookies, misto } = await setup();
    await seedFamily(schoolId, ["Léo"], { className: "Infantil 3A", shift: "matutino" });
    await seedFamily(schoolId, ["Bia"], { className: "Infantil 5C", shift: "vespertino" });
    await put(cookies, "2030-03-04", { items: [{ menuItemId: misto }] });
    await adminDb()
      .updateTable("serviceDayShifts")
      .set({ status: "closed", closedAt: sql<Date>`now()` })
      .where("schoolId", "=", schoolId)
      .where("shift", "=", "matutino")
      .execute();
    const res = await put(cookies, "2030-03-04", { cutoffTimes: { matutino: "09:00", vespertino: "14:00" }, items: [{ menuItemId: misto }] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      cutoffAt: "2030-03-04T17:00:00.000Z",
      shifts: [
        { shift: "matutino", cutoffAt: "2030-03-04T10:30:00.000Z", freezeAt: "2030-03-04T10:35:00.000Z", status: "closed" },
        { shift: "vespertino", cutoffAt: "2030-03-04T17:00:00.000Z", freezeAt: "2030-03-04T17:05:00.000Z", status: "open" },
      ],
    });
  });

  it("shows guardians each shift and whether it still takes orders", async () => {
    const schoolId = await createSchool();
    const family = await seedFamily(schoolId);
    const cookies = await guardianCookie(schoolId, family.guardianId);
    const day = await seedServiceDay(schoolId, { serviceDate: "2030-03-04", shifts: { matutino: -1, vespertino: 120 } });
    const list = await buildApp().inject({ method: "GET", url: "/api/v1/service-days", cookies });
    expect(list.json().serviceDays[0].shifts).toEqual([
      { shift: "matutino", cutoffAt: expect.any(String), acceptingOrders: false },
      { shift: "vespertino", cutoffAt: expect.any(String), acceptingOrders: true },
    ]);
    const menu = await buildApp().inject({ method: "GET", url: `/api/v1/service-days/${day.serviceDate}/menu`, cookies });
    expect(menu.json()).toMatchObject({ acceptingOrders: true, shifts: [{ acceptingOrders: false }, { acceptingOrders: true }] });
  });

  it("replaces the items of an open day without checkouts", async () => {
    const { cookies, misto, suco } = await setup();
    await put(cookies, "2030-03-04", { items: [{ menuItemId: misto }] });
    const res = await put(cookies, "2030-03-04", { items: [{ menuItemId: suco }] });
    expect(res.json().items).toEqual([{ menuItemId: suco, name: "Suco", priceCents: 450 }]);
  });

  it("rejects a day whose cutoff already passed", async () => {
    const { cookies, misto } = await setup();
    const res = await put(cookies, "2020-01-02", { items: [{ menuItemId: misto }] });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("cutoff_passed");
  });

  it("rejects unknown or inactive items and invalid dates", async () => {
    const { cookies, misto } = await setup();
    await buildApp().inject({ method: "PATCH", url: `/api/admin/v1/menu-items/${misto}`, cookies, payload: { active: false } });
    expect((await put(cookies, "2030-03-04", { items: [{ menuItemId: misto }] })).statusCode).toBe(400);
    expect((await put(cookies, "2030-03-04", { items: [{ menuItemId: uuidv7() }] })).statusCode).toBe(400);
    expect((await put(cookies, "2030-02-31", { items: [{ menuItemId: uuidv7() }] })).statusCode).toBe(400);
  });

  it("locks a day once it has a checkout", async () => {
    const { schoolId, cookies, misto } = await setup();
    await put(cookies, "2030-03-04", { items: [{ menuItemId: misto }] });
    const day = await adminDb().selectFrom("serviceDays").select("id").where("schoolId", "=", schoolId).executeTakeFirstOrThrow();
    const family = await seedFamily(schoolId);
    await adminDb()
      .insertInto("checkouts")
      .values({ id: uuidv7(), schoolId, guardianId: family.guardianId, serviceDayId: day.id, shift: "matutino", totalCents: 900 })
      .execute();
    const res = await put(cookies, "2030-03-04", { items: [{ menuItemId: misto }] });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("service_day_locked");
  });

  it("lists days from a date for staff", async () => {
    const { cookies, misto } = await setup();
    await put(cookies, "2030-03-05", { items: [{ menuItemId: misto }] });
    await put(cookies, "2030-03-04", { items: [{ menuItemId: misto }] });
    const res = await buildApp().inject({ method: "GET", url: "/api/admin/v1/service-days?from=2030-03-05", cookies });
    expect(res.json().serviceDays.map((d: { serviceDate: string }) => d.serviceDate)).toEqual(["2030-03-05"]);
  });

  it("shows guardians only open days before the cutoff, and the menu of a day", async () => {
    const schoolId = await createSchool();
    const family = await seedFamily(schoolId);
    const cookies = await guardianCookie(schoolId, family.guardianId);
    const open = await seedServiceDay(schoolId, { serviceDate: "2030-03-04" });
    await seedServiceDay(schoolId, { serviceDate: "2030-03-05", cutoffInMinutes: -1 });
    const closed = await seedServiceDay(schoolId, { serviceDate: "2030-03-06" });
    await markDayClosed(closed.serviceDayId);

    const list = await buildApp().inject({ method: "GET", url: "/api/v1/service-days", cookies });
    expect(list.statusCode).toBe(200);
    expect(list.json().serviceDays.map((d: { serviceDate: string }) => d.serviceDate)).toEqual(["2030-03-04"]);
    expect(list.json().serviceDays[0].items).toHaveLength(open.items.length);

    const menu = await buildApp().inject({ method: "GET", url: "/api/v1/service-days/2030-03-05/menu", cookies });
    expect(menu.json()).toMatchObject({ serviceDate: "2030-03-05", acceptingOrders: false });
    const missing = await buildApp().inject({ method: "GET", url: "/api/v1/service-days/2031-01-01/menu", cookies });
    expect(missing.statusCode).toBe(404);
  });
});
