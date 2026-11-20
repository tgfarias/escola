import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from "fastify";
import { ZodError } from "zod";
import { DomainError } from "./platform/errors";
import { authRoutes } from "./modules/auth/routes";
import { catalogRoutes } from "./modules/catalog/routes";
import { counterRoutes } from "./modules/counter/routes";
import { topupRoutes } from "./modules/topups/routes";
import { loadActiveKitchenDevice, loadActiveStaff } from "./modules/auth/service";
import { kdsRoutes } from "./modules/kds/routes";
import { documentRoutes } from "./modules/documents/routes";
import { internalRoutes } from "./modules/internal/routes";
import { ordersRoutes } from "./modules/orders/routes";
import { serviceDayRoutes } from "./modules/serviceDays/routes";
import { webhookRoutes } from "./modules/webhooks/routes";
import { dashboardRoutes } from "./modules/dashboard/routes";
import { walletRoutes } from "./modules/wallet/routes";
import { registryRoutes } from "./modules/registry/routes";
import { verifyInternalRequest } from "./platform/hmac";
import { verifyJobRequest } from "./platform/jobAuth";
import { assertSameOrigin } from "./platform/origin";
import { setOutboxKickHandler } from "./platform/outbox";
import { jobRoutes } from "./modules/jobs/routes";
import { kickOutbox } from "./modules/outbox/service";
import { authenticate, type GuardianScope, type SessionClaims, type StaffRole } from "./platform/session";

export type RouteAuth =
  | "public"
  | "internal"
  | "webhook"
  | "job"
  | { kind: "guardian" | "staff" | "kitchen"; scope?: GuardianScope | GuardianScope[]; roles?: StaffRole[] };

declare module "fastify" {
  interface FastifyContextConfig {
    auth?: RouteAuth;
  }
  interface FastifyRequest {
    rawBody?: string;
  }
}

/** Validates the session cookie; for staff, re-reads `active` and the role; for kitchen, that the device is still paired and not revoked. Changes apply immediately. */
async function authenticateWithDatabase(
  req: FastifyRequest,
  auth: Exclude<RouteAuth, string>,
): Promise<SessionClaims> {
  const claims = await authenticate(req, auth);
  if (claims.kind === "kitchen") {
    if (!(await loadActiveKitchenDevice(claims.schoolId, claims.sub))) throw new DomainError("unauthenticated");
    return claims;
  }
  if (claims.kind !== "staff") return claims;
  const staff = await loadActiveStaff(claims.schoolId, claims.sub);
  if (!staff) throw new DomainError("unauthenticated");
  const refreshed: SessionClaims = { ...claims, role: staff.role };
  if (auth.roles && !auth.roles.includes(refreshed.role)) throw new DomainError("insufficient_scope");
  return refreshed;
}

/** The request log never carries the query string: webhook URLs hold a secret token there. */
const LOG_SERIALIZERS = {
  req: (req: { method: string; url: string; hostname?: string; ip?: string }) => ({
    method: req.method,
    url: req.url.split("?")[0],
    hostname: req.hostname,
    remoteAddress: req.ip,
  }),
};

function loggerOptions(logger: FastifyServerOptions["logger"]): FastifyServerOptions["logger"] {
  if (logger === undefined) {
    return {
      level: process.env.LOG_LEVEL ?? (process.env.VITEST ? "silent" : "info"),
      redact: ["req.headers.authorization", "req.headers.cookie", "req.headers['x-signature']", "req.headers['x-job-token']"],
      serializers: LOG_SERIALIZERS,
    };
  }
  if (typeof logger === "object" && logger !== null) {
    return { ...logger, serializers: { ...LOG_SERIALIZERS, ...(logger.serializers ?? {}) } };
  }
  return logger;
}

export function buildApp(options: { logger?: FastifyServerOptions["logger"] } = {}): FastifyInstance {
  const app = Fastify({ logger: loggerOptions(options.logger) });

  setOutboxKickHandler((schoolId) => kickOutbox(schoolId, app.log));

  app.register(cookie);

  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    const text = body as string;
    req.rawBody = text;
    if (text === "") return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      const err = new Error("invalid json") as Error & { statusCode: number };
      err.statusCode = 400;
      done(err);
    }
  });

  app.addHook("onRoute", (route) => {
    if (!route.config?.auth) {
      throw new Error(`route ${String(route.method)} ${route.url} must declare config.auth`);
    }
    const internalPrefix = route.url.startsWith("/internal/");
    const internalAuth = route.config.auth === "internal";
    if (internalPrefix && !internalAuth) {
      throw new Error(`route ${String(route.method)} ${route.url} is under /internal/ and must use auth "internal"`);
    }
    if (internalAuth && !internalPrefix) {
      throw new Error(`route ${String(route.method)} ${route.url} uses auth "internal" and must live under /internal/`);
    }
    const webhookPrefix = route.url.startsWith("/webhooks/");
    const webhookAuth = route.config.auth === "webhook";
    if (webhookPrefix && !webhookAuth) {
      throw new Error(`route ${String(route.method)} ${route.url} is under /webhooks/ and must use auth "webhook"`);
    }
    if (webhookAuth && !webhookPrefix) {
      throw new Error(`route ${String(route.method)} ${route.url} uses auth "webhook" and must live under /webhooks/`);
    }
    const jobPrefix = route.url.startsWith("/jobs/");
    const jobAuth = route.config.auth === "job";
    if (jobPrefix && !jobAuth) {
      throw new Error(`route ${String(route.method)} ${route.url} is under /jobs/ and must use auth "job"`);
    }
    if (jobAuth && !jobPrefix) {
      throw new Error(`route ${String(route.method)} ${route.url} uses auth "job" and must live under /jobs/`);
    }
  });

  app.addHook("onSend", async (req, reply) => {
    if (req.url.startsWith("/api/")) reply.header("cache-control", "private, no-store");
  });

  app.addHook("preHandler", async (req) => {
    const auth = req.routeOptions.config.auth;
    if (auth === "internal") verifyInternalRequest(req);
    else if (auth === "job") verifyJobRequest(req);
    else if (typeof auth === "object") {
      assertSameOrigin(req);
      req.session = await authenticateWithDatabase(req, auth);
    }
  });

  app.setNotFoundHandler((_req, reply) =>
    reply.status(404).send({ error: { code: "not_found", message: "not found" } }),
  );

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof DomainError) {
      return reply
        .status(err.status)
        .send({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
    }
    const status = err instanceof ZodError ? 400 : (err as { statusCode?: number }).statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) {
      if (status === 400) {
        return reply.status(400).send({ error: { code: "validation_failed", message: "invalid request" } });
      }
      if (status === 404) {
        return reply.status(404).send({ error: { code: "not_found", message: "not found" } });
      }
      if (status === 413) {
        return reply.status(413).send({ error: { code: "payload_too_large", message: "payload too large" } });
      }
      return reply.status(status).send({ error: { code: "request_rejected", message: "request rejected" } });
    }
    const e = err as Error & { code?: string };
    req.log.error(
      { err: { name: e.name, message: e.message, ...(e.code ? { code: e.code } : {}), stack: e.stack } },
      "unhandled error",
    );
    return reply.status(500).send({ error: { code: "internal_error", message: "internal error" } });
  });

  app.get("/healthz", { config: { auth: "public" } }, async () => ({ ok: true }));

  app.register(authRoutes);
  app.register(registryRoutes);
  app.register(catalogRoutes);
  app.register(walletRoutes);
  app.register(dashboardRoutes);
  app.register(counterRoutes);
  app.register(topupRoutes);
  app.register(ordersRoutes);
  app.register(serviceDayRoutes);
  app.register(internalRoutes);
  app.register(webhookRoutes);
  app.register(jobRoutes);
  app.register(kdsRoutes);
  app.register(documentRoutes);
  return app;
}
