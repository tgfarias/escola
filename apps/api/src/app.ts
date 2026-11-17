import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from "fastify";
import { ZodError } from "zod";
import { config } from "./platform/config";
import { DomainError } from "./platform/errors";
import { authRoutes } from "./modules/auth/routes";
import { loadActiveStaff } from "./modules/auth/service";
import { registryRoutes } from "./modules/registry/routes";
import { verifyInternalRequest } from "./platform/hmac";
import { authenticate, type GuardianScope, type SessionClaims, type StaffRole } from "./platform/session";

export type RouteAuth =
  | "public"
  | "internal"
  | { kind: "guardian" | "staff" | "kitchen"; scope?: GuardianScope; roles?: StaffRole[] };

declare module "fastify" {
  interface FastifyContextConfig {
    auth?: RouteAuth;
  }
  interface FastifyRequest {
    rawBody?: string;
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defense for session routes that change state: a browser sends `Origin` on cross-origin requests,
 * and `Sec-Fetch-Site` where it omits `Origin`. Requests with neither (non-browser clients) pass.
 */
function assertSameOrigin(req: FastifyRequest): void {
  if (SAFE_METHODS.has(req.method)) return;
  const origin = req.headers.origin;
  if (origin !== undefined) {
    if (origin !== new URL(config().appBaseUrl).origin) throw new DomainError("origin_rejected");
    return;
  }
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin") throw new DomainError("origin_rejected");
}

/** Validates the session cookie; for staff, re-reads `active` and the role so a change applies immediately. */
async function authenticateWithDatabase(
  req: FastifyRequest,
  auth: Exclude<RouteAuth, string>,
): Promise<SessionClaims> {
  const claims = await authenticate(req, auth);
  if (claims.kind !== "staff") return claims;
  const staff = await loadActiveStaff(claims.schoolId, claims.sub);
  if (!staff) throw new DomainError("unauthenticated");
  const refreshed: SessionClaims = { ...claims, role: staff.role };
  if (auth.roles && !auth.roles.includes(refreshed.role)) throw new DomainError("insufficient_scope");
  return refreshed;
}

export function buildApp(options: { logger?: FastifyServerOptions["logger"] } = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? {
      level: process.env.LOG_LEVEL ?? (process.env.VITEST ? "silent" : "info"),
      redact: ["req.headers.authorization", "req.headers.cookie", "req.headers['x-signature']"],
    },
  });

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
  });

  app.addHook("onSend", async (req, reply) => {
    if (req.url.startsWith("/api/")) reply.header("cache-control", "private, no-store");
  });

  app.addHook("preHandler", async (req) => {
    const auth = req.routeOptions.config.auth;
    if (auth === "internal") verifyInternalRequest(req);
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
      return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
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
  return app;
}
