import { ExchangeRequest, OtpVerifyRequest, StaffOtpRequest } from "@app-lanche/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { DomainError } from "../../platform/errors";
import { assertSameOrigin } from "../../platform/origin";
import { clearSession, GUARDIAN_SESSION_TTL, issueSession, sessionKind, STAFF_SESSION_TTL } from "../../platform/session";
import * as service from "./service";

/** Ids only: never the e-mail, phone or token (LGPD). */
function logThrottled(req: FastifyRequest, subjectKind: "guardian" | "staff", subjectId: string): void {
  req.log.warn(
    { event: "otp_issuance_throttled", subject_kind: subjectKind, subject_id: subjectId },
    "otp issuance throttled",
  );
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/v1/auth/exchange", { config: { auth: "public" } }, async (req, reply) => {
    const result = await service.exchange(ExchangeRequest.parse(req.body));
    if (result.status === "throttled") {
      logThrottled(req, "guardian", result.guardianId);
      throw new DomainError("otp_too_many_attempts");
    }
    if (result.status === "step_up_required") return { status: result.status, otpToken: result.otpToken };
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

  app.post("/api/admin/v1/auth/otp/request", { config: { auth: "public" } }, async (req) => {
    const result = await service.requestStaffOtp(StaffOtpRequest.parse(req.body).email);
    if (result.throttled) logThrottled(req, "staff", result.staffUserId);
    return { otpToken: result.otpToken };
  });

  app.post("/api/admin/v1/auth/otp/verify", { config: { auth: "public" } }, async (req, reply) => {
    const result = await service.verifyStaffOtp(OtpVerifyRequest.parse(req.body));
    await issueSession(reply, result.claims, STAFF_SESSION_TTL);
    return { status: "ok", role: result.role };
  });

  // "Sair" da área da escola. Pública (vale com sessão vencida) e naturalmente idempotente: sem Idempotency-Key.
  // Mesma checagem de origem das rotas de sessão. Só apaga cookie de equipe (ou ausente/inválido): o tablet da
  // cozinha e o responsável usam o mesmo __session e não perdem a sessão por um "Sair" do admin no mesmo navegador.
  app.post("/api/admin/v1/auth/logout", { config: { auth: "public" } }, async (req, reply) => {
    assertSameOrigin(req);
    const kind = await sessionKind(req);
    if (kind === null || kind === "staff") clearSession(reply);
    return reply.code(204).send();
  });

  app.get("/api/admin/v1/me", { config: { auth: { kind: "staff" } } }, async (req) =>
    service.getStaffMe(req.session!),
  );
}
