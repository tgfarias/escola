import { uuidv7 } from "uuidv7";
import { describe, expect, it } from "vitest";
import { adminDb, createSchool, seedTenant } from "../../../test/helpers";
import { withTenant } from "../../db/index";
import { signToken } from "../../platform/session";
import { assertOtpOk, checkCode, createChallenge, readOtpToken, signOtpToken } from "./otp";

async function setup() {
  const schoolId = await createSchool();
  const seed = await seedTenant(schoolId);
  const challengeId = await withTenant(schoolId, (trx) =>
    createChallenge(trx, {
      schoolId,
      subjectKind: "guardian",
      subjectId: seed.guardianId,
      channel: "whatsapp",
      to: seed.phone,
      firstName: "Ana",
    }),
  );
  const event = await adminDb()
    .selectFrom("outboxEvents")
    .select("data")
    .where("schoolId", "=", schoolId)
    .where("type", "=", "auth.otp_requested")
    .executeTakeFirstOrThrow();
  const code = (event.data as { code: string }).code;
  return { schoolId, challengeId, code, expected: subject(seed) };
}

const subject = (seed: { guardianId: string }) => ({ subjectKind: "guardian" as const, subjectId: seed.guardianId });
const wrong = (code: string) => (code === "000000" ? "000001" : "000000");

describe("otp", () => {
  it("enqueues the code and stores only its hash", async () => {
    const { schoolId, challengeId, code } = await setup();
    expect(code).toMatch(/^\d{6}$/);
    const row = await adminDb()
      .selectFrom("otpChallenges")
      .selectAll()
      .where("id", "=", challengeId)
      .executeTakeFirstOrThrow();
    expect(row.schoolId).toBe(schoolId);
    expect(row.codeHash).not.toContain(code);
  });

  it("accepts the right code once", async () => {
    const { schoolId, challengeId, code, expected } = await setup();
    expect(await withTenant(schoolId, (trx) => checkCode(trx, challengeId, code, expected))).toBe("ok");
    expect(await withTenant(schoolId, (trx) => checkCode(trx, challengeId, code, expected))).toBe("expired");
  });

  it("counts wrong attempts and locks after five", async () => {
    const { schoolId, challengeId, code, expected } = await setup();
    for (let i = 0; i < 5; i++) {
      expect(await withTenant(schoolId, (trx) => checkCode(trx, challengeId, wrong(code), expected))).toBe("invalid");
    }
    expect(await withTenant(schoolId, (trx) => checkCode(trx, challengeId, code, expected))).toBe("too_many_attempts");
  });

  it("commits the attempt increment after a wrong code", async () => {
    const { schoolId, challengeId, code, expected } = await setup();
    expect(await withTenant(schoolId, (trx) => checkCode(trx, challengeId, wrong(code), expected))).toBe("invalid");
    const row = await adminDb()
      .selectFrom("otpChallenges")
      .select("attempts")
      .where("id", "=", challengeId)
      .executeTakeFirstOrThrow();
    expect(row.attempts).toBe(1);
  });

  it("rejects an expired challenge", async () => {
    const { schoolId, challengeId, code, expected } = await setup();
    await adminDb()
      .updateTable("otpChallenges")
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where("id", "=", challengeId)
      .execute();
    expect(await withTenant(schoolId, (trx) => checkCode(trx, challengeId, code, expected))).toBe("expired");
  });

  it("rejects a challenge checked for another subject without counting an attempt", async () => {
    const { schoolId, challengeId, code } = await setup();
    const other = { subjectKind: "guardian" as const, subjectId: uuidv7() };
    expect(await withTenant(schoolId, (trx) => checkCode(trx, challengeId, code, other))).toBe("expired");
    const row = await adminDb()
      .selectFrom("otpChallenges")
      .select("attempts")
      .where("id", "=", challengeId)
      .executeTakeFirstOrThrow();
    expect(row.attempts).toBe(0);
  });

  it("maps results to domain errors", () => {
    expect(() => assertOtpOk("ok")).not.toThrow();
    expect(() => assertOtpOk("invalid")).toThrow("otp_invalid");
    expect(() => assertOtpOk("expired")).toThrow("otp_expired");
    expect(() => assertOtpOk("too_many_attempts")).toThrow("otp_too_many_attempts");
  });

  it("round-trips the otp token and rejects garbage", async () => {
    const token = await signOtpToken({ subjectKind: "none" });
    expect(await readOtpToken(token)).toEqual({ subjectKind: "none" });
    await expect(readOtpToken("garbage")).rejects.toThrow("otp_expired");
  });

  it("rejects a token signed with the session purpose", async () => {
    const token = await signToken("session", { subjectKind: "none" }, 60);
    await expect(readOtpToken(token)).rejects.toThrow("otp_expired");
  });
});
