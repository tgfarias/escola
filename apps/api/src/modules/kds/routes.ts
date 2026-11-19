import { IsoDate, KdsCounterSalesRequest, KdsCounterVoidsRequest, KdsEventsRequest, KdsPairRequest, Uuid } from "@app-lanche/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { RouteAuth } from "../../app";
import { idempotencyKeyFrom } from "../../platform/idempotency";
import { issueSession, KITCHEN_GRACE_SECONDS, KITCHEN_SESSION_TTL } from "../../platform/session";
import * as counter from "../counter/service";
import * as serviceDays from "../serviceDays/service";
import * as service from "./service";

const OFFICE: RouteAuth = { kind: "staff", roles: ["admin", "secretaria"] };
export const KITCHEN: RouteAuth = { kind: "kitchen" };
/** Rejects impossible instants (2031-02-31, hour 25) that the regex lets through and Postgres would refuse. */
function isRealInstant(since: string): boolean {
  if (Number.isNaN(new Date(since).getTime())) return false;
  const day = since.slice(0, 10);
  const parsed = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
}

const DeviceParams = z.object({ id: Uuid });
const DateParams = z.object({ date: IsoDate });
const ChangesQuery = z.object({
  date: IsoDate,
  since: z
    .string()
    .min(1)
    .max(64)
    .regex(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)$/)
    .refine(isRealInstant, "invalid timestamp")
    .optional(),
});

/**
 * Toda resposta ao tablet renova a sessão por mais 30 dias (spec 4.3). O cookie dura 30 + 90 dias para que o
 * navegador ainda o envie durante a carência de um tablet que ficou offline (spec 7.3, item 6).
 */
export async function renewKitchen(reply: FastifyReply, schoolId: string, deviceId: string): Promise<void> {
  await issueSession(reply, { kind: "kitchen", sub: deviceId, schoolId }, KITCHEN_SESSION_TTL, {
    cookieMaxAge: KITCHEN_SESSION_TTL + KITCHEN_GRACE_SECONDS,
  });
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

  // Lançamentos no balcão (spec F5B): idempotentes pelo id do cliente, sem Idempotency-Key.
  app.get("/api/kds/v1/roster", { config: { auth: KITCHEN } }, async (req, reply) => {
    const s = req.session!;
    const res = await counter.roster(s.schoolId);
    await renewKitchen(reply, s.schoolId, s.sub);
    return res;
  });

  app.post("/api/kds/v1/counter-sales", { config: { auth: KITCHEN } }, async (req, reply) => {
    const s = req.session!;
    const res = await counter.recordKitchenSales(s.schoolId, s.sub, KdsCounterSalesRequest.parse(req.body));
    await renewKitchen(reply, s.schoolId, s.sub);
    return res;
  });

  app.post("/api/kds/v1/counter-voids", { config: { auth: KITCHEN } }, async (req, reply) => {
    const s = req.session!;
    const res = await counter.recordKitchenVoids(s.schoolId, s.sub, KdsCounterVoidsRequest.parse(req.body));
    await renewKitchen(reply, s.schoolId, s.sub);
    return res;
  });

  app.get("/api/kds/v1/manifest/:date", { config: { auth: KITCHEN } }, async (req, reply) => {
    const s = req.session!;
    const res = await serviceDays.kdsManifest(s.schoolId, DateParams.parse(req.params).date);
    await renewKitchen(reply, s.schoolId, s.sub);
    return res;
  });

  app.post("/api/kds/v1/events", { config: { auth: KITCHEN } }, async (req, reply) => {
    const s = req.session!;
    const res = await service.recordEvents(s.schoolId, s.sub, KdsEventsRequest.parse(req.body));
    await renewKitchen(reply, s.schoolId, s.sub);
    return res;
  });

  app.get("/api/kds/v1/changes", { config: { auth: KITCHEN } }, async (req, reply) => {
    const s = req.session!;
    const q = ChangesQuery.parse(req.query);
    const res = await service.changes(s.schoolId, q.date, q.since ?? null);
    await renewKitchen(reply, s.schoolId, s.sub);
    return res;
  });
}
