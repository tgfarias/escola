import type { FastifyReply, FastifyRequest } from "fastify";
import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";
import type { RouteAuth } from "../app";
import { config } from "./config";
import { DomainError } from "./errors";

export const SESSION_COOKIE = "__session";
export const GUARDIAN_SESSION_TTL = 2 * 60 * 60;
export const STAFF_SESSION_TTL = 8 * 60 * 60;
export const KITCHEN_SESSION_TTL = 30 * 24 * 60 * 60;
export const KITCHEN_GRACE_SECONDS = 90 * 24 * 60 * 60;

const GuardianScope = z.enum(["order", "documents"]);
const StaffRole = z.enum(["admin", "secretaria", "cozinha"]);
export type GuardianScope = z.infer<typeof GuardianScope>;
export type StaffRole = z.infer<typeof StaffRole>;

const SessionClaims = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("guardian"),
    sub: z.string().uuid(),
    schoolId: z.string().uuid(),
    scope: GuardianScope,
    otpAt: z.number().optional(),
  }),
  z.object({
    kind: z.literal("staff"),
    sub: z.string().uuid(),
    schoolId: z.string().uuid(),
    role: StaffRole,
  }),
  z.object({ kind: z.literal("kitchen"), sub: z.string().uuid(), schoolId: z.string().uuid() }),
]);
export type SessionClaims = z.infer<typeof SessionClaims>;

declare module "fastify" {
  interface FastifyRequest {
    session?: SessionClaims;
  }
}

function key(): Uint8Array {
  return new TextEncoder().encode(config().sessionSecret);
}

export async function signToken(
  purpose: "session" | "otp",
  payload: Record<string, unknown>,
  ttlSeconds: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ ...payload, purpose })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(key());
}

export async function verifyToken(
  purpose: "session" | "otp",
  token: string,
  opts: { graceSeconds?: number } = {},
): Promise<Record<string, unknown>> {
  try {
    const { payload } = await jwtVerify(token, key(), {
      algorithms: ["HS256"],
      requiredClaims: ["exp"],
      clockTolerance: opts.graceSeconds ?? 0,
    });
    if (payload.purpose !== purpose) throw new Error("wrong purpose");
    return payload;
  } catch {
    throw new DomainError("unauthenticated");
  }
}

export async function issueSession(
  reply: FastifyReply,
  claims: SessionClaims,
  ttlSeconds: number,
  opts: { cookieMaxAge?: number } = {},
): Promise<void> {
  const token = await signToken("session", claims, ttlSeconds);
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: opts.cookieMaxAge ?? ttlSeconds,
  });
}

/**
 * Apaga o cookie de sessão com os mesmos atributos de issueSession. O token é sem estado no servidor: encerrar é tirar
 * o cookie do navegador; uma cópia do token vale até vencer.
 */
export function clearSession(reply: FastifyReply): void {
  reply.setCookie(SESSION_COOKIE, "", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 });
}

export async function authenticate(
  req: FastifyRequest,
  auth: Exclude<RouteAuth, string>,
): Promise<SessionClaims> {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) throw new DomainError("unauthenticated");
  let payload: Record<string, unknown>;
  try {
    payload = await verifyToken("session", token);
  } catch (err) {
    if (auth.kind !== "kitchen") throw err;
    // Spec 7.3 (6): a tablet that stayed offline past the token expiry is still accepted while the device is active.
    payload = await verifyToken("session", token, { graceSeconds: KITCHEN_GRACE_SECONDS });
    if (payload.kind !== "kitchen") throw new DomainError("unauthenticated");
  }
  const parsed = SessionClaims.safeParse(payload);
  if (!parsed.success) throw new DomainError("unauthenticated");
  const claims = parsed.data;
  if (claims.kind !== auth.kind) throw new DomainError("insufficient_scope");
  if (claims.kind === "guardian" && auth.scope !== undefined) {
    const allowed: GuardianScope[] = Array.isArray(auth.scope) ? auth.scope : [auth.scope];
    if (!allowed.includes(claims.scope)) throw new DomainError("insufficient_scope");
  }
  // Staff roles are checked by the caller against the role re-read from the database.
  return claims;
}
