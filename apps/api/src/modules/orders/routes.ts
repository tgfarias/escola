import { CheckoutListQuery, CreateCheckoutRequest, Uuid } from "@app-lanche/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RouteAuth } from "../../app";
import { idempotencyKeyFrom } from "../../platform/idempotency";
import * as service from "./service";

const GUARDIAN: RouteAuth = { kind: "guardian", scope: "order" };
const IdParams = z.object({ id: Uuid });

export async function ordersRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/v1/checkouts", { config: { auth: GUARDIAN } }, async (req) =>
    service.createCheckout(req.session!, idempotencyKeyFrom(req), CreateCheckoutRequest.parse(req.body), req.log),
  );

  app.get("/api/v1/checkouts/:id", { config: { auth: GUARDIAN } }, async (req) =>
    service.getCheckout(req.session!, IdParams.parse(req.params).id),
  );

  // Sem Idempotency-Key: só tenta de novo criar a cobrança, que é idempotente pelo id do pagamento.
  app.post("/api/v1/checkouts/:id/charge", { config: { auth: GUARDIAN } }, async (req) =>
    service.retryCharge(req.session!, IdParams.parse(req.params).id, req.log),
  );

  app.post("/api/v1/checkouts/:id/cancel", { config: { auth: GUARDIAN } }, async (req) =>
    service.cancelCheckout(req.session!, IdParams.parse(req.params).id),
  );

  app.get("/api/v1/checkouts", { config: { auth: GUARDIAN } }, async (req) =>
    service.listCheckouts(req.session!, CheckoutListQuery.parse(req.query).serviceDate),
  );
}
