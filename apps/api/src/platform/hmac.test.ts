import { describe, expect, it } from "vitest";
import { buildApp } from "../app";
import { signInternal } from "./hmac";

function appWithEcho() {
  const app = buildApp();
  app.post("/internal/v1/echo", { config: { auth: "internal" } }, async (req) => req.body);
  return app;
}

function headers(body: string, overrides: Record<string, string> = {}) {
  const timestamp = new Date().toISOString();
  return {
    "content-type": "application/json",
    authorization: "Bearer test-service-token",
    "x-timestamp": timestamp,
    "x-signature": signInternal("test-hmac-secret", timestamp, body),
    ...overrides,
  };
}

describe("internal route authentication", () => {
  const body = JSON.stringify({ hello: "world" });

  it("accepts a correctly signed request", async () => {
    const res = await appWithEcho().inject({
      method: "POST",
      url: "/internal/v1/echo",
      headers: headers(body),
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ hello: "world" });
  });

  it("rejects a wrong service token", async () => {
    const res = await appWithEcho().inject({
      method: "POST",
      url: "/internal/v1/echo",
      headers: headers(body, { authorization: "Bearer nope" }),
      payload: body,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("invalid_signature");
  });

  it("rejects a tampered body", async () => {
    const res = await appWithEcho().inject({
      method: "POST",
      url: "/internal/v1/echo",
      headers: headers(body),
      payload: JSON.stringify({ hello: "mallory" }),
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a timestamp older than 5 minutes", async () => {
    const old = new Date(Date.now() - 6 * 60_000).toISOString();
    const res = await appWithEcho().inject({
      method: "POST",
      url: "/internal/v1/echo",
      headers: headers(body, {
        "x-timestamp": old,
        "x-signature": signInternal("test-hmac-secret", old, body),
      }),
      payload: body,
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a request with no signature headers", async () => {
    const res = await appWithEcho().inject({
      method: "POST",
      url: "/internal/v1/echo",
      headers: { "content-type": "application/json" },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a garbage timestamp even when correctly signed", async () => {
    const res = await appWithEcho().inject({
      method: "POST",
      url: "/internal/v1/echo",
      headers: headers(body, {
        "x-timestamp": "garbage",
        "x-signature": signInternal("test-hmac-secret", "garbage", body),
      }),
      payload: body,
    });
    expect(res.statusCode).toBe(401);
  });
});
