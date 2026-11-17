import { timingSafeEqual } from "node:crypto";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import type { Trx } from "../../db/index";
import { DomainError } from "../../platform/errors";
import { enqueueEvent } from "../../platform/outbox";
import { signToken, verifyToken } from "../../platform/session";
import * as repo from "./repo";
import { generateOtpCode, hashOtp } from "./tokens";

const MAX_ATTEMPTS = 5;
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
): Promise<string> {
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
export async function checkCode(trx: Trx, challengeId: string, code: string): Promise<OtpResult> {
  const challenge = await repo.lockChallenge(trx, challengeId);
  if (!challenge || challenge.consumedAt || challenge.expired) return "expired";
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
  }),
  z.object({
    subjectKind: z.literal("staff"),
    schoolId: z.string().uuid(),
    challengeId: z.string().uuid(),
    subjectId: z.string().uuid(),
  }),
  z.object({ subjectKind: z.literal("none") }),
]);
export type OtpTokenPayload = z.infer<typeof OtpTokenPayload>;

export function signOtpToken(payload: OtpTokenPayload): Promise<string> {
  return signToken("otp", payload, OTP_TOKEN_TTL);
}

export async function readOtpToken(token: string): Promise<OtpTokenPayload> {
  try {
    return OtpTokenPayload.parse(await verifyToken("otp", token));
  } catch {
    throw new DomainError("otp_expired");
  }
}
