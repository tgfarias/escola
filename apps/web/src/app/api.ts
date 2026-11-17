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
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? "GET",
      credentials: "same-origin",
      headers: init.body === undefined ? {} : { "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new ApiError(0, "network_error");
  }
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const parsed = ErrorResponse.safeParse(json);
    throw new ApiError(res.status, parsed.success ? parsed.data.error.code : "internal_error");
  }
  return schema.parse(json);
}
