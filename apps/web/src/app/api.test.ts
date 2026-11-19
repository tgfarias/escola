import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiError, apiFetch, apiFetchBlob } from "./api";

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

function mockResponse(res: Response) {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => res));
}

afterEach(() => vi.unstubAllGlobals());

describe("apiFetch", () => {
  it("parses a successful response with the schema", async () => {
    mockFetch(200, { ok: true });
    await expect(apiFetch("/api/v1/x", z.object({ ok: z.boolean() }))).resolves.toEqual({ ok: true });
  });

  it("returns undefined for a 204 without a body", async () => {
    mockResponse(new Response(null, { status: 204 }));
    await expect(apiFetch("/api/v1/x", z.undefined(), { method: "POST" })).resolves.toBeUndefined();
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

  it("sends the Idempotency-Key header when given", async () => {
    const fn = mockFetch(200, {});
    await apiFetch("/api/v1/x", z.object({}), { method: "POST", body: { a: 1 }, idempotencyKey: "k-123456789" });
    const headers = (fn.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers["idempotency-key"]).toBe("k-123456789");
    expect(headers["content-type"]).toBe("application/json");
  });

  it("throws ApiError with the server error code", async () => {
    mockFetch(401, { error: { code: "invalid_token", message: "x" } });
    await expect(apiFetch("/api/v1/x", z.object({}))).rejects.toMatchObject({
      status: 401,
      code: "invalid_token",
    });
  });

  it("throws ApiError network_error when fetch rejects", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => Promise.reject(new TypeError("offline"))));
    const err = await apiFetch("/api/v1/x", z.object({})).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("network_error");
  });

  it("throws ApiError invalid_response when a 200 body does not match the schema", async () => {
    mockFetch(200, { ok: "yes" });
    const err = await apiFetch("/api/v1/x", z.object({ ok: z.boolean() })).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 200, code: "invalid_response" });
  });

  it("throws ApiError invalid_response for an empty 204 body", async () => {
    mockResponse(new Response(null, { status: 204 }));
    const err = await apiFetch("/api/v1/x", z.object({})).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 204, code: "invalid_response" });
  });

  it("maps a non-JSON error body to internal_error with the response status", async () => {
    mockResponse(new Response("Bad Gateway", { status: 502 }));
    const err = await apiFetch("/api/v1/x", z.object({})).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 502, code: "internal_error" });
  });
});

describe("api details and binary bodies", () => {
  it("exposes the error details", async () => {
    mockFetch(422, { error: { code: "document_missing_data", message: "x", details: { missing: [] } } });
    await expect(apiFetch("/api/v1/x", z.object({}))).rejects.toMatchObject({ status: 422, code: "document_missing_data", details: { missing: [] } });
  });

  it("returns a binary body as a Blob", async () => {
    mockResponse(new Response("%PDF-1.7", { status: 200, headers: { "content-type": "application/pdf" } }));
    const blob = await apiFetchBlob("/api/v1/x", { method: "POST", body: {} });
    expect(await blob.text()).toBe("%PDF-1.7");
  });
});
