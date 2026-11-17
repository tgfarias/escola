import { EncryptJWT } from "jose";
import { uuidv7 } from "uuidv7";
import { describe, expect, it } from "vitest";
import { adminDb, createSchool, dropSeedChallenges, seedTenant } from "../../../test/helpers";
import { withTenant } from "../../db/index";
import { signToken } from "../../platform/session";
import { assertOtpOk, checkCode, createChallenge, readOtpToken, signOtpToken, signOtpTokenAt } from "./otp";

const inertPayload = () => ({
  subjectKind: "staff" as const,
  schoolId: uuidv7(),
  challengeId: uuidv7(),
  subjectId: uuidv7(),
  inert: true,
});

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
  return { schoolId, seed, challengeId: challengeId!, code, expected: subject(seed) };
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

  describe("issuance limit", () => {
    const issue = (schoolId: string, guardianId: string, phone: string) =>
      withTenant(schoolId, (trx) =>
        createChallenge(trx, {
          schoolId,
          subjectKind: "guardian",
          subjectId: guardianId,
          channel: "whatsapp",
          to: phone,
          firstName: "Ana",
        }),
      );
    const otpEvents = async (schoolId: string) =>
      (
        await adminDb()
          .selectFrom("outboxEvents")
          .select("id")
          .where("schoolId", "=", schoolId)
          .where("type", "=", "auth.otp_requested")
          .execute()
      ).length;

    it("allows three challenges per subject and refuses the fourth without enqueuing", async () => {
      const schoolId = await createSchool();
      const seed = await seedTenant(schoolId);
      await dropSeedChallenges(schoolId);
      for (let i = 0; i < 3; i++) {
        expect(await issue(schoolId, seed.guardianId, seed.phone)).toEqual(expect.any(String));
      }
      expect(await issue(schoolId, seed.guardianId, seed.phone)).toBeNull();
      expect(await otpEvents(schoolId)).toBe(3);
    });

    it("allows a new challenge once the window has passed", async () => {
      const schoolId = await createSchool();
      const seed = await seedTenant(schoolId);
      await dropSeedChallenges(schoolId);
      for (let i = 0; i < 3; i++) await issue(schoolId, seed.guardianId, seed.phone);
      await adminDb()
        .updateTable("otpChallenges")
        .set({ createdAt: new Date(Date.now() - 16 * 60_000) })
        .where("subjectId", "=", seed.guardianId)
        .execute();
      expect(await issue(schoolId, seed.guardianId, seed.phone)).toEqual(expect.any(String));
    });

    it("limits per subject, not per school", async () => {
      const schoolId = await createSchool();
      const seed = await seedTenant(schoolId);
      await dropSeedChallenges(schoolId);
      for (let i = 0; i < 3; i++) await issue(schoolId, seed.guardianId, seed.phone);
      expect(await issue(schoolId, seed.guardianId, seed.phone)).toBeNull();
      const otherId = uuidv7();
      await adminDb()
        .insertInto("guardians")
        .values({ id: otherId, schoolId, phoneE164: "+5511999990002", firstName: "Bia" })
        .execute();
      expect(await issue(schoolId, otherId, "+5511999990002")).toEqual(expect.any(String));
    });
  });

  it("maps results to domain errors", () => {
    expect(() => assertOtpOk("ok")).not.toThrow();
    expect(() => assertOtpOk("invalid")).toThrow("otp_invalid");
    expect(() => assertOtpOk("expired")).toThrow("otp_expired");
    expect(() => assertOtpOk("too_many_attempts")).toThrow("otp_too_many_attempts");
  });

  it("round-trips the otp token and rejects garbage", async () => {
    const payload = inertPayload();
    const token = await signOtpToken(payload);
    expect(token.split(".")).toHaveLength(5);
    expect(await readOtpToken(token)).toEqual({ ...payload, iat: expect.any(Number) });
    await expect(readOtpToken("garbage")).rejects.toThrow("otp_expired");
  });

  it("rejects a token signed with the session purpose", async () => {
    const token = await signToken("session", inertPayload(), 60);
    await expect(readOtpToken(token)).rejects.toThrow("otp_expired");
  });

  it("rejects a signed (JWS) token carrying the otp purpose", async () => {
    const token = await signToken("otp", inertPayload(), 60);
    await expect(readOtpToken(token)).rejects.toThrow("otp_expired");
  });

  it("rejects a token encrypted with a different key", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new EncryptJWT({ ...inertPayload() })
      .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .encrypt(new Uint8Array(32).fill(7));
    await expect(readOtpToken(token)).rejects.toThrow("otp_expired");
  });

  it("rejects an expired token", async () => {
    const token = await signOtpTokenAt(inertPayload(), Math.floor(Date.now() / 1000) - 11 * 60);
    await expect(readOtpToken(token)).rejects.toThrow("otp_expired");
  });

  it("gives real and inert staff tokens the same length", async () => {
    const real = await signOtpToken({ ...inertPayload(), inert: false });
    const inert = await signOtpToken(inertPayload());
    expect(real.length).toBe(inert.length);
  });
});
