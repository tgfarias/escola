import { CopyExampleRequest, TemplateInput, Uuid } from "@app-lanche/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RouteAuth } from "../../app";
import { idempotencyKeyFrom } from "../../platform/idempotency";
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
}
