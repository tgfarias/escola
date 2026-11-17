import { ImportStudentsRequest } from "@app-lanche/contracts";
import type { FastifyInstance } from "fastify";
import type { RouteAuth } from "../../app";
import * as service from "./service";

const OFFICE: RouteAuth = { kind: "staff", roles: ["admin", "secretaria"] };

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
}
