import { SchoolSettings, Uuid, WalletAdjustmentRequest } from "@app-lanche/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RouteAuth } from "../../app";
import { idempotencyKeyFrom } from "../../platform/idempotency";
import * as service from "./service";

const GuardianParams = z.object({ guardianId: Uuid });
const ACCOUNTS: RouteAuth = { kind: "staff", roles: ["admin", "secretaria", "cozinha"] };
/** Carteira e Pix do responsável: escopo de pedido ou o escopo `wallet` dos links de aviso (spec F5B). */
export const GUARDIAN_WALLET: RouteAuth = { kind: "guardian", scope: ["order", "wallet"] };
const ADMIN: RouteAuth = { kind: "staff", roles: ["admin"] };

export async function walletRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/wallet", { config: { auth: GUARDIAN_WALLET } }, async (req) => service.getWallet(req.session!));

  app.post("/api/admin/v1/guardians/:guardianId/wallet/adjustments", { config: { auth: ADMIN } }, async (req) =>
    service.adjustBalance(req.session!, idempotencyKeyFrom(req), GuardianParams.parse(req.params).guardianId, WalletAdjustmentRequest.parse(req.body)),
  );

  app.post("/api/admin/v1/guardians/:guardianId/payment-requests", { config: { auth: ACCOUNTS } }, async (req) =>
    service.requestPayment(req.session!, idempotencyKeyFrom(req), GuardianParams.parse(req.params).guardianId),
  );

  app.get("/api/admin/v1/accounts", { config: { auth: ACCOUNTS } }, async (req) => service.listAccounts(req.session!));

  app.get("/api/admin/v1/guardians/:guardianId/statement", { config: { auth: ACCOUNTS } }, async (req) =>
    service.accountStatement(req.session!, GuardianParams.parse(req.params).guardianId),
  );

  app.get("/api/admin/v1/school/settings", { config: { auth: ACCOUNTS } }, async (req) => service.getSettings(req.session!));

  // PUT naturalmente idempotente (sem Idempotency-Key).
  app.put("/api/admin/v1/school/settings", { config: { auth: ADMIN } }, async (req) =>
    service.updateSettings(req.session!, SchoolSettings.parse(req.body)),
  );
}
