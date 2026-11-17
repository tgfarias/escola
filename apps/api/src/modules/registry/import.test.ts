import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { describe, expect, it } from "vitest";
import { adminDb, createSchool } from "../../../test/helpers";
import { buildApp } from "../../app";
import { SESSION_COOKIE, signToken, type StaffRole } from "../../platform/session";

const CSV = [
  "codigo_aluno,primeiro_nome,turma,responsavel_nome,responsavel_telefone",
  "A001,Léo,Infantil 3A,Ana,(11) 99999-0001",
  "A002,Bia,Infantil 2B,Ana,(11) 99999-0001",
  "A001,Léo,Infantil 3A,Rui,(11) 98888-0002",
].join("\n");

async function staffCookie(schoolId: string, role: StaffRole = "secretaria") {
  const id = uuidv7();
  await adminDb()
    .insertInto("staffUsers")
    .values({ id, schoolId, email: `s-${id}@escola.test`, role })
    .execute();
  return { [SESSION_COOKIE]: await signToken("session", { kind: "staff", sub: id, schoolId, role }, 60) };
}

function importCsv(cookies: Record<string, string>, csv: string) {
  return buildApp().inject({ method: "POST", url: "/api/admin/v1/import/students", cookies, payload: { csv } });
}

async function counts(schoolId: string) {
  const count = async (table: string) => {
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM ${sql.table(table)} WHERE school_id = ${schoolId}`.execute(adminDb());
    return rows[0]!.n;
  };
  return {
    classes: await count("classes"),
    students: await count("students"),
    guardians: await count("guardians"),
    links: await count("guardian_students"),
  };
}

describe("student import", () => {
  it("creates classes, students, guardians and links", async () => {
    const schoolId = await createSchool();
    const res = await importCsv(await staffCookie(schoolId), CSV);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ applied: true, errors: [], classes: 2, students: 2, guardians: 2 });
    expect(await counts(schoolId)).toEqual({ classes: 2, students: 2, guardians: 2, links: 3 });
  });

  it("is idempotent and updates changed data", async () => {
    const schoolId = await createSchool();
    const cookies = await staffCookie(schoolId);
    await importCsv(cookies, CSV);
    await importCsv(cookies, CSV.replace("A002,Bia,Infantil 2B", "A002,Beatriz,Infantil 3A"));
    expect(await counts(schoolId)).toEqual({ classes: 2, students: 2, guardians: 2, links: 3 });
    const bia = await adminDb()
      .selectFrom("students")
      .innerJoin("classes", "classes.id", "students.classId")
      .select(["students.firstName", "classes.name"])
      .where("students.schoolId", "=", schoolId)
      .where("students.externalCode", "=", "A002")
      .executeTakeFirstOrThrow();
    expect(bia).toEqual({ firstName: "Beatriz", name: "Infantil 3A" });
  });

  it("writes nothing when any line is invalid", async () => {
    const schoolId = await createSchool();
    const res = await importCsv(await staffCookie(schoolId), `${CSV}\nA003,Caio,Infantil 3A,Eva,123`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      applied: false,
      errors: [{ line: 5, message: "telefone inválido" }],
      classes: 0,
      students: 0,
      guardians: 0,
    });
    expect(await counts(schoolId)).toEqual({ classes: 0, students: 0, guardians: 0, links: 0 });
  });

  it("writes nothing when a codigo_aluno is repeated with different data", async () => {
    const schoolId = await createSchool();
    const res = await importCsv(await staffCookie(schoolId), `${CSV}\nA002,Bia,Infantil 3A,Eva,11977770003`);
    expect(res.json()).toMatchObject({
      applied: false,
      errors: [{ line: 5, message: "codigo_aluno repetido com dados diferentes" }],
    });
    expect(await counts(schoolId)).toEqual({ classes: 0, students: 0, guardians: 0, links: 0 });
  });

  it("imports a phone already used by a guardian of another school without touching it", async () => {
    const schoolId = await createSchool();
    const other = await createSchool();
    const otherGuardianId = uuidv7();
    await adminDb()
      .insertInto("guardians")
      .values({ id: otherGuardianId, schoolId: other, phoneE164: "+5511999990001", firstName: "Original" })
      .execute();

    const csv = "codigo_aluno,primeiro_nome,turma,responsavel_nome,responsavel_telefone\nA001,Léo,Infantil 3A,Ana,(11) 99999-0001";
    const res = await importCsv(await staffCookie(schoolId), csv);
    expect(res.json()).toEqual({ applied: true, errors: [], classes: 1, students: 1, guardians: 1 });

    const rows = await adminDb()
      .selectFrom("guardians")
      .select(["id", "schoolId", "firstName"])
      .where("phoneE164", "=", "+5511999990001")
      .where("schoolId", "in", [schoolId, other])
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.schoolId === other)).toEqual({ id: otherGuardianId, schoolId: other, firstName: "Original" });
    expect(rows.find((r) => r.schoolId === schoolId)).toMatchObject({ firstName: "Ana" });
  });

  it("records the import in the audit log", async () => {
    const schoolId = await createSchool();
    await importCsv(await staffCookie(schoolId), CSV);
    const entry = await adminDb()
      .selectFrom("auditLog")
      .select(["action", "actorKind", "detail"])
      .where("schoolId", "=", schoolId)
      .executeTakeFirstOrThrow();
    expect(entry).toEqual({
      action: "students.import",
      actorKind: "staff",
      detail: { classes: 2, students: 2, guardians: 2 },
    });
  });

  it("is forbidden for the kitchen role", async () => {
    const schoolId = await createSchool();
    const res = await importCsv(await staffCookie(schoolId, "cozinha"), CSV);
    expect(res.statusCode).toBe(403);
  });

  it("lists classes and students of the staff's school only", async () => {
    const schoolId = await createSchool();
    const other = await createSchool();
    const cookies = await staffCookie(schoolId);
    await importCsv(cookies, CSV);
    await importCsv(await staffCookie(other), CSV.replace("A001,Léo", "A001,Outro"));

    const classes = await buildApp().inject({ method: "GET", url: "/api/admin/v1/classes", cookies });
    expect(classes.json().classes.map((c: { name: string }) => c.name)).toEqual(["Infantil 2B", "Infantil 3A"]);

    const students = await buildApp().inject({ method: "GET", url: "/api/admin/v1/students", cookies });
    const list = students.json().students as {
      firstName: string;
      className: string;
      guardians: { firstName: string; phone: string }[];
    }[];
    expect(list.map((s) => s.firstName)).toEqual(["Bia", "Léo"]);
    expect(list[1]!.guardians.map((g) => g.firstName).sort()).toEqual(["Ana", "Rui"]);
    expect(list[0]!.guardians).toMatchObject([{ firstName: "Ana", phone: "+5511999990001" }]);
  });

  describe("staff session re-checked against the database", () => {
    it("rejects a session whose staff user was deactivated and writes nothing", async () => {
      const schoolId = await createSchool();
      const cookies = await staffCookie(schoolId, "admin");
      await adminDb().updateTable("staffUsers").set({ active: false }).where("schoolId", "=", schoolId).execute();
      const res = await importCsv(cookies, CSV);
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("unauthenticated");
      expect(await counts(schoolId)).toEqual({ classes: 0, students: 0, guardians: 0, links: 0 });
    });

    it("applies a role change made after the session was issued", async () => {
      const schoolId = await createSchool();
      const cookies = await staffCookie(schoolId, "admin");
      await adminDb().updateTable("staffUsers").set({ role: "cozinha" }).where("schoolId", "=", schoolId).execute();
      const res = await importCsv(cookies, CSV);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("insufficient_scope");
      expect(await counts(schoolId)).toEqual({ classes: 0, students: 0, guardians: 0, links: 0 });
    });

    it("rejects a session for a staff id that does not exist", async () => {
      const schoolId = await createSchool();
      const cookies = {
        [SESSION_COOKIE]: await signToken("session", { kind: "staff", sub: uuidv7(), schoolId, role: "admin" }, 60),
      };
      const res = await importCsv(cookies, CSV);
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("unauthenticated");
      expect(await counts(schoolId)).toEqual({ classes: 0, students: 0, guardians: 0, links: 0 });
    });

    it("uses the database role, not the one in the token", async () => {
      const schoolId = await createSchool();
      const id = uuidv7();
      await adminDb().insertInto("staffUsers").values({ id, schoolId, email: `s-${id}@escola.test`, role: "secretaria" }).execute();
      const cookies = {
        [SESSION_COOKIE]: await signToken("session", { kind: "staff", sub: id, schoolId, role: "cozinha" }, 60),
      };
      const res = await importCsv(cookies, CSV);
      expect(res.statusCode).toBe(200);
      expect(res.json().applied).toBe(true);
    });
  });
});
