import { describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { adminDb, createSchool, seedFamily, staffCookie } from "../../../test/helpers";
import { buildApp } from "../../app";

const csv = (rows: string) => `codigo_aluno,primeiro_nome,turma,responsavel_nome,responsavel_telefone,turno\n${rows}`;

describe("class shift", () => {
  it("imports the shift, keeps it when the column is blank and lists it", async () => {
    const schoolId = await createSchool();
    const { cookies } = await staffCookie(schoolId, "secretaria");
    const app = buildApp();
    const imp = (rows: string) => app.inject({ method: "POST", url: "/api/admin/v1/import/students", cookies, payload: { csv: csv(rows) } });
    expect((await imp("A1,Léo,Infantil 5C,Ana,11999990001,tarde\nA2,Bia,Infantil 3A,Ana,11999990001,")).json().applied).toBe(true);
    expect((await imp("A1,Léo,Infantil 5C,Ana,11999990001,")).json().applied).toBe(true);
    const list = await app.inject({ method: "GET", url: "/api/admin/v1/classes", cookies });
    expect(list.json().classes.map((c: { name: string; shift: string }) => [c.name, c.shift])).toEqual([
      ["Infantil 3A", "matutino"],
      ["Infantil 5C", "vespertino"],
    ]);
  });

  it("changes a class's shift, audits it and refuses other roles and unknown classes", async () => {
    const schoolId = await createSchool();
    await seedFamily(schoolId, ["Léo"]);
    const cls = await adminDb().selectFrom("classes").select("id").where("schoolId", "=", schoolId).executeTakeFirstOrThrow();
    const { cookies } = await staffCookie(schoolId, "admin");
    const app = buildApp();
    const put = (id: string, shift: string, c = cookies) => app.inject({ method: "PUT", url: `/api/admin/v1/classes/${id}/shift`, cookies: c, payload: { shift } });
    expect((await put(cls.id, "vespertino")).statusCode).toBe(204);
    expect((await put(cls.id, "vespertino")).statusCode).toBe(204);
    const row = await adminDb().selectFrom("classes").select("shift").where("id", "=", cls.id).executeTakeFirstOrThrow();
    expect(row.shift).toBe("vespertino");
    const audits = await adminDb().selectFrom("auditLog").select("detail").where("schoolId", "=", schoolId).where("action", "=", "class.shift_changed").execute();
    expect(audits).toHaveLength(1);
    expect((await put(cls.id, "noite")).statusCode).toBe(400);
    expect((await put(uuidv7(), "matutino")).statusCode).toBe(404);
    const kitchen = await staffCookie(schoolId, "cozinha");
    expect((await put(cls.id, "matutino", kitchen.cookies)).statusCode).toBe(403);
  });
});
