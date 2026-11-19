import {
  DeliveriesRequest,
  InternalMagicLinkRequest,
  IsoDate,
  RemindersPrepareRequest,
  Uuid,
  type DebtNoticesResponse,
  type RemindersPrepareResponse,
  type ScheduleDueResponse,
} from "@app-lanche/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import * as auth from "../auth/service";
import * as reminders from "../reminders/service";
import * as serviceDays from "../serviceDays/service";
import * as wallet from "../wallet/service";

/** Rotas chamadas pelo n8n (spec 6.2). A escola vem do caminho, autenticado pelo HMAC. */
export const INTERNAL = { config: { auth: "internal" as const } };
export const SchoolParams = z.object({ school_id: Uuid });

const BatchParams = z.object({ school_id: Uuid, batch_id: Uuid });
const DayParams = z.object({ school_id: Uuid, date: IsoDate });

/** A conciliação de recargas é do job do Cloud Scheduler: o n8n não toca pagamento (CLAUDE.md regra 21). */
type N8nAction = Exclude<serviceDays.DueAction["action"], "reconcile_topups">;
const forN8n = (d: serviceDays.DueAction): d is serviceDays.DueAction & { action: N8nAction } => d.action !== "reconcile_topups";

export async function internalRoutes(app: FastifyInstance): Promise<void> {
  app.post("/internal/v1/schools/:school_id/magic-links", INTERNAL, async (req) =>
    auth.issueMagicLink(SchoolParams.parse(req.params).school_id, InternalMagicLinkRequest.parse(req.body)),
  );

  app.post("/internal/v1/schools/:school_id/reminders/prepare", INTERNAL, async (req): Promise<RemindersPrepareResponse> =>
    reminders.prepareReminders(SchoolParams.parse(req.params).school_id, RemindersPrepareRequest.parse(req.body)),
  );

  app.post("/internal/v1/schools/:school_id/reminders/:batch_id/deliveries", INTERNAL, async (req, reply) => {
    const p = BatchParams.parse(req.params);
    await reminders.recordDeliveries(p.school_id, p.batch_id, DeliveriesRequest.parse(req.body));
    return reply.status(204).send();
  });

  app.get("/internal/v1/schedule/due", INTERNAL, async (): Promise<ScheduleDueResponse> => ({
    due: (await serviceDays.listDueActions()).filter(forN8n).map((d) => ({
      action: d.action,
      school_id: d.schoolId,
      service_date: d.serviceDate,
    })),
  }));

  // Naturalmente idempotente: só pega carteiras sem aviso há 3 dias e marca o aviso na mesma transação.
  app.post("/internal/v1/schools/:school_id/debt-notices", INTERNAL, async (req): Promise<DebtNoticesResponse> =>
    wallet.sendDueDebtNotices(SchoolParams.parse(req.params).school_id),
  );

  app.post("/internal/v1/service-days/:school_id/:date/close", INTERNAL, async (req) => {
    const p = DayParams.parse(req.params);
    return serviceDays.closeServiceDay(p.school_id, p.date, { log: req.log });
  });

  app.get("/internal/v1/service-days/:school_id/:date/manifest", INTERNAL, async (req) => {
    const p = DayParams.parse(req.params);
    return serviceDays.getManifest(p.school_id, p.date);
  });
}
