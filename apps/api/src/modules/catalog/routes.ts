import {
  CreateMenuItemRequest,
  IsoDate,
  UpdateMenuItemRequest,
  UpsertServiceDayRequest,
  Uuid,
} from "@app-lanche/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RouteAuth } from "../../app";
import { idempotencyKeyFrom } from "../../platform/idempotency";
import * as service from "./service";

const OFFICE: RouteAuth = { kind: "staff", roles: ["admin", "secretaria"] };
const GUARDIAN: RouteAuth = { kind: "guardian", scope: "order" };
const IdParams = z.object({ id: Uuid });
const DateParams = z.object({ date: IsoDate });
const FromQuery = z.object({ from: IsoDate.optional() });

export async function catalogRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/admin/v1/menu-items", { config: { auth: OFFICE } }, async (req) => service.listMenuItems(req.session!));

  app.post("/api/admin/v1/menu-items", { config: { auth: OFFICE } }, async (req) =>
    service.createMenuItem(req.session!, idempotencyKeyFrom(req), CreateMenuItemRequest.parse(req.body)),
  );

  app.patch("/api/admin/v1/menu-items/:id", { config: { auth: OFFICE } }, async (req) =>
    service.updateMenuItem(req.session!, IdParams.parse(req.params).id, UpdateMenuItemRequest.parse(req.body)),
  );

  app.put("/api/admin/v1/service-days/:date", { config: { auth: OFFICE } }, async (req) =>
    service.upsertServiceDay(req.session!, DateParams.parse(req.params).date, UpsertServiceDayRequest.parse(req.body)),
  );

  app.get("/api/admin/v1/service-days", { config: { auth: OFFICE } }, async (req) =>
    service.listServiceDays(req.session!, FromQuery.parse(req.query).from ?? null),
  );

  app.get("/api/v1/service-days", { config: { auth: GUARDIAN } }, async (req) =>
    service.listOpenDaysForGuardian(req.session!),
  );

  app.get("/api/v1/service-days/:date/menu", { config: { auth: GUARDIAN } }, async (req) =>
    service.guardianMenu(req.session!, DateParams.parse(req.params).date),
  );
}
