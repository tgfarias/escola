import { hkdfSync, timingSafeEqual } from "node:crypto";
import { EncryptJWT, jwtDecrypt } from "jose";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import type { Trx } from "../../db/index";
import { config } from "../../platform/config";
import { DomainError } from "../../platform/errors";
import { enqueueEvent } from "../../platform/outbox";
import * as repo from "./repo";
import { generateOtpCode, hashOtp } from "./tokens";

const MAX_ATTEMPTS = 5;
export const MAX_CHALLENGES_PER_WINDOW = 3;
export const CHALLENGE_WINDOW_MINUTES = 15;
const OTP_TOKEN_TTL = 10 * 60;

export type OtpResult = "ok" | "invalid" | "expired" | "too_many_attempts";

function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function createChallenge(
  trx: Trx,
  input: {
    schoolId: string;
    subjectKind: "guardian" | "staff";
    subjectId: string;
    channel: "whatsapp" | "email";
    to: string;
    firstName: string | null;
  },
): Promise<string | null> {
  const recent = await repo.countRecentChallenges(
    trx,
    input.subjectKind,
    input.subjectId,
    CHALLENGE_WINDOW_MINUTES,
  );
  if (recent >= MAX_CHALLENGES_PER_WINDOW) return null;
  const id = uuidv7();
  const code = generateOtpCode();
  const expiresAt = await repo.insertChallenge(trx, {
    id,
    schoolId: input.schoolId,
    subjectKind: input.subjectKind,
    subjectId: input.subjectId,
    codeHash: hashOtp(id, code),
  });
  await enqueueEvent(trx, input.schoolId, {
    type: "auth.otp_requested",
    data: {
      channel: input.channel,
      to: input.to,
      first_name: input.firstName,
      code,
      expires_at: expiresAt.toISOString(),
    },
  });
  return id;
}

/** Não lança por código errado: o chamador precisa commitar o incremento de tentativas. */
export async function checkCode(
  trx: Trx,
  challengeId: string,
  code: string,
  expected: { subjectKind: "guardian" | "staff"; subjectId: string },
): Promise<OtpResult> {
  const challenge = await repo.lockChallenge(trx, challengeId);
  if (!challenge || challenge.consumedAt || challenge.expired) return "expired";
  if (challenge.subjectKind !== expected.subjectKind || challenge.subjectId !== expected.subjectId) {
    return "expired";
  }
  if (challenge.attempts >= MAX_ATTEMPTS) return "too_many_attempts";
  await repo.incrementAttempts(trx, challengeId);
  if (!hashesMatch(hashOtp(challengeId, code), challenge.codeHash)) return "invalid";
  await repo.consumeChallenge(trx, challengeId);
  return "ok";
}

export function assertOtpOk(result: OtpResult): void {
  if (result === "invalid") throw new DomainError("otp_invalid");
  if (result === "expired") throw new DomainError("otp_expired");
  if (result === "too_many_attempts") throw new DomainError("otp_too_many_attempts");
}

const OtpTokenPayload = z.discriminatedUnion("subjectKind", [
  z.object({
    subjectKind: z.literal("guardian"),
    schoolId: z.string().uuid(),
    challengeId: z.string().uuid(),
    subjectId: z.string().uuid(),
    deviceHash: z.string(),
    scope: z.enum(["order", "documents"]),
    inert: z.boolean(),
  }),
  z.object({
    subjectKind: z.literal("staff"),
    schoolId: z.string().uuid(),
    challengeId: z.string().uuid(),
    subjectId: z.string().uuid(),
    inert: z.boolean(),
  }),
]);
export type OtpTokenPayload = z.infer<typeof OtpTokenPayload>;

/** A staff token for an unknown, throttled or inactive account: same shape as a real one, never checked against the database. */
export function inertStaffPayload(): OtpTokenPayload {
  return { subjectKind: "staff", schoolId: uuidv7(), challengeId: uuidv7(), subjectId: uuidv7(), inert: true };
}

/**
 * Every OTP token's plaintext claims are padded to this many bytes, so the ciphertext length does not
 * depend on the payload (`"inert":true` is one byte shorter than `"inert":false`).
 */
const OTP_TOKEN_PLAINTEXT_BYTES = 384;

let cachedKey: { secret: string; key: Uint8Array } | undefined;

function otpTokenKey(): Uint8Array {
  const secret = config().sessionSecret;
  if (cachedKey?.secret !== secret) {
    cachedKey = { secret, key: new Uint8Array(hkdfSync("sha256", secret, "", "app-lanche/otp-token/v1", 32)) };
  }
  return cachedKey.key;
}

/** Encrypts the payload as a JWE (`dir` + `A256GCM`) issued at `issuedAtSeconds`. Exported for tests. */
export function signOtpTokenAt(payload: OtpTokenPayload, issuedAtSeconds: number): Promise<string> {
  const claims = { ...payload, iat: issuedAtSeconds, exp: issuedAtSeconds + OTP_TOKEN_TTL, pad: "" };
  const padding = OTP_TOKEN_PLAINTEXT_BYTES - Buffer.byteLength(JSON.stringify(claims));
  if (padding < 0) throw new Error("otp token payload too large");
  return new EncryptJWT({ ...payload, pad: " ".repeat(padding) })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt(issuedAtSeconds)
    .setExpirationTime(issuedAtSeconds + OTP_TOKEN_TTL)
    .encrypt(otpTokenKey());
}

export function signOtpToken(payload: OtpTokenPayload): Promise<string> {
  return signOtpTokenAt(payload, Math.floor(Date.now() / 1000));
}

export async function readOtpToken(token: string): Promise<OtpTokenPayload & { iat: number }> {
  try {
    const { payload } = await jwtDecrypt(token, otpTokenKey(), {
      keyManagementAlgorithms: ["dir"],
      contentEncryptionAlgorithms: ["A256GCM"],
      requiredClaims: ["exp", "iat"],
    });
    return { ...OtpTokenPayload.parse(payload), iat: payload.iat! };
  } catch {
    throw new DomainError("otp_expired");
  }
}
