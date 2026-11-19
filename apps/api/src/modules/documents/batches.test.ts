import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { describe, expect, it } from "vitest";
import { documentsSetup } from "../../../test/documents";
import { adminDb, seedFamily } from "../../../test/helpers";

const STUDENT_BODY = "# Declaração\n\n{{aluno.nome_completo}}, nascido(a) em {{aluno.data_nascimento}}, turma {{turma.nome}}. Passeio: {{campo.destino}} em {{campo.data_passeio}}.";
const GUARDIAN_BODY = "# Autorização\n\nEu, {{responsavel.nome_completo}}, CPF {{responsavel.cpf}}, autorizo {{aluno.primeiro_nome}}.";
const FIELDS = [
  { key: "destino", label: "Destino", type: "texto" },
  { key: "data_passeio", label: "Data", type: "data" },
];

describe("document batches", () => {
  it("creates one pending document per student with the field values and the school's date", async () => {
    const s = await documentsSetup();
    const templateId = await s.template(STUDENT_BODY, FIELDS);
    const res = await s.post("/api/admin/v1/document-batches", { templateId, studentIds: [s.leo, s.bia], fieldValues: { destino: "Zoológico", data_passeio: "2026-12-05" } });
    expect(res.statusCode).toBe(200);
    const batch = res.json();
    expect(batch).toMatchObject({ templateId, templateVersion: 1, status: "rendering", publishedAt: null, counts: { total: 2, pending: 2, rendering: 0, rendered: 0, failed: 0, discarded: 0 }, recipients: 1, viewers: 0 });
    const docs = await adminDb().selectFrom("documents").select(["studentId", "guardianId", "status"]).where("batchId", "=", batch.id).execute();
    expect(docs).toHaveLength(2);
    expect(docs.every((d) => d.guardianId === null && d.status === "pending")).toBe(true);
    const row = await adminDb().selectFrom("documentBatches").select([sql<string>`field_values::text`.as("values"), "issuedOn", "perGuardian", "createdBy"]).where("id", "=", batch.id).executeTakeFirstOrThrow();
    expect(JSON.parse(row.values)).toEqual({ destino: "Zoológico", data_passeio: "2026-12-05" });
    expect(row.perGuardian).toBe(false);
    expect(row.createdBy).toBe(s.staffUserId);
    const { rows } = await sql<{ today: string }>`SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date::text AS today`.execute(adminDb());
    expect(row.issuedOn).toBe(rows[0]!.today);
  });

  it("creates one document per student and guardian when the template addresses guardians", async () => {
    const s = await documentsSetup();
    const second = uuidv7();
    await adminDb().insertInto("guardians").values({ id: second, schoolId: s.schoolId, phoneE164: "+5511977770001", firstName: "Rui", fullName: "Rui Souza", cpf: "11144477735" }).execute();
    await adminDb().insertInto("guardianStudents").values({ schoolId: s.schoolId, guardianId: second, studentId: s.leo }).execute();
    const templateId = await s.template(GUARDIAN_BODY);
    const res = await s.post("/api/admin/v1/document-batches", { templateId, studentIds: [s.leo, s.bia], fieldValues: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ counts: { total: 3 }, recipients: 2 });
    const docs = await adminDb().selectFrom("documents").select(["studentId", "guardianId"]).where("batchId", "=", res.json().id).execute();
    expect(docs.map((d) => `${d.studentId}:${d.guardianId}`).sort()).toEqual([`${s.leo}:${s.guardianId}`, `${s.leo}:${second}`, `${s.bia}:${s.guardianId}`].sort());
  });

  it("refuses a batch with missing data and lists who to fix, by id only", async () => {
    const s = await documentsSetup();
    await adminDb().updateTable("students").set({ birthDate: null }).where("id", "=", s.bia).execute();
    const templateId = await s.template(STUDENT_BODY, FIELDS);
    const res = await s.post("/api/admin/v1/document-batches", { templateId, studentIds: [s.leo, s.bia], fieldValues: { destino: "Zoo", data_passeio: "2026-12-05" } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toEqual({
      code: "document_missing_data",
      message: expect.any(String),
      details: { missing: [{ studentId: s.bia, guardianId: null, variables: ["aluno.data_nascimento"] }] },
    });
    expect(await adminDb().selectFrom("documentBatches").select("id").where("schoolId", "=", s.schoolId).execute()).toEqual([]);

    await adminDb().updateTable("guardians").set({ cpf: null }).where("id", "=", s.guardianId).execute();
    const lonely = (await seedFamily(s.schoolId, ["Caio"])).studentIds[0]!;
    await adminDb().deleteFrom("guardianStudents").where("studentId", "=", lonely).execute();
    const g = await s.template(GUARDIAN_BODY);
    const res2 = await s.post("/api/admin/v1/document-batches", { templateId: g, studentIds: [s.leo, lonely], fieldValues: {} });
    expect(res2.json().error.details.missing).toEqual([
      { studentId: s.leo, guardianId: s.guardianId, variables: ["responsavel.cpf"] },
      { studentId: lonely, guardianId: null, variables: ["responsavel.nome_completo", "responsavel.cpf"] },
    ]);
  });

  it("validates the field values against the template", async () => {
    const s = await documentsSetup();
    const templateId = await s.template(STUDENT_BODY, FIELDS);
    const create = (fieldValues: Record<string, string>) => s.post("/api/admin/v1/document-batches", { templateId, studentIds: [s.leo], fieldValues });
    expect((await create({ destino: "Zoo" })).statusCode).toBe(400);
    expect((await create({ destino: "Zoo", data_passeio: "05/12/2026" })).statusCode).toBe(400);
    expect((await create({ destino: "Zoo", data_passeio: "2026-12-05", extra: "x" })).statusCode).toBe(400);
  });

  it("answers 404 for unknown or foreign students and archived templates", async () => {
    const s = await documentsSetup();
    const other = await documentsSetup();
    const templateId = await s.template(STUDENT_BODY, FIELDS);
    const values = { destino: "Zoo", data_passeio: "2026-12-05" };
    expect((await s.post("/api/admin/v1/document-batches", { templateId, studentIds: [other.leo], fieldValues: values })).statusCode).toBe(404);
    await s.post(`/api/admin/v1/document-templates/${templateId}/archive`, undefined, null);
    expect((await s.post("/api/admin/v1/document-batches", { templateId, studentIds: [s.leo], fieldValues: values })).statusCode).toBe(404);
  });

  it("lists batches and shows the detail with documents and an audit entry", async () => {
    const s = await documentsSetup();
    const templateId = await s.template(STUDENT_BODY, FIELDS);
    const key = crypto.randomUUID();
    const body = { templateId, studentIds: [s.leo, s.bia], fieldValues: { destino: "Zoo", data_passeio: "2026-12-05" } };
    const batch = (await s.post("/api/admin/v1/document-batches", body, key)).json();
    expect((await s.post("/api/admin/v1/document-batches", body, key)).json().id).toBe(batch.id);
    expect((await s.get("/api/admin/v1/document-batches")).json().batches.map((b: { id: string }) => b.id)).toEqual([batch.id]);
    const detail = (await s.get(`/api/admin/v1/document-batches/${batch.id}`)).json();
    expect(detail).toMatchObject({ id: batch.id, fieldValues: { destino: "Zoo", data_passeio: "2026-12-05" } });
    expect(detail.documents.map((d: { studentFirstName: string }) => d.studentFirstName).sort()).toEqual(["Bia", "Léo"]);
    expect(detail.documents[0]).toMatchObject({ className: "Infantil 3A", guardianId: null, status: "pending", discarded: false, viewed: false });
    const audit = await adminDb().selectFrom("auditLog").select([sql<string>`detail::text`.as("detail")]).where("schoolId", "=", s.schoolId).where("action", "=", "document_batch.created").execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.detail).not.toContain("Zoo");
  });
});
