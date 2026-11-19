import type { FastifyRequest } from "fastify";
import { config } from "./config";
import { DomainError } from "./errors";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defense for session routes that change state: a browser sends `Origin` on cross-origin requests,
 * and `Sec-Fetch-Site` where it omits `Origin`. Requests with neither (non-browser clients) pass.
 */
export function assertSameOrigin(req: FastifyRequest): void {
  if (SAFE_METHODS.has(req.method)) return;
  const origin = req.headers.origin;
  if (origin !== undefined) {
    if (origin !== new URL(config().appBaseUrl).origin) throw new DomainError("origin_rejected");
    return;
  }
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin") throw new DomainError("origin_rejected");
}
