import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { describe, expect, it } from "vitest";
import { adminDb, createSchool, staffCookie } from "../../../test/helpers";
import { buildApp } from "../../app";

const BASE = "/api/admin/v1/document-templates";
const TEMPLATE = {
  name: "Autorização de passeio",
  category: "autorizacao",
  bodyMd: "# Autorização\n\nAutorizo **{{aluno.nome_completo}}** a ir a {{campo.destino}}.",
  fields: [{ key: "destino", label: "Destino", type: "texto" }],
};

async function setup(role: "admin" | "secretaria" = "secretaria") {
  const schoolId = await createSchool();
  const { cookies, staffUserId } = await staffCookie(schoolId, role);
  const app = buildApp();
  const post = (url: string, payload?: unknown, key: string | null = crypto.randomUUID()) =>
    app.inject({ method: "POST", url, cookies, payload: payload as object, headers: key ? { "idempotency-key": key } : {} });
  const get = (url: string) => app.inject({ method: "GET", url, cookies });
  return { schoolId, staffUserId, cookies, app, post, get };
}

/** Espera até alguma sessão estar parada esperando um lock numa consulta que contém `fragment`. */
async function waitForLockWait(fragment: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND query ILIKE ${`%${fragment}%`}`.execute(adminDb());
    if (rows[0]!.n > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("no session waited for the lock");
}

describe("document templates", () => {
  it("creates, lists, versions and keeps the old version readable", async () => {
    const s = await setup();
    const created = await s.post(BASE, TEMPLATE);
    expect(created.statusCode).toBe(200);
    const v1 = created.json();
    expect(v1).toMatchObject({ groupId: v1.id, version: 1, name: "Autorização de passeio", latest: true, archived: false, fields: TEMPLATE.fields });

    const v2res = await s.post(`${BASE}/${v1.id}/versions`, { ...TEMPLATE, name: "Autorização de passeio (zoo)" });
    expect(v2res.statusCode).toBe(200);
    const v2 = v2res.json();
    expect(v2).toMatchObject({ groupId: v1.id, version: 2, latest: true });
    expect(v2.id).not.toBe(v1.id);

    const list = await s.get(BASE);
    expect(list.json().templates).toEqual([expect.objectContaining({ id: v2.id, version: 2, name: "Autorização de passeio (zoo)" })]);
    expect((await s.get(`${BASE}/${v1.id}`)).json()).toMatchObject({ version: 1, latest: false });

    const audit = await adminDb().selectFrom("auditLog").select("action").where("schoolId", "=", s.schoolId).where("action", "like", "document_template.%").orderBy("createdAt").execute();
    expect(audit.map((a) => a.action)).toEqual(["document_template.created", "document_template.versioned"]);
  });

  it("refuses a new version from a stale base", async () => {
    const s = await setup();
    const v1 = (await s.post(BASE, TEMPLATE)).json();
    await s.post(`${BASE}/${v1.id}/versions`, TEMPLATE);
    const stale = await s.post(`${BASE}/${v1.id}/versions`, TEMPLATE);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("document_template_outdated");
  });

  it("rejects unknown variables and undeclared fields with their names", async () => {
    const s = await setup();
    const res = await s.post(BASE, { ...TEMPLATE, bodyMd: "{{aluno.apelido}} {{campo.hora}} {{campo.destino}}" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({ code: "document_template_invalid", details: { variables: ["{{aluno.apelido}}", "{{campo.hora}}"] } });
    expect(await adminDb().selectFrom("documentTemplates").select("id").where("schoolId", "=", s.schoolId).execute()).toEqual([]);
  });

  it("archives a whole group: hidden from the list and closed to new versions", async () => {
    const s = await setup();
    const v1 = (await s.post(BASE, TEMPLATE)).json();
    const archived = await s.post(`${BASE}/${v1.id}/archive`, undefined, null);
    expect(archived.statusCode).toBe(204);
    expect((await s.get(BASE)).json().templates).toEqual([]);
    expect((await s.post(`${BASE}/${v1.id}/versions`, TEMPLATE)).statusCode).toBe(404);
    expect((await s.post(`${BASE}/${v1.id}/archive`, undefined, null)).statusCode).toBe(204);
  });

  it("copies a built-in example into a new template", async () => {
    const s = await setup();
    const examples = (await s.get(`${BASE}/examples`)).json().examples;
    expect(examples.map((e: { key: string }) => e.key)).toContain("autorizacao-passeio");
    const copy = await s.post(`${BASE}/from-example`, { exampleKey: "autorizacao-passeio" });
    expect(copy.statusCode).toBe(200);
    expect(copy.json()).toMatchObject({ name: "Autorização de passeio", category: "autorizacao", version: 1 });
    expect(copy.json().bodyMd).toContain("{{responsavel.cpf}}");
    expect((await s.post(`${BASE}/from-example`, { exampleKey: "nao-existe" })).statusCode).toBe(404);
  });

  it("replays a create with the same idempotency key", async () => {
    const s = await setup();
    const key = crypto.randomUUID();
    const a = await s.post(BASE, TEMPLATE, key);
    const b = await s.post(BASE, TEMPLATE, key);
    expect(b.json().id).toBe(a.json().id);
    expect((await s.post(BASE, TEMPLATE, null)).json().error.code).toBe("idempotency_key_required");
  });

  it("previews a PDF with sample data and writes nothing", async () => {
    const s = await setup();
    const res = await s.post(`${BASE}/preview`, TEMPLATE, null);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.rawPayload.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(await adminDb().selectFrom("documentTemplates").select("id").where("schoolId", "=", s.schoolId).execute()).toEqual([]);
    expect((await s.post(`${BASE}/preview`, { ...TEMPLATE, bodyMd: "{{x.y}}" }, null)).statusCode).toBe(422);
  });

  it("keeps templates per school and away from the kitchen role", async () => {
    const a = await setup();
    const b = await setup();
    const v1 = (await a.post(BASE, TEMPLATE)).json();
    expect((await b.get(`${BASE}/${v1.id}`)).statusCode).toBe(404);
    expect((await b.get(BASE)).json().templates).toEqual([]);
    const { cookies } = await staffCookie(a.schoolId, "cozinha");
    expect((await a.app.inject({ method: "GET", url: BASE, cookies })).statusCode).toBe(403);
    const post = await a.app.inject({ method: "POST", url: BASE, cookies, payload: TEMPLATE, headers: { "idempotency-key": crypto.randomUUID() } });
    expect(post.statusCode).toBe(403);
    expect(await adminDb().selectFrom("documentTemplates").select("id").where("schoolId", "=", a.schoolId).execute()).toHaveLength(1);
  });

  it("answers 409 when another edit inserts the same version first (constraint race)", async () => {
    const s = await setup();
    const v1 = (await s.post(BASE, TEMPLATE)).json();
    let pending!: ReturnType<typeof s.post>;
    // A outra edição grava a versão 2 e ainda não confirmou: esta enxerga a v1 como a mais recente e esbarra na constraint.
    await adminDb()
      .transaction()
      .execute(async (tx) => {
        await tx
          .insertInto("documentTemplates")
          .values({ id: uuidv7(), schoolId: s.schoolId, templateGroupId: v1.id, version: 2, name: "Outra", category: "outro", bodyMd: "# Outra", fields: JSON.stringify([]), createdBy: s.staffUserId })
          .execute();
        pending = s.post(`${BASE}/${v1.id}/versions`, TEMPLATE);
        await waitForLockWait("document_templates");
      });
    const res = await pending;
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("document_template_outdated");
    const versions = await adminDb().selectFrom("documentTemplates").select("name").where("templateGroupId", "=", v1.id).orderBy("version").execute();
    expect(versions.map((v) => v.name)).toEqual(["Autorização de passeio", "Outra"]);
  });

  it("never adds an unarchived version to a group archived concurrently", async () => {
    const s = await setup();
    const v1 = (await s.post(BASE, TEMPLATE)).json();
    let pending!: ReturnType<typeof s.post>;
    // O arquivamento trava as versões do grupo e ainda não confirmou quando a nova versão chega.
    await adminDb()
      .transaction()
      .execute(async (tx) => {
        await sql`SELECT id FROM document_templates WHERE template_group_id = ${v1.id} FOR UPDATE`.execute(tx);
        await tx.updateTable("documentTemplates").set({ archivedAt: sql`now()` }).where("templateGroupId", "=", v1.id).execute();
        pending = s.post(`${BASE}/${v1.id}/versions`, TEMPLATE);
        await waitForLockWait("document_templates");
      });
    expect((await pending).statusCode).toBe(404);
    const live = await adminDb().selectFrom("documentTemplates").select("id").where("templateGroupId", "=", v1.id).where("archivedAt", "is", null).execute();
    expect(live).toEqual([]);
  });

  it("archives a version created while the archive waited for the group", async () => {
    const s = await setup();
    const v1 = (await s.post(BASE, TEMPLATE)).json();
    let pending!: ReturnType<typeof s.post>;
    // Uma nova versão em andamento trava o grupo e grava a v2; o arquivamento chega antes de ela confirmar.
    await adminDb()
      .transaction()
      .execute(async (tx) => {
        await sql`SELECT id FROM document_templates WHERE template_group_id = ${v1.id} FOR UPDATE`.execute(tx);
        await tx
          .insertInto("documentTemplates")
          .values({ id: uuidv7(), schoolId: s.schoolId, templateGroupId: v1.id, version: 2, name: "Nova", category: "outro", bodyMd: "# Nova", fields: JSON.stringify([]), createdBy: s.staffUserId })
          .execute();
        pending = s.post(`${BASE}/${v1.id}/archive`, undefined, null);
        await waitForLockWait("document_templates");
      });
    expect((await pending).statusCode).toBe(204);
    const live = await adminDb().selectFrom("documentTemplates").select("version").where("templateGroupId", "=", v1.id).where("archivedAt", "is", null).execute();
    expect(live).toEqual([]);
  });
});
