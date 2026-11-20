import { describe, expect, it } from "vitest";
import { adminDb, createSchool, internalRequest, markDayClosed, seedServiceDay, seedTenant } from "../../../test/helpers";
import { buildApp } from "../../app";

describe("internal schedule and close routes", () => {
  it("lists due actions for the school without the overdue flag", async () => {
    const schoolId = await createSchool();
    await seedTenant(schoolId);
    await seedServiceDay(schoolId, { serviceDate: "2031-04-01", cutoffInMinutes: 60 });
    await seedServiceDay(schoolId, { serviceDate: "2031-04-02", cutoffInMinutes: -11 });
    const res = await buildApp().inject(internalRequest("GET", "/internal/v1/schedule/due"));
    expect(res.statusCode).toBe(200);
    const mine = res.json().due.filter((d: { school_id: string }) => d.school_id === schoolId);
    expect(mine).toEqual([
      { action: "send_reminders", school_id: schoolId, service_date: "2031-04-01" },
      { action: "close_service_day", school_id: schoolId, service_date: "2031-04-02" },
    ]);
  });

  it("closes the day once and returns the same manifest on repetition", async () => {
    const schoolId = await createSchool();
    await seedTenant(schoolId);
    await adminDb().updateTable("schools").set({ kitchenPhone: "+5511988880000" }).where("id", "=", schoolId).execute();
    const day = await seedServiceDay(schoolId, { serviceDate: "2031-04-03", cutoffInMinutes: -6 });
    const app = buildApp();
    const url = `/internal/v1/service-days/${schoolId}/${day.serviceDate}/close`;
    const first = await app.inject(internalRequest("POST", url));
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ status: "closed", shifts: [{ shift: "matutino", status: "closed", manifest_version: 1, kitchen_phone: "+5511988880000" }] });
    const again = await app.inject(internalRequest("POST", url));
    expect(again.json()).toEqual(first.json());
    const manifest = await app.inject(internalRequest("GET", `/internal/v1/service-days/${schoolId}/${day.serviceDate}/manifest`));
    expect(manifest.statusCode).toBe(200);
    expect(manifest.json()).toEqual(first.json().shifts[0]);
  });

  it("keeps the safety finish out of the n8n schedule", async () => {
    const schoolId = await createSchool();
    const past = await seedServiceDay(schoolId, { serviceDate: "2021-04-05", shifts: { matutino: -60 } });
    await markDayClosed(past.serviceDayId);
    const res = await buildApp().inject(internalRequest("GET", "/internal/v1/schedule/due"));
    expect(res.json().due.filter((d: { school_id: string }) => d.school_id === schoolId)).toEqual([]);
  });

  it("answers 409 service_day_open before the cutoff, for close and for manifest", async () => {
    const schoolId = await createSchool();
    await seedTenant(schoolId);
    const day = await seedServiceDay(schoolId, { serviceDate: "2031-04-04", cutoffInMinutes: 60 });
    const app = buildApp();
    const close = await app.inject(internalRequest("POST", `/internal/v1/service-days/${schoolId}/${day.serviceDate}/close`));
    expect(close.statusCode).toBe(409);
    expect(close.json().error.code).toBe("service_day_open");
    const manifest = await app.inject(internalRequest("GET", `/internal/v1/service-days/${schoolId}/${day.serviceDate}/manifest`));
    expect(manifest.statusCode).toBe(409);
  });

  it("rejects a request signed for another school's path", async () => {
    const schoolA = await createSchool();
    const schoolB = await createSchool();
    const signed = internalRequest("POST", `/internal/v1/service-days/${schoolA}/2031-04-05/close`);
    const res = await buildApp().inject({ ...signed, url: `/internal/v1/service-days/${schoolB}/2031-04-05/close` });
    expect(res.statusCode).toBe(401);
  });
});
