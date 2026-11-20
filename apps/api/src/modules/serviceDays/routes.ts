import { IsoDate, ManifestQuery, Shift } from "@app-lanche/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RouteAuth } from "../../app";
import * as service from "./service";

const OFFICE: RouteAuth = { kind: "staff", roles: ["admin", "secretaria"] };
const DateParams = z.object({ date: IsoDate });
const ShiftParams = z.object({ date: IsoDate, shift: Shift });

export async function serviceDayRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/admin/v1/service-days/:date/close", { config: { auth: OFFICE } }, async (req) =>
    service.closeServiceDay(req.session!.schoolId, DateParams.parse(req.params).date, { log: req.log, due: "past_cutoff" }),
  );

  // Naturalmente idempotente: repetir devolve o mesmo romaneio (sem Idempotency-Key, como o fechamento do dia).
  app.post("/api/admin/v1/service-days/:date/shifts/:shift/close", { config: { auth: OFFICE } }, async (req) => {
    const p = ShiftParams.parse(req.params);
    return service.closeShift(req.session!.schoolId, p.date, p.shift, { log: req.log });
  });

  app.get("/api/admin/v1/service-days/:date/manifest", { config: { auth: OFFICE } }, async (req) =>
    service.getManifest(req.session!.schoolId, DateParams.parse(req.params).date, ManifestQuery.parse(req.query).shift),
  );
}
