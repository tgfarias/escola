import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildApp } from "./app";
import { DomainError } from "./platform/errors";

describe("buildApp", () => {
  it("answers the health check", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("refuses to register a route without config.auth", async () => {
    const app = buildApp();
    // Cobre os dois comportamentos possíveis do Fastify: erro na chamada ou no ready().
    const register = async () => {
      app.get("/api/v1/nope", async () => ({}));
      await app.ready();
    };
    await expect(register()).rejects.toThrow(/must declare config.auth/);
  });

  it("maps DomainError to its status and envelope", async () => {
    const app = buildApp();
    app.get("/api/v1/boom", { config: { auth: "public" } }, async () => {
      throw new DomainError("not_found", "no such thing");
    });
    const res = await app.inject({ method: "GET", url: "/api/v1/boom" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: "not_found", message: "no such thing" } });
  });

  it("maps zod errors to validation_failed", async () => {
    const app = buildApp();
    app.post("/api/v1/echo", { config: { auth: "public" } }, async (req) =>
      z.object({ a: z.string() }).parse(req.body),
    );
    const res = await app.inject({ method: "POST", url: "/api/v1/echo", payload: { a: 1 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_failed");
  });

  it("maps malformed JSON to validation_failed", async () => {
    const app = buildApp();
    app.post("/api/v1/echo", { config: { auth: "public" } }, async (req) => req.body);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/echo",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_failed");
  });

  it("hides unexpected errors", async () => {
    const app = buildApp();
    app.get("/api/v1/crash", { config: { auth: "public" } }, async () => {
      throw new Error("secret detail");
    });
    const res = await app.inject({ method: "GET", url: "/api/v1/crash" });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: "internal_error", message: "internal error" } });
  });

  it("marks API responses as private", async () => {
    const app = buildApp();
    app.get("/api/v1/x", { config: { auth: "public" } }, async () => ({}));
    const res = await app.inject({ method: "GET", url: "/api/v1/x" });
    expect(res.headers["cache-control"]).toBe("private, no-store");
  });

  it("exposes the exact raw request body", async () => {
    const app = buildApp();
    app.post("/api/v1/raw", { config: { auth: "public" } }, async (req) => ({ raw: req.rawBody }));
    const payload = '{ "a":  1 }';
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/raw",
      headers: { "content-type": "application/json" },
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().raw).toBe(payload);
  });

  it("refuses an /internal/ route that is not declared internal", async () => {
    const app = buildApp();
    const register = async () => {
      app.get("/internal/v1/leak", { config: { auth: "public" } }, async () => ({}));
      await app.ready();
    };
    await expect(register()).rejects.toThrow(/\/internal\/v1\/leak/);
  });

  it("refuses an internal route outside /internal/", async () => {
    const app = buildApp();
    const register = async () => {
      app.get("/api/v1/sneaky", { config: { auth: "internal" } }, async () => ({}));
      await app.ready();
    };
    await expect(register()).rejects.toThrow(/\/api\/v1\/sneaky/);
  });

  it("fails closed for session-based auth until sessions exist", async () => {
    const app = buildApp();
    app.get("/api/v1/mine", { config: { auth: { kind: "guardian" } } }, async () => ({ ok: true }));
    const res = await app.inject({ method: "GET", url: "/api/v1/mine" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthenticated");
  });

  it("answers unknown paths with the error envelope and no-store", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/nowhere" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: "not_found", message: "not found" } });
    expect(res.headers["cache-control"]).toBe("private, no-store");
  });

  it("maps an oversized body to 413 payload_too_large", async () => {
    const app = buildApp();
    app.post("/api/v1/echo", { config: { auth: "public" } }, async (req) => req.body);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/echo",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ a: "x".repeat(1024 * 1024 + 1) }),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe("payload_too_large");
  });

  it("maps an unsupported content type to 415 request_rejected", async () => {
    const app = buildApp();
    app.post("/api/v1/echo", { config: { auth: "public" } }, async (req) => req.body);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/echo",
      headers: { "content-type": "text/xml" },
      payload: "<a/>",
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe("request_rejected");
  });
});
