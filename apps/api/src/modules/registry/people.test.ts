import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { adminDb, createSchool, seedFamily, staffCookie } from "../../../test/helpers";
import { buildApp } from "../../app";

async function family() {
  const schoolId = await createSchool();
  const fam = await seedFamily(schoolId, ["Léo"]);
  await adminDb().updateTable("guardians").set({ fullName: "Ana Paula Souza", cpf: "12345678909" }).where("id", "=", fam.guardianId).execute();
  const { cookies } = await staffCookie(schoolId, "secretaria");
  return { schoolId, ...fam, studentId: fam.studentIds[0]!, cookies };
}

describe("students and guardians (staff)", () => {
  it("lists personal fields with the CPF masked and never in full", async () => {
    const f = await family();
    await adminDb().updateTable("students").set({ fullName: "Leonardo Souza", birthDate: "2021-03-15" }).where("id", "=", f.studentId).execute();
    const res = await buildApp().inject({ method: "GET", url: "/api/admin/v1/students", cookies: f.cookies });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("12345678909");
    expect(res.json().students[0]).toMatchObject({
      fullName: "Leonardo Souza",
      birthDate: "2021-03-15",
      guardians: [{ id: f.guardianId, fullName: "Ana Paula Souza", cpfMasked: "***.456.789-**" }],
    });
  });

  it("updates a student and audits without values", async () => {
    const f = await family();
    const app = buildApp();
    const res = await app.inject({ method: "PUT", url: `/api/admin/v1/students/${f.studentId}`, cookies: f.cookies, payload: { fullName: " Leonardo Souza ", birthDate: "2021-03-15" } });
    expect(res.statusCode).toBe(204);
    const row = await adminDb().selectFrom("students").select(["fullName", "birthDate"]).where("id", "=", f.studentId).executeTakeFirstOrThrow();
    expect(row).toEqual({ fullName: "Leonardo Souza", birthDate: "2021-03-15" });
    const audit = await adminDb().selectFrom("auditLog").select(["action", sql<string>`detail::text`.as("detail")]).where("schoolId", "=", f.schoolId).where("action", "=", "student.updated").executeTakeFirstOrThrow();
    expect(audit.detail).not.toContain("Leonardo");
    const clear = await app.inject({ method: "PUT", url: `/api/admin/v1/students/${f.studentId}`, cookies: f.cookies, payload: { fullName: null, birthDate: null } });
    expect(clear.statusCode).toBe(204);
  });

  it("shows the full CPF only in the guardian detail and stores digits only", async () => {
    const f = await family();
    const app = buildApp();
    const detail = await app.inject({ method: "GET", url: `/api/admin/v1/guardians/${f.guardianId}`, cookies: f.cookies });
    expect(detail.json()).toEqual({ id: f.guardianId, firstName: "Ana", fullName: "Ana Paula Souza", cpf: "12345678909" });
    const put = await app.inject({ method: "PUT", url: `/api/admin/v1/guardians/${f.guardianId}`, cookies: f.cookies, payload: { fullName: "Ana P. Souza", cpf: "529.982.247-25" } });
    expect(put.statusCode).toBe(204);
    const row = await adminDb().selectFrom("guardians").select(["fullName", "cpf"]).where("id", "=", f.guardianId).executeTakeFirstOrThrow();
    expect(row).toEqual({ fullName: "Ana P. Souza", cpf: "52998224725" });
    const bad = await app.inject({ method: "PUT", url: `/api/admin/v1/guardians/${f.guardianId}`, cookies: f.cookies, payload: { fullName: null, cpf: "529.982.247-24" } });
    expect(bad.statusCode).toBe(400);
  });

  it("answers 404 for another school's records and 403 for the kitchen role", async () => {
    const f = await family();
    const other = await family();
    const app = buildApp();
    const res = await app.inject({ method: "PUT", url: `/api/admin/v1/students/${other.studentId}`, cookies: f.cookies, payload: { fullName: "X", birthDate: null } });
    expect(res.statusCode).toBe(404);
    const g = await app.inject({ method: "GET", url: `/api/admin/v1/guardians/${other.guardianId}`, cookies: f.cookies });
    expect(g.statusCode).toBe(404);
    const { cookies } = await staffCookie(f.schoolId, "cozinha");
    const k = await app.inject({ method: "GET", url: `/api/admin/v1/guardians/${f.guardianId}`, cookies });
    expect(k.statusCode).toBe(403);
  });
});
