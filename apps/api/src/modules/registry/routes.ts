import { ImportStudentsRequest, UpdateGuardianRequest, UpdateStudentRequest, Uuid } from "@app-lanche/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RouteAuth } from "../../app";
import * as service from "./service";

const OFFICE: RouteAuth = { kind: "staff", roles: ["admin", "secretaria"] };

const IdParams = z.object({ id: Uuid });

export async function registryRoutes(app: FastifyInstance): Promise<void> {
  // The CSV may hold 900,000 characters; accented ones take two bytes, so allow 2 MiB of JSON.
  app.post("/api/admin/v1/import/students", { config: { auth: OFFICE }, bodyLimit: 2 * 1024 * 1024 }, async (req) =>
    service.importStudents(req.session!, ImportStudentsRequest.parse(req.body).csv),
  );

  app.get("/api/admin/v1/classes", { config: { auth: OFFICE } }, async (req) =>
    service.listClasses(req.session!),
  );

  app.get("/api/admin/v1/students", { config: { auth: OFFICE } }, async (req) =>
    service.listStudents(req.session!),
  );

  // PUT is naturally idempotent: repeating it writes the same values (no Idempotency-Key).
  app.put("/api/admin/v1/students/:id", { config: { auth: OFFICE } }, async (req, reply) => {
    await service.updateStudent(req.session!, IdParams.parse(req.params).id, UpdateStudentRequest.parse(req.body));
    return reply.status(204).send();
  });

  app.get("/api/admin/v1/guardians/:id", { config: { auth: OFFICE } }, async (req) =>
    service.getGuardian(req.session!, IdParams.parse(req.params).id),
  );

  app.put("/api/admin/v1/guardians/:id", { config: { auth: OFFICE } }, async (req, reply) => {
    await service.updateGuardian(req.session!, IdParams.parse(req.params).id, UpdateGuardianRequest.parse(req.body));
    return reply.status(204).send();
  });
}
