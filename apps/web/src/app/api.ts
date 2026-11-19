import { ErrorResponse } from "@app-lanche/contracts";
import type { z } from "zod";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(code);
  }
}

type Init = { method?: string; body?: unknown; idempotencyKey?: string };

async function send(path: string, init: Init): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.idempotencyKey) headers["idempotency-key"] = init.idempotencyKey;
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? "GET",
      credentials: "same-origin",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new ApiError(0, "network_error");
  }
  if (!res.ok) {
    const parsed = ErrorResponse.safeParse(await res.json().catch(() => null));
    throw parsed.success
      ? new ApiError(res.status, parsed.data.error.code, parsed.data.error.details)
      : new ApiError(res.status, "internal_error");
  }
  return res;
}

export async function apiFetch<T>(path: string, schema: z.ZodType<T>, init: Init = {}): Promise<T> {
  const res = await send(path, init);
  // 204 has no body: validate undefined against the schema (z.undefined() passes, object schemas fail).
  const json: unknown = res.status === 204 ? undefined : await res.json().catch(() => null);
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ApiError(res.status, "invalid_response");
  return parsed.data;
}

/** Corpo binário (PDF da prévia). */
export async function apiFetchBlob(path: string, init: Init = {}): Promise<Blob> {
  return (await send(path, init)).blob();
}
