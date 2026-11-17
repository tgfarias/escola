import { IsoDate } from "@app-lanche/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RouteAuth } from "../../app";
import * as service from "./service";

const OFFICE: RouteAuth = { kind: "staff", roles: ["admin", "secretaria"] };
const DateParams = z.object({ date: IsoDate });

export async function serviceDayRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/admin/v1/service-days/:date/close", { config: { auth: OFFICE } }, async (req) =>
    service.closeServiceDay(req.session!.schoolId, DateParams.parse(req.params).date, { log: req.log }),
  );

  app.get("/api/admin/v1/service-days/:date/manifest", { config: { auth: OFFICE } }, async (req) =>
    service.getManifest(req.session!.schoolId, DateParams.parse(req.params).date),
  );
}
