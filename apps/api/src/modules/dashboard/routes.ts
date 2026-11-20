import { DashboardQuery } from "@app-lanche/contracts";
import type { FastifyInstance } from "fastify";
import type { RouteAuth } from "../../app";
import * as service from "./service";

const STAFF: RouteAuth = { kind: "staff", roles: ["admin", "secretaria", "cozinha"] };

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/admin/v1/dashboard", { config: { auth: STAFF } }, async (req) =>
    service.getDashboard(req.session!, DashboardQuery.parse(req.query)),
  );
}
