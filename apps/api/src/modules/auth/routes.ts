import { ExchangeRequest, OtpVerifyRequest } from "@app-lanche/contracts";
import type { FastifyInstance } from "fastify";
import { GUARDIAN_SESSION_TTL, issueSession } from "../../platform/session";
import * as service from "./service";

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/v1/auth/exchange", { config: { auth: "public" } }, async (req, reply) => {
    const result = await service.exchange(ExchangeRequest.parse(req.body));
    if (result.status === "step_up_required") return result;
    await issueSession(reply, result.claims, GUARDIAN_SESSION_TTL);
    return { status: "ok", scope: result.scope };
  });

  app.post("/api/v1/auth/otp/verify", { config: { auth: "public" } }, async (req, reply) => {
    const result = await service.verifyGuardianOtp(OtpVerifyRequest.parse(req.body));
    await issueSession(reply, result.claims, GUARDIAN_SESSION_TTL);
    return { status: "ok", scope: result.scope };
  });

  app.get("/api/v1/me", { config: { auth: { kind: "guardian" } } }, async (req) =>
    service.getMe(req.session!),
  );
}
