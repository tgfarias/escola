import { CopyExampleRequest, CreateBatchRequest, TemplateInput, Uuid } from "@app-lanche/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RouteAuth } from "../../app";
import { idempotencyKeyFrom } from "../../platform/idempotency";
import { LOCAL_FILES_ROUTE } from "../../platform/storage";
import * as service from "./service";

export const OFFICE: RouteAuth = { kind: "staff", roles: ["admin", "secretaria"] };
const IdParams = z.object({ id: Uuid });

export async function documentRoutes(app: FastifyInstance): Promise<void> {
  const T = "/api/admin/v1/document-templates";

  app.get(T, { config: { auth: OFFICE } }, async (req) => service.listTemplates(req.session!));
  app.get(`${T}/examples`, { config: { auth: OFFICE } }, async () => service.listExamples());
  app.get(`${T}/:id`, { config: { auth: OFFICE } }, async (req) => service.getTemplate(req.session!, IdParams.parse(req.params).id));

  app.post(T, { config: { auth: OFFICE } }, async (req) =>
    service.createTemplate(req.session!, idempotencyKeyFrom(req), TemplateInput.parse(req.body)),
  );
  app.post(`${T}/from-example`, { config: { auth: OFFICE } }, async (req) =>
    service.copyExample(req.session!, idempotencyKeyFrom(req), CopyExampleRequest.parse(req.body).exampleKey),
  );
  app.post(`${T}/:id/versions`, { config: { auth: OFFICE } }, async (req) =>
    service.createVersion(req.session!, idempotencyKeyFrom(req), IdParams.parse(req.params).id, TemplateInput.parse(req.body)),
  );
  // Arquivar de novo não muda nada: idempotente por natureza.
  app.post(`${T}/:id/archive`, { config: { auth: OFFICE } }, async (req, reply) => {
    await service.archiveTemplate(req.session!, IdParams.parse(req.params).id);
    return reply.status(204).send();
  });
  // Prévia não grava estado.
  app.post(`${T}/preview`, { config: { auth: OFFICE } }, async (req, reply) => {
    const pdf = await service.previewTemplate(req.session!, TemplateInput.parse(req.body));
    return reply.type("application/pdf").send(pdf);
  });

  const B = "/api/admin/v1/document-batches";
  app.post(B, { config: { auth: OFFICE } }, async (req) =>
    service.createBatch(req.session!, idempotencyKeyFrom(req), CreateBatchRequest.parse(req.body)),
  );
  app.get(B, { config: { auth: OFFICE } }, async (req) => service.listBatches(req.session!));
  app.get(`${B}/:id`, { config: { auth: OFFICE } }, async (req) => service.getBatch(req.session!, IdParams.parse(req.params).id));

  app.post(`${B}/:id/publish`, { config: { auth: OFFICE } }, async (req) =>
    service.publishBatch(req.session!, idempotencyKeyFrom(req), IdParams.parse(req.params).id),
  );

  // Naturalmente idempotente: repetir só continua de onde parou (spec 8.3).
  app.post(`${B}/:id/render`, { config: { auth: OFFICE } }, async (req) =>
    service.renderBatch(req.session!, IdParams.parse(req.params).id, { log: req.log }),
  );
  app.post("/api/admin/v1/documents/:id/discard", { config: { auth: OFFICE } }, async (req, reply) => {
    await service.discardDocument(req.session!, IdParams.parse(req.params).id);
    return reply.status(204).send();
  });
  app.post("/api/admin/v1/documents/:id/download", { config: { auth: OFFICE } }, async (req) =>
    service.staffDownload(req.session!, IdParams.parse(req.params).id),
  );

  const GUARDIAN: RouteAuth = { kind: "guardian", scope: ["order", "documents"] };
  app.get("/api/v1/documents", { config: { auth: GUARDIAN } }, async (req) => service.listGuardianDocuments(req.session!));
  // Sem Idempotency-Key: registrar a abertura é idempotente por constraint (spec 8.4).
  app.post("/api/v1/documents/:id/download", { config: { auth: GUARDIAN } }, async (req) =>
    service.guardianDownload(req.session!, IdParams.parse(req.params).id),
  );

  // Disco local: o token vai na query string, que o log de requisição descarta.
  const FileQuery = z.object({ t: z.string().min(1).max(2000) });
  app.get(LOCAL_FILES_ROUTE, { config: { auth: "public" } }, async (req, reply) => {
    const pdf = await service.readSignedFile(FileQuery.parse(req.query).t);
    return reply.type("application/pdf").header("content-disposition", 'inline; filename="documento.pdf"').send(pdf);
  });
}
