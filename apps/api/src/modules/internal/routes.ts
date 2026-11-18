import { InternalMagicLinkRequest, IsoDate, Uuid, type ScheduleDueResponse } from "@app-lanche/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import * as auth from "../auth/service";
import * as serviceDays from "../serviceDays/service";

/** Rotas chamadas pelo n8n (spec 6.2). A escola vem do caminho, autenticado pelo HMAC. */
export const INTERNAL = { config: { auth: "internal" as const } };
export const SchoolParams = z.object({ school_id: Uuid });

const DayParams = z.object({ school_id: Uuid, date: IsoDate });

export async function internalRoutes(app: FastifyInstance): Promise<void> {
  app.post("/internal/v1/schools/:school_id/magic-links", INTERNAL, async (req) =>
    auth.issueMagicLink(SchoolParams.parse(req.params).school_id, InternalMagicLinkRequest.parse(req.body)),
  );

  app.get("/internal/v1/schedule/due", INTERNAL, async (): Promise<ScheduleDueResponse> => ({
    due: (await serviceDays.listDueActions()).map((d) => ({
      action: d.action,
      school_id: d.schoolId,
      service_date: d.serviceDate,
    })),
  }));

  app.post("/internal/v1/service-days/:school_id/:date/close", INTERNAL, async (req) => {
    const p = DayParams.parse(req.params);
    return serviceDays.closeServiceDay(p.school_id, p.date, { log: req.log });
  });

  app.get("/internal/v1/service-days/:school_id/:date/manifest", INTERNAL, async (req) => {
    const p = DayParams.parse(req.params);
    return serviceDays.getManifest(p.school_id, p.date);
  });
}
