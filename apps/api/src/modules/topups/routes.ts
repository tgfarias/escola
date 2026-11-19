import { GuardianTopupRequest, StaffTopupRequest, Uuid } from "@app-lanche/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RouteAuth } from "../../app";
import { idempotencyKeyFrom } from "../../platform/idempotency";
import { GUARDIAN_WALLET } from "../wallet/routes";
import * as service from "./service";

const ACCOUNTS: RouteAuth = { kind: "staff", roles: ["admin", "secretaria", "cozinha"] };
const IdParams = z.object({ id: Uuid });
const GuardianParams = z.object({ guardianId: Uuid });

export async function topupRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/v1/topups", { config: { auth: GUARDIAN_WALLET } }, async (req) =>
    service.createGuardianTopup(req.session!, idempotencyKeyFrom(req), GuardianTopupRequest.parse(req.body), req.log),
  );
  app.get("/api/v1/topups/:id", { config: { auth: GUARDIAN_WALLET } }, async (req) =>
    service.getGuardianTopup(req.session!, IdParams.parse(req.params).id),
  );
  // Sem Idempotency-Key: só tenta de novo criar a cobrança, idempotente pelo id do pagamento.
  app.post("/api/v1/topups/:id/charge", { config: { auth: GUARDIAN_WALLET } }, async (req) =>
    service.retryGuardianCharge(req.session!, IdParams.parse(req.params).id, req.log),
  );

  app.post("/api/admin/v1/guardians/:guardianId/topups", { config: { auth: ACCOUNTS } }, async (req) =>
    service.createStaffTopup(req.session!, idempotencyKeyFrom(req), GuardianParams.parse(req.params).guardianId, StaffTopupRequest.parse(req.body), req.log),
  );
  app.get("/api/admin/v1/topups/:id", { config: { auth: ACCOUNTS } }, async (req) => service.getStaffTopup(req.session!, IdParams.parse(req.params).id));
  app.post("/api/admin/v1/topups/:id/charge", { config: { auth: ACCOUNTS } }, async (req) =>
    service.retryStaffCharge(req.session!, IdParams.parse(req.params).id, req.log),
  );
}
