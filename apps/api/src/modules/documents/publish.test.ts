import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { describe, expect, it } from "vitest";
import { documentsSetup } from "../../../test/documents";
import { adminDb } from "../../../test/helpers";
import type { SessionClaims } from "../../platform/session";
import * as service from "./service";

const GUARDIAN_BODY = "# Autorização\n\nEu, {{responsavel.nome_completo}}, CPF {{responsavel.cpf}}, autorizo {{aluno.nome_completo}}.";

async function renderedBatch(bodyMd: string, opts: { secondGuardian?: boolean } = {}) {
  const s = await documentsSetup();
  let second: string | null = null;
  if (opts.secondGuardian) {
    second = uuidv7();
    await adminDb().insertInto("guardians").values({ id: second, schoolId: s.schoolId, phoneE164: "+5511977770002", firstName: "Rui", fullName: "Rui Souza", cpf: "11144477735" }).execute();
    await adminDb().insertInto("guardianStudents").values({ schoolId: s.schoolId, guardianId: second, studentId: s.leo }).execute();
  }
  const templateId = await s.template(bodyMd);
  const batchId = (await s.post("/api/admin/v1/document-batches", { templateId, studentIds: [s.leo, s.bia], fieldValues: {} })).json().id as string;
  const publish = (key = crypto.randomUUID()) => s.post(`/api/admin/v1/document-batches/${batchId}/publish`, undefined, key);
  const session: SessionClaims = { kind: "staff", sub: s.staffUserId, schoolId: s.schoolId, role: "secretaria" };
  const events = async () =>
    (await adminDb().selectFrom("outboxEvents").select(sql<string>`data::text`.as("data")).where("schoolId", "=", s.schoolId).where("type", "=", "document.published").execute()).map(
      (e) => JSON.parse(e.data) as Record<string, unknown>,
    );
  return { ...s, second, batchId, publish, session, events };
}

describe("publishing", () => {
  it("refuses while documents are pending or failed, then publishes once with one event per guardian", async () => {
    const b = await renderedBatch("# Declaração\n\n{{aluno.nome_completo}}");
    expect((await b.publish()).json().error.code).toBe("document_batch_not_ready");
    await service.renderBatch(b.session, b.batchId, { render: () => Promise.reject(new Error("x")) });
    await service.renderBatch(b.session, b.batchId, { render: () => Promise.reject(new Error("x")) });
    await service.renderBatch(b.session, b.batchId, { render: () => Promise.reject(new Error("x")) });
    expect((await b.publish()).json().error.code).toBe("document_batch_not_ready");

    const fresh = await renderedBatch("# Declaração\n\n{{aluno.nome_completo}}");
    await fresh.post(`/api/admin/v1/document-batches/${fresh.batchId}/render`, undefined, null);
    const res = await fresh.publish();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "published", recipients: 1, viewers: 0 });
    expect(res.json().publishedAt).not.toBeNull();
    const events = await fresh.events();
    expect(events).toEqual([
      { guardian_id: fresh.guardianId, phone: expect.stringMatching(/^\+55/), first_name: "Ana", batch_id: fresh.batchId, template_name: "Modelo", students: ["Bia", "Léo"] },
    ]);
    const again = await fresh.publish();
    expect(again.statusCode).toBe(200);
    expect(await fresh.events()).toHaveLength(1);
    const audit = await adminDb().selectFrom("auditLog").select("action").where("schoolId", "=", fresh.schoolId).where("action", "=", "document_batch.published").execute();
    expect(audit).toHaveLength(1);
  });

  it("publishes after discarding the failed documents and never puts CPF or full names in events", async () => {
    const b = await renderedBatch(GUARDIAN_BODY, { secondGuardian: true });
    const { renderDocument } = await import("./pdf");
    await service.renderBatch(b.session, b.batchId, {
      render: (title, body, ctx) => (ctx.guardian?.firstName === "Rui" ? Promise.reject(new Error("x")) : renderDocument(title, body, ctx)),
    });
    for (let i = 0; i < 2; i += 1) await service.renderBatch(b.session, b.batchId, { render: () => Promise.reject(new Error("x")) });
    const failed = await adminDb().selectFrom("documents").select("id").where("batchId", "=", b.batchId).where("status", "=", "failed").executeTakeFirstOrThrow();
    expect((await b.post(`/api/admin/v1/documents/${failed.id}/discard`, undefined, null)).statusCode).toBe(204);
    expect((await b.publish()).statusCode).toBe(200);
    const events = await b.events();
    expect(events).toEqual([expect.objectContaining({ guardian_id: b.guardianId, students: ["Bia", "Léo"] })]);
    const raw = JSON.stringify(events);
    for (const secret of ["52998224725", "529.982.247-25", "Souza", "Ana Paula"]) expect(raw).not.toContain(secret);
  });
});
