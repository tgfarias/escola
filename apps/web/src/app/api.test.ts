import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiError, apiFetch } from "./api";

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("apiFetch", () => {
  it("parses a successful response with the schema", async () => {
    mockFetch(200, { ok: true });
    await expect(apiFetch("/api/v1/x", z.object({ ok: z.boolean() }))).resolves.toEqual({ ok: true });
  });

  it("sends JSON bodies with credentials", async () => {
    const fn = mockFetch(200, {});
    await apiFetch("/api/v1/x", z.object({}), { method: "POST", body: { a: 1 } });
    const init = fn.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(init.body).toBe('{"a":1}');
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("throws ApiError with the server error code", async () => {
    mockFetch(401, { error: { code: "invalid_token", message: "x" } });
    await expect(apiFetch("/api/v1/x", z.object({}))).rejects.toMatchObject({
      status: 401,
      code: "invalid_token",
    });
  });

  it("throws ApiError network_error when fetch rejects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("offline"))));
    const err = await apiFetch("/api/v1/x", z.object({})).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("network_error");
  });
});
