import { describe, expect, it } from "vitest";
import { buildApp } from "../app";
import { signInternal } from "./hmac";

function appWithEcho() {
  const app = buildApp();
  app.post("/internal/v1/echo", { config: { auth: "internal" } }, async (req) => req.body);
  return app;
}

const SECRET = "test-hmac-secret-with-at-least-32-chars";
const TOKEN = "test-service-token-with-at-least-32-chars";
const URL_ECHO = "/internal/v1/echo";

function headers(
  body: string,
  overrides: Record<string, string> = {},
  sign: { method?: string; path?: string; timestamp?: string } = {},
) {
  const timestamp = sign.timestamp ?? new Date().toISOString();
  return {
    "content-type": "application/json",
    authorization: `Bearer ${TOKEN}`,
    "x-timestamp": timestamp,
    "x-signature": signInternal(SECRET, {
      method: sign.method ?? "POST",
      path: sign.path ?? URL_ECHO,
      timestamp,
      body,
    }),
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
        "x-signature": signInternal(SECRET, { method: "POST", path: URL_ECHO, timestamp: old, body }),
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
        "x-signature": signInternal(SECRET, { method: "POST", path: URL_ECHO, timestamp: "garbage", body }),
      }),
      payload: body,
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a signature made for another path", async () => {
    const app = appWithEcho();
    app.post("/internal/v1/other", { config: { auth: "internal" } }, async () => ({ ok: true }));
    const res = await app.inject({
      method: "POST",
      url: "/internal/v1/other",
      headers: headers(body, {}, { path: URL_ECHO }),
      payload: body,
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a POST signature replayed on a GET route of the same path", async () => {
    const app = appWithEcho();
    app.get(URL_ECHO, { config: { auth: "internal" } }, async () => ({ ok: true }));
    const res = await app.inject({
      method: "GET",
      url: URL_ECHO,
      headers: headers("", {}, { method: "POST" }),
    });
    expect(res.statusCode).toBe(401);
  });

  it("covers the query string in the signature", async () => {
    const app = appWithEcho();
    const sign = { path: `${URL_ECHO}?a=1` };
    const ok = await app.inject({
      method: "POST",
      url: `${URL_ECHO}?a=1`,
      headers: headers(body, {}, sign),
      payload: body,
    });
    expect(ok.statusCode).toBe(200);
    const bad = await app.inject({
      method: "POST",
      url: `${URL_ECHO}?a=2`,
      headers: headers(body, {}, sign),
      payload: body,
    });
    expect(bad.statusCode).toBe(401);
  });

  it("rejects a timestamp 6 minutes in the future", async () => {
    const future = new Date(Date.now() + 6 * 60_000).toISOString();
    const res = await appWithEcho().inject({
      method: "POST",
      url: URL_ECHO,
      headers: headers(body, {}, { timestamp: future }),
      payload: body,
    });
    expect(res.statusCode).toBe(401);
  });

  it("accepts a timestamp 4 minutes in the past", async () => {
    const past = new Date(Date.now() - 4 * 60_000).toISOString();
    const res = await appWithEcho().inject({
      method: "POST",
      url: URL_ECHO,
      headers: headers(body, {}, { timestamp: past }),
      payload: body,
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects a correct token and unchanged body with a wrong signature", async () => {
    const res = await appWithEcho().inject({
      method: "POST",
      url: URL_ECHO,
      headers: headers(body, { "x-signature": "0".repeat(64) }),
      payload: body,
    });
    expect(res.statusCode).toBe(401);
  });
});
