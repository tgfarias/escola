import { KdsPairRequest, Uuid } from "@app-lanche/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { RouteAuth } from "../../app";
import { idempotencyKeyFrom } from "../../platform/idempotency";
import { issueSession, KITCHEN_SESSION_TTL } from "../../platform/session";
import * as service from "./service";

const OFFICE: RouteAuth = { kind: "staff", roles: ["admin", "secretaria"] };
export const KITCHEN: RouteAuth = { kind: "kitchen" };
const DeviceParams = z.object({ id: Uuid });

/** Toda resposta ao tablet renova a sessão por mais 30 dias (spec 4.3). */
export async function renewKitchen(reply: FastifyReply, schoolId: string, deviceId: string): Promise<void> {
  await issueSession(reply, { kind: "kitchen", sub: deviceId, schoolId }, KITCHEN_SESSION_TTL);
}

export async function kdsRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/admin/v1/kds/pairing-codes", { config: { auth: OFFICE } }, async (req) =>
    service.createPairingCode(req.session!, idempotencyKeyFrom(req)),
  );
  app.get("/api/admin/v1/kds/devices", { config: { auth: OFFICE } }, async (req) => service.listDevices(req.session!));
  app.post("/api/admin/v1/kds/devices/:id/revoke", { config: { auth: OFFICE } }, async (req, reply) => {
    await service.revokeDevice(req.session!, DeviceParams.parse(req.params).id);
    return reply.status(204).send();
  });

  app.post("/api/kds/v1/pair", { config: { auth: "public" } }, async (req, reply) => {
    const { schoolId, deviceId } = await service.pair(KdsPairRequest.parse(req.body).code);
    await renewKitchen(reply, schoolId, deviceId);
    return { deviceId };
  });
}
