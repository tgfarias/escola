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

  app.get("/api/v1/checkouts", { config: { auth: GUARDIAN } }, async (req) =>
    service.listCheckouts(req.session!, CheckoutListQuery.parse(req.query).serviceDate),
  );
}
