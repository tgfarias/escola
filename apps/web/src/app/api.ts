import { ErrorResponse } from "@app-lanche/contracts";
import type { z } from "zod";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
  }
}

export async function apiFetch<T>(
  path: string,
  schema: z.ZodType<T>,
  init: { method?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<T> {
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
  // 204 has no body: validate undefined against the schema (z.undefined() passes, object schemas fail).
  const json: unknown = res.status === 204 ? undefined : await res.json().catch(() => null);
  if (!res.ok) {
    const parsed = ErrorResponse.safeParse(json);
    throw new ApiError(res.status, parsed.success ? parsed.data.error.code : "internal_error");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ApiError(res.status, "invalid_response");
  return parsed.data;
}
