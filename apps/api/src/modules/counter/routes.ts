import { StaffCounterSaleRequest, Uuid } from "@app-lanche/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RouteAuth } from "../../app";
import { idempotencyKeyFrom } from "../../platform/idempotency";
import * as service from "./service";

const OFFICE: RouteAuth = { kind: "staff", roles: ["admin", "secretaria"] };
const IdParams = z.object({ id: Uuid });

export async function counterRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/admin/v1/counter/roster", { config: { auth: OFFICE } }, async (req) => service.roster(req.session!.schoolId));

  app.post("/api/admin/v1/counter-sales", { config: { auth: OFFICE } }, async (req) =>
    service.createStaffSale(req.session!, idempotencyKeyFrom(req), StaffCounterSaleRequest.parse(req.body)),
  );

  // Naturalmente idempotente: estornar de novo não lança outra vez (unicidade do ledger e voided_at).
  app.post("/api/admin/v1/counter-sales/:id/void", { config: { auth: OFFICE } }, async (req) =>
    service.voidStaffSale(req.session!, IdParams.parse(req.params).id),
  );
}
