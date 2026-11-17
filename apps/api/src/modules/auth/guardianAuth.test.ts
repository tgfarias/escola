import { describe, expect, it } from "vitest";
import { adminDb, createSchool, seedTenant } from "../../../test/helpers";
import { buildApp } from "../../app";
import { withTenant } from "../../db/index";
import { SESSION_COOKIE } from "../../platform/session";
import { createMagicLink } from "./magicLink";
import { hashToken } from "./tokens";

const DEVICE_A = "a".repeat(43);
const DEVICE_B = "b".repeat(43);

async function setup(expiresInMs = 3_600_000, scope: "order" | "documents" = "order") {
  const schoolId = await createSchool();
  const seed = await seedTenant(schoolId);
  const link = await withTenant(schoolId, (trx) =>
    createMagicLink(trx, {
      schoolId,
      guardianId: seed.guardianId,
      scope,
      expiresAt: new Date(Date.now() + expiresInMs),
    }),
  );
  return { schoolId, seed, token: link.url.split("#")[1]! };
}

function exchange(token: string, deviceSecret: string) {
  return buildApp().inject({ method: "POST", url: "/api/v1/auth/exchange", payload: { token, deviceSecret } });
}

function verify(otpToken: string, code: string) {
  return buildApp().inject({ method: "POST", url: "/api/v1/auth/otp/verify", payload: { otpToken, code } });
}

async function lastOtpCode(schoolId: string): Promise<string> {
  const event = await adminDb()
    .selectFrom("outboxEvents")
    .select("data")
    .where("schoolId", "=", schoolId)
    .where("type", "=", "auth.otp_requested")
    .orderBy("occurredAt", "desc")
    .executeTakeFirstOrThrow();
  return (event.data as { code: string }).code;
}

function sessionCookie(res: { cookies: { name: string; value: string }[] }) {
  return res.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
}

describe("guardian authentication", () => {
  it("opens a session on the first device and lists the children", async () => {
    const { token, seed } = await setup();
    const res = await exchange(token, DEVICE_A);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", scope: "order" });
    const cookie = sessionCookie(res)!;
    const me = await buildApp().inject({ method: "GET", url: "/api/v1/me", cookies: { [SESSION_COOKIE]: cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({
      guardian: { id: seed.guardianId, firstName: "Ana" },
      students: [{ id: seed.studentId, firstName: "Léo", className: "Infantil 3A" }],
    });
  });

  it("lets the same device reuse the link", async () => {
    const { token } = await setup();
    await exchange(token, DEVICE_A);
    const again = await exchange(token, DEVICE_A);
    expect(again.json().status).toBe("ok");
  });

  it("requires OTP on a second device, then remembers it", async () => {
    const { token, schoolId } = await setup();
    await exchange(token, DEVICE_A);

    const second = await exchange(token, DEVICE_B);
    expect(second.json().status).toBe("step_up_required");
    expect(sessionCookie(second)).toBeUndefined();
    const { otpToken } = second.json();
    const code = await lastOtpCode(schoolId);

    const bad = await verify(otpToken, code === "000000" ? "000001" : "000000");
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe("otp_invalid");
    const attempts = await adminDb()
      .selectFrom("otpChallenges")
      .select("attempts")
      .where("schoolId", "=", schoolId)
      .where("codeHash", "<>", "seed")
      .executeTakeFirstOrThrow();
    expect(attempts.attempts).toBe(1);

    const good = await verify(otpToken, code);
    expect(good.statusCode).toBe(200);
    expect(good.json()).toEqual({ status: "ok", scope: "order" });
    expect(sessionCookie(good)).toBeDefined();

    const third = await exchange(token, DEVICE_B);
    expect(third.json().status).toBe("ok");
  });

  it("rejects an unknown token", async () => {
    const res = await exchange("x".repeat(43), DEVICE_A);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("invalid_token");
  });

  it("rejects an expired link", async () => {
    const { token } = await setup(-1000);
    const res = await exchange(token, DEVICE_A);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("invalid_token");
  });

  it("answers unknown and expired tokens identically", async () => {
    const { token } = await setup(-1000);
    const expired = await exchange(token, DEVICE_A);
    const unknown = await exchange("x".repeat(43), DEVICE_A);
    expect(expired.statusCode).toBe(unknown.statusCode);
    expect(expired.json()).toEqual(unknown.json());
  });

  it("rejects an unreadable otp token", async () => {
    const res = await verify("garbage", "123456");
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("otp_expired");
  });

  it("requires a session for /me", async () => {
    const res = await buildApp().inject({ method: "GET", url: "/api/v1/me" });
    expect(res.statusCode).toBe(401);
  });

  it("only shows /me data of the guardian's own school", async () => {
    const a = await setup();
    const b = await setup();
    const resA = await exchange(a.token, DEVICE_A);
    const meA = await buildApp().inject({
      method: "GET",
      url: "/api/v1/me",
      cookies: { [SESSION_COOKIE]: sessionCookie(resA)! },
    });
    const resB = await exchange(b.token, DEVICE_A);
    const meB = await buildApp().inject({
      method: "GET",
      url: "/api/v1/me",
      cookies: { [SESSION_COOKIE]: sessionCookie(resB)! },
    });
    expect(meA.json().students.map((s: { id: string }) => s.id)).toEqual([a.seed.studentId]);
    expect(meB.json().students.map((s: { id: string }) => s.id)).toEqual([b.seed.studentId]);
    expect(meA.json().guardian.id).toBe(a.seed.guardianId);
  });

  it("returns the documents scope for a documents link", async () => {
    const { token } = await setup(3_600_000, "documents");
    const res = await exchange(token, DEVICE_A);
    expect(res.json()).toEqual({ status: "ok", scope: "documents" });
  });

  it("answers 429 on the sixth call after five wrong codes", async () => {
    const { token, schoolId } = await setup();
    await exchange(token, DEVICE_A);
    const { otpToken } = (await exchange(token, DEVICE_B)).json();
    const code = await lastOtpCode(schoolId);
    const wrong = code === "000000" ? "000001" : "000000";
    for (let i = 0; i < 5; i++) {
      expect((await verify(otpToken, wrong)).statusCode).toBe(401);
    }
    const sixth = await verify(otpToken, code);
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json().error.code).toBe("otp_too_many_attempts");
  });

  it("does not let a guardian whose only device was revoked skip OTP", async () => {
    const { token, schoolId, seed } = await setup();
    await exchange(token, DEVICE_A);
    await adminDb()
      .updateTable("devices")
      .set({ revokedAt: new Date() })
      .where("guardianId", "=", seed.guardianId)
      .execute();

    const again = await exchange(token, DEVICE_A);
    expect(again.json().status).toBe("step_up_required");
    expect(sessionCookie(again)).toBeUndefined();

    const good = await verify(again.json().otpToken, await lastOtpCode(schoolId));
    expect(good.statusCode).toBe(200);
    const rows = await adminDb()
      .selectFrom("devices")
      .select(["secretHash", "revokedAt"])
      .where("guardianId", "=", seed.guardianId)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.secretHash).toBe(hashToken(DEVICE_A));
    expect(rows[0]!.revokedAt).toBeNull();
    expect((await exchange(token, DEVICE_A)).json().status).toBe("ok");
  });
});

