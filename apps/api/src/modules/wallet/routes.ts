import { Uuid, WalletAdjustmentRequest } from "@app-lanche/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { idempotencyKeyFrom } from "../../platform/idempotency";
import * as service from "./service";

const GuardianParams = z.object({ guardianId: Uuid });

export async function walletRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/wallet", { config: { auth: { kind: "guardian", scope: "order" } } }, async (req) =>
    service.getWallet(req.session!),
  );

  app.post(
    "/api/admin/v1/guardians/:guardianId/wallet/adjustments",
    { config: { auth: { kind: "staff", roles: ["admin"] } } },
    async (req) =>
      service.adjustBalance(
        req.session!,
        idempotencyKeyFrom(req),
        GuardianParams.parse(req.params).guardianId,
        WalletAdjustmentRequest.parse(req.body),
      ),
  );
}
