import type {
  InternalMagicLinkRequest,
  InternalMagicLinkResponse,
  MeResponse,
  Shift,
  StaffMeResponse,
  StaffRole,
} from "@app-lanche/contracts";
import { uuidv7 } from "uuidv7";
import { withTenant } from "../../db/index";
import { DomainError } from "../../platform/errors";
import type { GuardianScope, SessionClaims } from "../../platform/session";
import { createMagicLink } from "./magicLink";
import { assertOtpOk, checkCode, createChallenge, inertStaffPayload, readOtpToken, signOtpToken } from "./otp";
import * as wallet from "../wallet/service";
import * as repo from "./repo";
import { hashToken } from "./tokens";

const INERT_TOKEN_VALIDITY_SECONDS = 5 * 60;

export type ExchangeResult =
  | { status: "ok"; claims: SessionClaims; scope: GuardianScope }
  | { status: "step_up_required"; otpToken: string }
  | { status: "throttled"; guardianId: string };

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
    if (challengeId === null) return { kind: "throttled" as const, guardianId: guardian.id };
    return { kind: "step_up" as const, guardianId: guardian.id, scope, challengeId };
  });

  if (outcome.kind === "invalid") throw new DomainError("invalid_token");
  // The route logs the throttled outcome and answers 429.
  if (outcome.kind === "throttled") return { status: "throttled", guardianId: outcome.guardianId };
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
    inert: false,
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
  const found = await withTenant(session.schoolId, async (trx) => {
    const data = await repo.getGuardianWithStudents(trx, session.sub);
    return (
      data && {
        guardian: data.guardian,
        students: data.students.map((s) => ({ ...s, shift: s.shift as Shift })),
        walletBalanceCents: await wallet.balanceOf(trx, session.sub),
      }
    );
  });
  if (!found) throw new DomainError("unauthenticated");
  return found;
}

/** `throttled` is for the route's log only; the HTTP response carries just `otpToken`. */
export type StaffOtpRequestResult =
  | { otpToken: string; throttled: false }
  | { otpToken: string; throttled: true; staffUserId: string };

export async function requestStaffOtp(email: string): Promise<StaffOtpRequestResult> {
  const resolved = await repo.resolveStaffEmail(email);
  if (!resolved) return { otpToken: await signOtpToken(inertStaffPayload()), throttled: false };
  const outcome = await withTenant(resolved.schoolId, async (trx) => {
    const staff = await repo.lockStaffUser(trx, resolved.staffUserId);
    if (!staff) return { kind: "inactive" as const };
    const challengeId = await createChallenge(trx, {
      schoolId: resolved.schoolId,
      subjectKind: "staff",
      subjectId: resolved.staffUserId,
      channel: "email",
      to: staff.email,
      firstName: null,
    });
    return challengeId === null ? { kind: "throttled" as const } : { kind: "issued" as const, challengeId };
  });
  // Throttled or gone/deactivated meanwhile: answer exactly like an unknown e-mail so the response does not reveal the account.
  if (outcome.kind === "inactive") return { otpToken: await signOtpToken(inertStaffPayload()), throttled: false };
  if (outcome.kind === "throttled") {
    return { otpToken: await signOtpToken(inertStaffPayload()), throttled: true, staffUserId: resolved.staffUserId };
  }
  const otpToken = await signOtpToken({
    subjectKind: "staff",
    schoolId: resolved.schoolId,
    challengeId: outcome.challengeId,
    subjectId: resolved.staffUserId,
    inert: false,
  });
  return { otpToken, throttled: false };
}

export async function verifyStaffOtp(input: {
  otpToken: string;
  code: string;
}): Promise<{ claims: SessionClaims; role: StaffRole }> {
  const payload = await readOtpToken(input.otpToken);
  if (payload.subjectKind !== "staff") throw new DomainError("otp_invalid");
  if (payload.inert) {
    // Mirror a real challenge's 5-minute validity without touching the database.
    const ageSeconds = Math.floor(Date.now() / 1000) - payload.iat;
    throw new DomainError(ageSeconds > INERT_TOKEN_VALIDITY_SECONDS ? "otp_expired" : "otp_invalid");
  }
  const outcome = await withTenant(payload.schoolId, async (trx) => {
    const checked = await checkCode(trx, payload.challengeId, input.code, {
      subjectKind: "staff",
      subjectId: payload.subjectId,
    });
    const staff = checked === "ok" ? await repo.getStaffUser(trx, payload.subjectId) : undefined;
    return { checked, staff };
  });
  assertOtpOk(outcome.checked);
  if (!outcome.staff) throw new DomainError("otp_invalid");
  const role = outcome.staff.role as StaffRole;
  return {
    role,
    claims: { kind: "staff", sub: payload.subjectId, schoolId: payload.schoolId, role },
  };
}

/** The staff user's current role, or undefined when the user is gone or deactivated. */
export async function loadActiveStaff(schoolId: string, staffUserId: string): Promise<{ role: StaffRole } | undefined> {
  const row = await withTenant(schoolId, (trx) => repo.getActiveStaffRole(trx, staffUserId));
  return row ? { role: row.role as StaffRole } : undefined;
}

/** True while the kitchen device is paired and not revoked. */
export async function loadActiveKitchenDevice(schoolId: string, deviceId: string): Promise<boolean> {
  return withTenant(schoolId, (trx) => repo.activeKitchenDevice(trx, deviceId));
}

export async function getStaffMe(session: SessionClaims): Promise<StaffMeResponse> {
  const staff = await withTenant(session.schoolId, (trx) => repo.getStaffUser(trx, session.sub));
  if (!staff) throw new DomainError("unauthenticated");
  return { ...staff, role: staff.role as StaffRole };
}

export { createMagicLink };
export { hashToken };
export const resolvePairingCode = repo.resolvePairingCode;

/** POST /internal/v1/schools/:school_id/magic-links — reenvio avulso pelo n8n. */
export async function issueMagicLink(
  schoolId: string,
  body: InternalMagicLinkRequest,
): Promise<InternalMagicLinkResponse> {
  return withTenant(schoolId, async (trx) => {
    if (!(await repo.guardianExists(trx, body.guardian_id))) throw new DomainError("not_found");
    const link = await createMagicLink(trx, {
      schoolId,
      guardianId: body.guardian_id,
      scope: body.scope,
      serviceDate: body.service_date,
    });
    return { link_url: link.url, expires_at: link.expiresAt.toISOString() };
  });
}
