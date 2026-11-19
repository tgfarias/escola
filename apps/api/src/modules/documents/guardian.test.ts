import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { describe, expect, it } from "vitest";
import { documentsSetup } from "../../../test/documents";
import { adminDb, guardianCookie, seedFamily } from "../../../test/helpers";

async function published(bodyMd: string, opts: { secondGuardian?: boolean } = {}) {
  const s = await documentsSetup();
  let second: string | null = null;
  if (opts.secondGuardian) {
    second = uuidv7();
    await adminDb().insertInto("guardians").values({ id: second, schoolId: s.schoolId, phoneE164: "+5511977770003", firstName: "Rui", fullName: "Rui Souza", cpf: "11144477735" }).execute();
    await adminDb().insertInto("guardianStudents").values({ schoolId: s.schoolId, guardianId: second, studentId: s.leo }).execute();
  }
  const templateId = await s.template(bodyMd);
  const batchId = (await s.post("/api/admin/v1/document-batches", { templateId, studentIds: [s.leo, s.bia], fieldValues: {} })).json().id as string;
  await s.post(`/api/admin/v1/document-batches/${batchId}/render`, undefined, null);
  return { ...s, second, batchId, templateId };
}

describe("guardian documents", () => {
  it("lists only published documents of the guardian's children, with any scope", async () => {
    const s = await published("# Declaração de matrícula\n\n{{aluno.nome_completo}}");
    const list = (scope: "order" | "documents") =>
      guardianCookie(s.schoolId, s.guardianId, scope).then((cookies) => s.app.inject({ method: "GET", url: "/api/v1/documents", cookies }));
    expect((await list("order")).json()).toEqual({ documents: [] });
    await s.post(`/api/admin/v1/document-batches/${s.batchId}/publish`);
    for (const scope of ["order", "documents"] as const) {
      const res = await list(scope);
      expect(res.statusCode).toBe(200);
      expect(res.json().documents.map((d: { studentFirstName: string }) => d.studentFirstName).sort()).toEqual(["Bia", "Léo"]);
      expect(res.json().documents[0]).toMatchObject({ title: "Modelo", category: "outro", viewed: false });
    }
    const stranger = await seedFamily(s.schoolId, ["Caio"]);
    const other = await s.app.inject({ method: "GET", url: "/api/v1/documents", cookies: await guardianCookie(s.schoolId, stranger.guardianId) });
    expect(other.json()).toEqual({ documents: [] });
  });

  it("shows a per-guardian document only to its guardian", async () => {
    const s = await published("# Autorização\n\n{{responsavel.nome_completo}} autoriza {{aluno.primeiro_nome}}.", { secondGuardian: true });
    await s.post(`/api/admin/v1/document-batches/${s.batchId}/publish`);
    const titlesOf = async (guardianId: string) =>
      (await s.app.inject({ method: "GET", url: "/api/v1/documents", cookies: await guardianCookie(s.schoolId, guardianId, "documents") })).json().documents.map(
        (d: { studentFirstName: string }) => d.studentFirstName,
      );
    expect((await titlesOf(s.guardianId)).sort()).toEqual(["Bia", "Léo"]);
    expect(await titlesOf(s.second!)).toEqual(["Léo"]);
    const ruiDoc = await adminDb().selectFrom("documents").select("id").where("batchId", "=", s.batchId).where("guardianId", "=", s.second).executeTakeFirstOrThrow();
    const forbidden = await s.app.inject({ method: "POST", url: `/api/v1/documents/${ruiDoc.id}/download`, cookies: await guardianCookie(s.schoolId, s.guardianId) });
    expect(forbidden.statusCode).toBe(404);
  });

  it("downloads by a signed URL, records the first opening once and audits every download", async () => {
    const s = await published("# Declaração\n\n{{aluno.nome_completo}}");
    await s.post(`/api/admin/v1/document-batches/${s.batchId}/publish`);
    const cookies = await guardianCookie(s.schoolId, s.guardianId, "documents");
    const [doc] = (await s.app.inject({ method: "GET", url: "/api/v1/documents", cookies })).json().documents;
    const download = () => s.app.inject({ method: "POST", url: `/api/v1/documents/${doc.id}/download`, cookies });
    const first = await download();
    expect(first.statusCode).toBe(200);
    const pdf = await s.app.inject({ method: "GET", url: first.json().url });
    expect(pdf.rawPayload.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    await download();
    const views = await adminDb().selectFrom("documentViews").select(["guardianId"]).where("documentId", "=", doc.id).execute();
    expect(views).toEqual([{ guardianId: s.guardianId }]);
    const audits = await adminDb().selectFrom("auditLog").select(["actorKind", "actorId"]).where("schoolId", "=", s.schoolId).where("action", "=", "document.downloaded").execute();
    expect(audits).toEqual([
      { actorKind: "guardian", actorId: s.guardianId },
      { actorKind: "guardian", actorId: s.guardianId },
    ]);
    expect((await s.app.inject({ method: "GET", url: "/api/v1/documents", cookies })).json().documents.find((d: { id: string }) => d.id === doc.id).viewed).toBe(true);
    expect((await s.get("/api/admin/v1/document-batches")).json().batches[0]).toMatchObject({ recipients: 1, viewers: 1 });
    const detail = (await s.get(`/api/admin/v1/document-batches/${s.batchId}`)).json();
    expect(detail.documents.find((d: { id: string }) => d.id === doc.id).viewed).toBe(true);
    const row = await adminDb().selectFrom("documentViews").select(sql<boolean>`first_viewed_at <= now()`.as("ok")).where("documentId", "=", doc.id).executeTakeFirstOrThrow();
    expect(row.ok).toBe(true);
  });

  it("does not serve unpublished documents or documents of another school", async () => {
    const s = await published("# Declaração\n\n{{aluno.nome_completo}}");
    const doc = await adminDb().selectFrom("documents").select("id").where("batchId", "=", s.batchId).executeTakeFirstOrThrow();
    const cookies = await guardianCookie(s.schoolId, s.guardianId);
    expect((await s.app.inject({ method: "POST", url: `/api/v1/documents/${doc.id}/download`, cookies })).statusCode).toBe(404);
    const other = await documentsSetup();
    const foreign = await other.app.inject({ method: "POST", url: `/api/v1/documents/${doc.id}/download`, cookies: await guardianCookie(other.schoolId, other.guardianId) });
    expect(foreign.statusCode).toBe(404);
    expect(await adminDb().selectFrom("documentViews").select("id").where("documentId", "=", doc.id).execute()).toEqual([]);
  });
});
