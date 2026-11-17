import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { config } from "./config";
import { DomainError } from "./errors";

const MAX_SKEW_MS = 5 * 60_000;

export interface InternalSignInput {
  method: string;
  /** URL exatamente como recebida (caminho + query string). */
  path: string;
  timestamp: string;
  body: string;
}

/** Assina `METHOD\npathWithQuery\ntimestamp\nrawBody`. */
export function signInternal(secret: string, input: InternalSignInput): string {
  const { method, path, timestamp, body } = input;
  return createHmac("sha256", secret)
    .update(`${method.toUpperCase()}\n${path}\n${timestamp}\n${body}`)
    .digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function header(req: FastifyRequest, name: string): string {
  const value = req.headers[name];
  return typeof value === "string" ? value : "";
}

/** Lança invalid_signature se a requisição não vier do n8n. */
export function verifyInternalRequest(req: FastifyRequest): void {
  const { internalServiceToken, internalHmacSecret } = config();
  const timestamp = header(req, "x-timestamp");
  const skew = Math.abs(Date.now() - Date.parse(timestamp));
  const expected = signInternal(internalHmacSecret, {
    method: req.method,
    path: req.url,
    timestamp,
    body: req.rawBody ?? "",
  });
  const ok =
    safeEqual(header(req, "authorization"), `Bearer ${internalServiceToken}`) &&
    Number.isFinite(skew) &&
    skew <= MAX_SKEW_MS &&
    safeEqual(header(req, "x-signature"), expected);
  if (!ok) throw new DomainError("invalid_signature");
}
