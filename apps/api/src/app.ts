import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { DomainError } from "./platform/errors";
import { verifyInternalRequest } from "./platform/hmac";

export type RouteAuth =
  | "public"
  | "internal"
  | { kind: "guardian" | "staff" | "kitchen"; scope?: string; roles?: string[] };

declare module "fastify" {
  interface FastifyContextConfig {
    auth?: RouteAuth;
  }
  interface FastifyRequest {
    rawBody?: string;
  }
}

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: {
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
    // F1 substitui este ramo pela verificação real de sessão; até lá, falha fechado.
    else if (typeof auth === "object") throw new DomainError("unauthenticated");
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

  return app;
}
