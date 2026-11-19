import type { JobDispatchResponse, SafetyCloseResponse, TopupReconcileResponse } from "@app-lanche/contracts";
import type { FastifyInstance } from "fastify";
import * as outbox from "../outbox/service";
import * as serviceDays from "../serviceDays/service";
import * as topups from "../topups/service";

const JOB = { config: { auth: "job" as const } };

export async function jobRoutes(app: FastifyInstance): Promise<void> {
  app.post("/jobs/v1/outbox/dispatch", JOB, async (req): Promise<JobDispatchResponse> => outbox.dispatchOutbox({ log: req.log }));
  app.post("/jobs/v1/service-days/safety-close", JOB, async (req): Promise<SafetyCloseResponse> =>
    serviceDays.safetyClose({ log: req.log }),
  );
  app.post("/jobs/v1/topups/reconcile", JOB, async (req): Promise<TopupReconcileResponse> => topups.reconcileDue({ log: req.log }));
}
