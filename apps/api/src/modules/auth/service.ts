import type { MeResponse } from "@app-lanche/contracts";
import { uuidv7 } from "uuidv7";
import { withTenant } from "../../db/index";
import { DomainError } from "../../platform/errors";
import type { GuardianScope, SessionClaims } from "../../platform/session";
import { assertOtpOk, checkCode, createChallenge, readOtpToken, signOtpToken } from "./otp";
import * as repo from "./repo";
import { hashToken } from "./tokens";

export type ExchangeResult =
  | { status: "ok"; claims: SessionClaims; scope: GuardianScope }
  | { status: "step_up_required"; otpToken: string };

export async function exchange(input: { token: string; deviceSecret: string }): Promise<ExchangeResult> {
  const resolved = await repo.resolveMagicLink(hashToken(input.token));
  if (!resolved) throw new DomainError("invalid_token");
  const { schoolId } = resolved;
  const deviceHash = hashToken(input.deviceSecret);

  const outcome = await withTenant(schoolId, async (trx) => {
    const link = await repo.getValidMagicLink(trx, resolved.magicLinkId);
    if (!link) return { kind: "invalid" as const };
    const guardian = await repo.lockGuardian(trx, link.guardianId);
    const devices = await repo.listGuardianDevices(trx, guardian.id);
    const scope = link.scope as GuardianScope;
    // Revoked devices count as "has had a device": only a guardian who never had one skips OTP.
    if (devices.length === 0) {
      await repo.insertGuardianDevice(trx, { id: uuidv7(), schoolId, guardianId: guardian.id, secretHash: deviceHash });
      return { kind: "ok" as const, guardianId: guardian.id, scope };
    }
    if (devices.some((d) => !d.revoked && d.secretHash === deviceHash)) {
      return { kind: "ok" as const, guardianId: guardian.id, scope };
    }
    const challengeId = await createChallenge(trx, {
      schoolId,
      subjectKind: "guardian",
      subjectId: guardian.id,
      channel: "whatsapp",
      to: guardian.phoneE164,
      firstName: guardian.firstName,
    });
    return { kind: "step_up" as const, guardianId: guardian.id, scope, challengeId };
  });

  if (outcome.kind === "invalid") throw new DomainError("invalid_token");
  if (outcome.kind === "ok") {
    return {
      status: "ok",
      scope: outcome.scope,
      claims: { kind: "guardian", sub: outcome.guardianId, schoolId, scope: outcome.scope },
    };
  }
  const otpToken = await signOtpToken({
    subjectKind: "guardian",
    schoolId,
    challengeId: outcome.challengeId,
    subjectId: outcome.guardianId,
    deviceHash,
    scope: outcome.scope,
  });
  return { status: "step_up_required", otpToken };
}

export async function verifyGuardianOtp(input: {
  otpToken: string;
  code: string;
}): Promise<{ claims: SessionClaims; scope: GuardianScope }> {
  const payload = await readOtpToken(input.otpToken);
  if (payload.subjectKind !== "guardian") throw new DomainError("otp_invalid");
  const result = await withTenant(payload.schoolId, async (trx) => {
    const checked = await checkCode(trx, payload.challengeId, input.code, {
      subjectKind: "guardian",
      subjectId: payload.subjectId,
    });
    if (checked === "ok") {
      await repo.insertGuardianDevice(trx, {
        id: uuidv7(),
        schoolId: payload.schoolId,
        guardianId: payload.subjectId,
        secretHash: payload.deviceHash,
      });
    }
    return checked;
  });
  assertOtpOk(result);
  return {
    scope: payload.scope,
    claims: {
      kind: "guardian",
      sub: payload.subjectId,
      schoolId: payload.schoolId,
      scope: payload.scope,
      otpAt: Math.floor(Date.now() / 1000),
    },
  };
}

export async function getMe(session: SessionClaims): Promise<MeResponse> {
  const found = await withTenant(session.schoolId, (trx) => repo.getGuardianWithStudents(trx, session.sub));
  if (!found) throw new DomainError("unauthenticated");
  return found;
}
