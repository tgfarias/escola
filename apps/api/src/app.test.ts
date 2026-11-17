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
});
