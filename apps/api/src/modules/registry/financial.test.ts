import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { adminDb, createSchool, staffCookie } from "../../../test/helpers";
import { buildApp } from "../../app";

const HEADER = "codigo_aluno,primeiro_nome,turma,responsavel_nome,responsavel_telefone";
const CSV = [HEADER, "F1,Léo,Infantil 3A,Ana,(11) 97777-0001", "F1,Léo,Infantil 3A,Rui,(11) 97777-0002", "F2,Bia,Infantil 3A,Rui,(11) 97777-0002"].join("\n");

function importCsv(cookies: Record<string, string>, csv: string) {
  return buildApp().inject({ method: "POST", url: "/api/admin/v1/import/students", cookies, payload: { csv } });
}

async function financialMap(schoolId: string): Promise<Record<string, string[]>> {
  const { rows } = await sql<{ student: string; guardian: string }>`
    SELECT s.first_name AS student, g.first_name AS guardian
    FROM guardian_students gs JOIN students s ON s.id = gs.student_id JOIN guardians g ON g.id = gs.guardian_id
    WHERE gs.school_id = ${schoolId} AND gs.financial ORDER BY 1, 2`.execute(adminDb());
  const out: Record<string, string[]> = {};
  for (const r of rows) (out[r.student] ??= []).push(r.guardian);
  return out;
}

async function ids(schoolId: string) {
  const students = await adminDb().selectFrom("students").select(["id", "firstName"]).where("schoolId", "=", schoolId).execute();
  const guardians = await adminDb().selectFrom("guardians").select(["id", "firstName"]).where("schoolId", "=", schoolId).execute();
  const by = (rows: { id: string; firstName: string }[], name: string) => rows.find((r) => r.firstName === name)!.id;
  return { leo: by(students, "Léo"), ana: by(guardians, "Ana"), rui: by(guardians, "Rui") };
}

describe("financial guardian", () => {
  it("marks the first imported guardian of each student as financial and keeps it on re-import", async () => {
    const schoolId = await createSchool();
    const { cookies } = await staffCookie(schoolId, "secretaria");
    expect((await importCsv(cookies, CSV)).json()).toMatchObject({ applied: true });
    expect(await financialMap(schoolId)).toEqual({ Bia: ["Rui"], "Léo": ["Ana"] });
    const reordered = [HEADER, "F1,Léo,Infantil 3A,Rui,(11) 97777-0002", "F1,Léo,Infantil 3A,Ana,(11) 97777-0001", "F2,Bia,Infantil 3A,Ana,(11) 97777-0001"].join("\n");
    expect((await importCsv(cookies, reordered)).json()).toMatchObject({ applied: true });
    expect(await financialMap(schoolId)).toEqual({ Bia: ["Rui"], "Léo": ["Ana"] });
  });

  it("changes the financial guardian idempotently, with audit, and lists it", async () => {
    const schoolId = await createSchool();
    const { cookies } = await staffCookie(schoolId, "secretaria");
    await importCsv(cookies, CSV);
    const { leo, rui } = await ids(schoolId);
    const put = () =>
      buildApp().inject({ method: "PUT", url: `/api/admin/v1/students/${leo}/financial-guardian`, cookies, payload: { guardianId: rui } });
    expect((await put()).statusCode).toBe(204);
    expect((await put()).statusCode).toBe(204);
    expect(await financialMap(schoolId)).toEqual({ Bia: ["Rui"], "Léo": ["Rui"] });
    const audit = await adminDb().selectFrom("auditLog").select("action").where("schoolId", "=", schoolId).where("action", "=", "student.financial_guardian_changed").execute();
    expect(audit).toHaveLength(1);
    const list = await buildApp().inject({ method: "GET", url: "/api/admin/v1/students", cookies });
    const student = list.json().students.find((s: { id: string }) => s.id === leo);
    expect(student.guardians.map((g: { firstName: string; financial: boolean }) => [g.firstName, g.financial])).toEqual([
      ["Ana", false],
      ["Rui", true],
    ]);
  });

  it("refuses a guardian not linked to the student and non-office roles", async () => {
    const schoolId = await createSchool();
    const office = await staffCookie(schoolId, "secretaria");
    await importCsv(office.cookies, CSV);
    const { leo } = await ids(schoolId);
    const bia = (await adminDb().selectFrom("students").select("id").where("schoolId", "=", schoolId).where("firstName", "=", "Bia").executeTakeFirstOrThrow()).id;
    const anaId = (await ids(schoolId)).ana;
    const put = (cookies: Record<string, string>, studentId: string, guardianId: string) =>
      buildApp().inject({ method: "PUT", url: `/api/admin/v1/students/${studentId}/financial-guardian`, cookies, payload: { guardianId } });
    // Ana é responsável de Léo, não de Bia: responsável de outro aluno não vira financeiro.
    expect((await put(office.cookies, bia, anaId)).statusCode).toBe(404);
    expect((await put(office.cookies, leo, crypto.randomUUID())).statusCode).toBe(404);
    const kitchen = await staffCookie(schoolId, "cozinha");
    expect((await put(kitchen.cookies, leo, anaId)).statusCode).toBe(403);
  });
});
