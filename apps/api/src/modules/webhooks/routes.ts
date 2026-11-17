import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { handleWebhook } from "../payments/service";

const Params = z.object({ provider: z.string().min(1).max(40), schoolId: z.string().min(1).max(64) });

/** Direto no Cloud Run, sem passar pelo n8n (CLAUDE.md regra 21). */
export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.post("/webhooks/payments/:provider/:schoolId", { config: { auth: "webhook" } }, async (req) => {
    const params = Params.parse(req.params);
    await handleWebhook({
      providerName: params.provider,
      schoolId: params.schoolId,
      headers: req.headers,
      query: req.query as Record<string, string | undefined>,
      rawBody: req.rawBody ?? "",
      log: req.log,
    });
    return { received: true };
  });
}
