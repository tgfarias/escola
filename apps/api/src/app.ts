import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { DomainError } from "./platform/errors";

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
  });

  app.addHook("onSend", async (req, reply) => {
    if (req.url.startsWith("/api/")) reply.header("cache-control", "private, no-store");
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof DomainError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (err instanceof ZodError || (typeof status === "number" && status >= 400 && status < 500)) {
      return reply
        .status(err instanceof ZodError ? 400 : (status as number))
        .send({ error: { code: "validation_failed", message: "invalid request" } });
    }
    req.log.error({ err: { name: (err as Error).name, message: (err as Error).message } }, "unhandled error");
    return reply.status(500).send({ error: { code: "internal_error", message: "internal error" } });
  });

  app.get("/healthz", { config: { auth: "public" } }, async () => ({ ok: true }));

  return app;
}
