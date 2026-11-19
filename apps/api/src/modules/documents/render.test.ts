import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { describe, expect, it } from "vitest";
import { adminDb, seedFamily } from "../../../test/helpers";
import { documentsSetup } from "../../../test/documents";
import type { SessionClaims } from "../../platform/session";
import { renderDocument } from "./pdf";
import * as service from "./service";

const BODY = "# Declaração\n\n{{aluno.primeiro_nome}} — {{turma.nome}}";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const file = (path: string) => join(process.env.LOCAL_STORAGE_DIR!, path);

async function batchWith(names: string[]) {
  const s = await documentsSetup();
  const extra = names.length > 0 ? (await seedFamily(s.schoolId, names)).studentIds : [];
  const templateId = await s.template(BODY);
  const batch = (await s.post("/api/admin/v1/document-batches", { templateId, studentIds: [s.leo, s.bia, ...extra], fieldValues: {} })).json();
  const session: SessionClaims = { kind: "staff", sub: s.staffUserId, schoolId: s.schoolId, role: "secretaria" };
  const render = () => s.post(`/api/admin/v1/document-batches/${batch.id}/render`, undefined, null);
  const docs = () => adminDb().selectFrom("documents").selectAll().where("batchId", "=", batch.id).orderBy("id").execute();
  return { ...s, batchId: batch.id as string, session, render, docs };
}

describe("rendering", () => {
  it("renders in chunks of 10, stores each PDF once and records its hash", async () => {
    const b = await batchWith(Array.from({ length: 10 }, (_, i) => `Aluno${i}`));
    const first = await b.render();
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ status: "rendering", counts: { total: 12, pending: 2, rendering: 0, rendered: 10, failed: 0, discarded: 0 } });
    expect((await b.render()).json()).toMatchObject({ status: "ready", counts: { rendered: 12, pending: 0 } });
    for (const d of await b.docs()) {
      expect(d).toMatchObject({ status: "rendered", attempts: 1, leaseUntil: null, storagePath: `schools/${b.schoolId}/documents/${b.batchId}/${d.id}.pdf` });
      const bytes = await readFile(file(d.storagePath!));
      expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      expect(d.sha256).toBe(sha(bytes));
    }
    expect((await b.render()).json()).toMatchObject({ status: "ready" });
  });

  it("never renders a document twice when two tabs render at once", async () => {
    const b = await batchWith(Array.from({ length: 14 }, (_, i) => `Aluno${i}`));
    await Promise.all([b.render(), b.render()]);
    await b.render();
    await b.render();
    const docs = await b.docs();
    expect(docs.every((d) => d.status === "rendered" && d.attempts === 1)).toBe(true);
  });

  it("retries a failing document and marks it failed on the third attempt", async () => {
    const b = await batchWith([]);
    const boom = async () => {
      throw new Error("boom");
    };
    const warnings: object[] = [];
    const log = { warn: (obj: object) => warnings.push(obj) };
    await service.renderBatch(b.session, b.batchId, { render: boom, log });
    await service.renderBatch(b.session, b.batchId, { render: boom, log });
    const last = await service.renderBatch(b.session, b.batchId, { render: boom, log });
    expect(last).toEqual({ status: "ready", counts: { total: 2, pending: 0, rendering: 0, rendered: 0, failed: 2, discarded: 0 } });
    expect((await b.docs()).map((d) => [d.status, d.attempts])).toEqual([["failed", 3], ["failed", 3]]);
    expect(warnings).toHaveLength(6);
    expect(JSON.stringify(warnings)).not.toMatch(/Léo|Bia|Souza/);
  });

  it("takes back an expired lease and fails one that has no attempts left", async () => {
    const b = await batchWith([]);
    const [d1, d2] = await b.docs();
    await adminDb().updateTable("documents").set({ status: "rendering", attempts: 1, leaseUntil: sql`now() - interval '1 second'` }).where("id", "=", d1!.id).execute();
    await adminDb().updateTable("documents").set({ status: "rendering", attempts: 3, leaseUntil: sql`now() - interval '1 second'` }).where("id", "=", d2!.id).execute();
    expect((await b.render()).json()).toMatchObject({ status: "ready", counts: { rendered: 1, failed: 1 } });
    const after = await b.docs();
    expect(after.find((d) => d.id === d1!.id)).toMatchObject({ status: "rendered", attempts: 2 });
    expect(after.find((d) => d.id === d2!.id)).toMatchObject({ status: "failed", attempts: 3 });
  });

  it("ignores a stale worker's result once the document was reclaimed with a higher attempt", async () => {
    const b = await batchWith([]);
    // Enquanto o primeiro worker desenha, o arrendamento vence e outro worker reserva de novo (attempts 2).
    const reclaim = (id: string) =>
      adminDb().updateTable("documents").set({ status: "rendering", attempts: 2, leaseUntil: sql`now() + interval '2 minutes'` }).where("id", "=", id).execute();
    const stale = async (title: string, body: string, ctx: Parameters<typeof renderDocument>[2]) => {
      const doc = (await b.docs()).find((d) => d.studentId === (ctx.student.firstName === "Léo" ? b.leo : b.bia))!;
      await reclaim(doc.id);
      return renderDocument(title, body, ctx);
    };
    const progress = await service.renderBatch(b.session, b.batchId, { render: stale });
    expect(progress).toEqual({ status: "rendering", counts: { total: 2, pending: 0, rendering: 2, rendered: 0, failed: 0, discarded: 0 } });
    for (const d of await b.docs()) expect(d).toMatchObject({ status: "rendering", attempts: 2, storagePath: null, sha256: null, renderedAt: null });

    const other = await batchWith([]);
    const failing = async (_t: string, _b: string, ctx: Parameters<typeof renderDocument>[2]) => {
      const doc = (await other.docs()).find((d) => d.studentId === (ctx.student.firstName === "Léo" ? other.leo : other.bia))!;
      await reclaim(doc.id);
      throw new Error("x");
    };
    await service.renderBatch(other.session, other.batchId, { render: failing });
    for (const d of await other.docs()) expect(d).toMatchObject({ status: "rendering", attempts: 2 });
    expect((await other.docs()).every((d) => d.leaseUntil !== null)).toBe(true);
  });

  it("keeps the stored object when one already exists and records the hash of its bytes", async () => {
    const b = await batchWith([]);
    const [d1] = await b.docs();
    const path = `schools/${b.schoolId}/documents/${b.batchId}/${d1!.id}.pdf`;
    await mkdir(dirname(file(path)), { recursive: true });
    await writeFile(file(path), "%PDF-1.7 earlier attempt");
    await b.render();
    const row = (await b.docs()).find((d) => d.id === d1!.id)!;
    expect(row.sha256).toBe(sha(Buffer.from("%PDF-1.7 earlier attempt")));
    expect((await readFile(file(path))).toString()).toBe("%PDF-1.7 earlier attempt");
  });

  it("discards only failed documents of an unpublished batch", async () => {
    const b = await batchWith([]);
    await service.renderBatch(b.session, b.batchId, { render: (title, body, ctx) => (ctx.student.firstName === "Bia" ? Promise.reject(new Error("x")) : renderDocument(title, body, ctx)) });
    for (let i = 0; i < 2; i += 1) await service.renderBatch(b.session, b.batchId, { render: async () => Promise.reject(new Error("x")) });
    const docs = await b.docs();
    const failed = docs.find((d) => d.status === "failed")!;
    const rendered = docs.find((d) => d.status === "rendered")!;
    const discard = (id: string) => b.post(`/api/admin/v1/documents/${id}/discard`, undefined, null);
    expect((await discard(rendered.id)).statusCode).toBe(400);
    expect((await discard(failed.id)).statusCode).toBe(204);
    expect((await discard(failed.id)).statusCode).toBe(204);
    const detail = (await b.get(`/api/admin/v1/document-batches/${b.batchId}`)).json();
    expect(detail.counts).toMatchObject({ rendered: 1, failed: 0, discarded: 1 });
    await adminDb().updateTable("documentBatches").set({ status: "published", publishedAt: new Date() }).where("id", "=", b.batchId).execute();
    await adminDb().updateTable("documents").set({ discardedAt: null }).where("id", "=", failed.id).execute();
    expect((await discard(failed.id)).json().error.code).toBe("document_batch_published");
  });

  it("lets staff download a rendered PDF by a signed local URL, audited", async () => {
    const b = await batchWith([]);
    await b.render();
    const [d1] = await b.docs();
    const res = await b.post(`/api/admin/v1/documents/${d1!.id}/download`, undefined, null);
    expect(res.statusCode).toBe(200);
    const { url } = res.json();
    expect(url).toMatch(/^\/api\/v1\/files\?t=/);
    const pdf = await b.app.inject({ method: "GET", url });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(sha(pdf.rawPayload)).toBe(d1!.sha256);
    const tampered = await b.app.inject({ method: "GET", url: `${url.slice(0, -3)}abc` });
    expect(tampered.statusCode).toBe(404);
    const audit = await adminDb().selectFrom("auditLog").select(["actorKind", sql<string>`detail::text`.as("detail")]).where("schoolId", "=", b.schoolId).where("action", "=", "document.downloaded").execute();
    expect(audit).toEqual([{ actorKind: "staff", detail: expect.stringContaining(d1!.id) }]);
  });

  it("answers 404 for a pending document, another school's document and an unknown batch", async () => {
    const b = await batchWith([]);
    const other = await batchWith([]);
    const [d1] = await b.docs();
    expect((await b.post(`/api/admin/v1/documents/${d1!.id}/download`, undefined, null)).statusCode).toBe(404);
    expect((await other.post(`/api/admin/v1/documents/${d1!.id}/discard`, undefined, null)).statusCode).toBe(404);
    expect((await b.post(`/api/admin/v1/document-batches/${uuidv7()}/render`, undefined, null)).statusCode).toBe(404);
    expect((await other.post(`/api/admin/v1/document-batches/${b.batchId}/render`, undefined, null)).statusCode).toBe(404);
  });
});
