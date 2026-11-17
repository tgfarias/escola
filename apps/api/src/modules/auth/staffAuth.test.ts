import { uuidv7 } from "uuidv7";
import { describe, expect, it } from "vitest";
import { adminDb, createSchool, seedTenant } from "../../../test/helpers";
import { buildApp } from "../../app";
import { SESSION_COOKIE, signToken } from "../../platform/session";
import { withTenant } from "../../db/index";
import { decodeProtectedHeader } from "jose";
import { signOtpToken, signOtpTokenAt } from "./otp";
import * as repo from "./repo";
import { requestStaffOtp } from "./service";

function post(url: string, payload: unknown) {
  return buildApp().inject({ method: "POST", url, payload: payload as object });
}

/** Decodes every part of a compact token that is valid base64url and returns the decoded text. */
function decodedParts(token: string): string[] {
  return token
    .split(".")
    .filter((part) => /^[A-Za-z0-9_-]*$/.test(part))
    .map((part) => Buffer.from(part, "base64url").toString("latin1"));
}

function expectOpaque(token: string, schoolId: string) {
  for (const text of decodedParts(token)) {
    expect(text).not.toContain(schoolId);
    expect(text).not.toContain("subjectKind");
    expect(text).not.toContain("staff");
    expect(text).not.toContain("none");
  }
}

async function otpEvents(schoolId: string) {
  return adminDb()
    .selectFrom("outboxEvents")
    .select("data")
    .where("schoolId", "=", schoolId)
    .where("type", "=", "auth.otp_requested")
    .orderBy("occurredAt", "asc")
    .execute();
}

describe("staff authentication", () => {
  it("logs in with e-mail and code", async () => {
    const schoolId = await createSchool("Escola Sol");
    const seed = await seedTenant(schoolId);

    const requested = await post("/api/admin/v1/auth/otp/request", { email: seed.email });
    expect(requested.statusCode).toBe(200);
    const { otpToken } = requested.json();
    const [event] = await otpEvents(schoolId);
    const data = event!.data as { code: string; channel: string; to: string };
    expect(data.channel).toBe("email");
    expect(data.to).toBe(seed.email);

    const verified = await post("/api/admin/v1/auth/otp/verify", { otpToken, code: data.code });
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toEqual({ status: "ok", role: "admin" });
    const cookie = verified.cookies.find((c) => c.name === SESSION_COOKIE)!;
    expect(cookie.maxAge).toBe(28_800);

    const me = await buildApp().inject({
      method: "GET",
      url: "/api/admin/v1/me",
      cookies: { [SESSION_COOKIE]: cookie.value },
    });
    expect(me.json()).toEqual({ id: seed.staffUserId, email: seed.email, role: "admin", schoolName: "Escola Sol" });
  });

  it("answers the same way for an unknown e-mail and sends nothing", async () => {
    const schoolId = await createSchool();
    const seed = await seedTenant(schoolId);
    const requested = await post("/api/admin/v1/auth/otp/request", { email: `nobody-${uuidv7()}@x.test` });
    expect(requested.statusCode).toBe(200);
    expect(typeof requested.json().otpToken).toBe("string");
    expect(await otpEvents(schoolId)).toEqual([]);

    const known = await post("/api/admin/v1/auth/otp/request", { email: seed.email });
    expect(known.statusCode).toBe(requested.statusCode);
    expect(Object.keys(known.json()).sort()).toEqual(Object.keys(requested.json()).sort());
    expect(Object.keys(known.json())).toEqual(["otpToken"]);

    const verified = await post("/api/admin/v1/auth/otp/verify", { otpToken: requested.json().otpToken, code: "123456" });
    expect(verified.statusCode).toBe(401);
    expect(verified.json().error.code).toBe("otp_invalid");
  });

  it("rejects a wrong code", async () => {
    const schoolId = await createSchool();
    const seed = await seedTenant(schoolId);
    const { otpToken } = (await post("/api/admin/v1/auth/otp/request", { email: seed.email })).json();
    const [event] = await otpEvents(schoolId);
    const code = (event!.data as { code: string }).code;
    const verified = await post("/api/admin/v1/auth/otp/verify", {
      otpToken,
      code: code === "000000" ? "000001" : "000000",
    });
    expect(verified.statusCode).toBe(401);
    expect(verified.json().error.code).toBe("otp_invalid");
  });

  it("does not accept a guardian session on staff routes", async () => {
    const token = await signToken(
      "session",
      { kind: "guardian", sub: uuidv7(), schoolId: uuidv7(), scope: "order" },
      60,
    );
    const res = await buildApp().inject({
      method: "GET",
      url: "/api/admin/v1/me",
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(res.statusCode).toBe(403);
  });

  it("answers the fourth request in the window like any other but sends nothing", async () => {
    const schoolId = await createSchool();
    const seed = await seedTenant(schoolId);
    const realTokens: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await post("/api/admin/v1/auth/otp/request", { email: seed.email });
      expect(res.statusCode).toBe(200);
      realTokens.push(res.json().otpToken);
    }
    expect(await otpEvents(schoolId)).toHaveLength(3);

    const fourth = await post("/api/admin/v1/auth/otp/request", { email: seed.email });
    expect(fourth.statusCode).toBe(200);
    expect(Object.keys(fourth.json())).toEqual(["otpToken"]);
    expect(typeof fourth.json().otpToken).toBe("string");
    expect(await otpEvents(schoolId)).toHaveLength(3);
    expect(fourth.json().otpToken.length).toBe(realTokens[0]!.length);
    expectOpaque(fourth.json().otpToken, schoolId);

    const verified = await post("/api/admin/v1/auth/otp/verify", { otpToken: fourth.json().otpToken, code: "123456" });
    expect(verified.statusCode).toBe(401);
    expect(verified.json().error.code).toBe("otp_invalid");
  });

  it("does not log in a staff user deactivated after requesting the code", async () => {
    const schoolId = await createSchool();
    const seed = await seedTenant(schoolId);
    const { otpToken } = (await post("/api/admin/v1/auth/otp/request", { email: seed.email })).json();
    const [event] = await otpEvents(schoolId);
    const code = (event!.data as { code: string }).code;
    await adminDb().updateTable("staffUsers").set({ active: false }).where("id", "=", seed.staffUserId).execute();

    const verified = await post("/api/admin/v1/auth/otp/verify", { otpToken, code });
    expect(verified.statusCode).toBe(401);
    expect(verified.json().error.code).toBe("otp_invalid");
    expect(verified.cookies.find((c) => c.name === SESSION_COOKIE)).toBeUndefined();
  });

  it("rejects a guardian OTP token on the staff verify route", async () => {
    const otpToken = await signOtpToken({
      subjectKind: "guardian",
      schoolId: uuidv7(),
      challengeId: uuidv7(),
      subjectId: uuidv7(),
      deviceHash: "a".repeat(64),
      scope: "order",
      inert: false,
    });
    const verified = await post("/api/admin/v1/auth/otp/verify", { otpToken, code: "123456" });
    expect(verified.statusCode).toBe(401);
    expect(verified.json().error.code).toBe("otp_invalid");
  });

  it("lockStaffUser returns nothing for an inactive or nonexistent user", async () => {
    const schoolId = await createSchool();
    const seed = await seedTenant(schoolId);
    expect(await withTenant(schoolId, (trx) => repo.lockStaffUser(trx, seed.staffUserId))).toMatchObject({
      email: seed.email,
    });
    await adminDb().updateTable("staffUsers").set({ active: false }).where("id", "=", seed.staffUserId).execute();
    expect(await withTenant(schoolId, (trx) => repo.lockStaffUser(trx, seed.staffUserId))).toBeUndefined();
    expect(await withTenant(schoolId, (trx) => repo.lockStaffUser(trx, uuidv7()))).toBeUndefined();
  });

  it("answers an inert token and sends nothing for a deactivated user", async () => {
    const schoolId = await createSchool();
    const seed = await seedTenant(schoolId);
    await adminDb().updateTable("staffUsers").set({ active: false }).where("id", "=", seed.staffUserId).execute();
    const res = await post("/api/admin/v1/auth/otp/request", { email: seed.email });
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().otpToken).toBe("string");
    expect(await otpEvents(schoolId)).toEqual([]);
    expect(typeof (await requestStaffOtp(seed.email)).otpToken).toBe("string");
  });

  it("sends the code to the stored e-mail when the request is mixed case", async () => {
    const schoolId = await createSchool();
    const seed = await seedTenant(schoolId);
    const { otpToken } = (
      await post("/api/admin/v1/auth/otp/request", { email: seed.email.toUpperCase() })
    ).json();
    const [event] = await otpEvents(schoolId);
    const data = event!.data as { code: string; to: string };
    expect(data.to).toBe(seed.email);
    const verified = await post("/api/admin/v1/auth/otp/verify", { otpToken, code: data.code });
    expect(verified.statusCode).toBe(200);
  });

  it("rejects an existing session once the staff user is deactivated", async () => {
    const schoolId = await createSchool();
    const seed = await seedTenant(schoolId);
    const { otpToken } = (await post("/api/admin/v1/auth/otp/request", { email: seed.email })).json();
    const [event] = await otpEvents(schoolId);
    const verified = await post("/api/admin/v1/auth/otp/verify", {
      otpToken,
      code: (event!.data as { code: string }).code,
    });
    const cookie = verified.cookies.find((c) => c.name === SESSION_COOKIE)!;
    await adminDb().updateTable("staffUsers").set({ active: false }).where("id", "=", seed.staffUserId).execute();
    const me = await buildApp().inject({
      method: "GET",
      url: "/api/admin/v1/me",
      cookies: { [SESSION_COOKIE]: cookie.value },
    });
    expect(me.statusCode).toBe(401);
    expect(me.json().error.code).toBe("unauthenticated");
  });

  it("returns opaque tokens of the same form for known and unknown e-mails", async () => {
    const schoolId = await createSchool();
    const seed = await seedTenant(schoolId);
    const known = (await post("/api/admin/v1/auth/otp/request", { email: seed.email })).json().otpToken as string;
    const unknown = (await post("/api/admin/v1/auth/otp/request", { email: `nobody-${uuidv7()}@x.test` })).json()
      .otpToken as string;
    expect(known.split(".")).toHaveLength(5);
    expect(unknown.split(".")).toHaveLength(5);
    expect(JSON.stringify(decodeProtectedHeader(known))).toBe(JSON.stringify(decodeProtectedHeader(unknown)));
    expect(Object.keys(decodeProtectedHeader(known)).sort()).toEqual(["alg", "enc"]);
    expect(known.length).toBe(unknown.length);
    expectOpaque(known, schoolId);
    expectOpaque(unknown, schoolId);
    expect(known).not.toContain(Buffer.from(schoolId).toString("base64url"));
  });

  it("answers otp_invalid for a fresh inert token without touching the database", async () => {
    const otpToken = await signOtpToken({
      subjectKind: "staff",
      schoolId: uuidv7(),
      challengeId: uuidv7(),
      subjectId: uuidv7(),
      inert: true,
    });
    const verified = await post("/api/admin/v1/auth/otp/verify", { otpToken, code: "123456" });
    expect(verified.statusCode).toBe(401);
    expect(verified.json().error.code).toBe("otp_invalid");
  });

  it("answers otp_expired for an inert token issued more than five minutes ago", async () => {
    const otpToken = await signOtpTokenAt(
      { subjectKind: "staff", schoolId: uuidv7(), challengeId: uuidv7(), subjectId: uuidv7(), inert: true },
      Math.floor(Date.now() / 1000) - 6 * 60,
    );
    const verified = await post("/api/admin/v1/auth/otp/verify", { otpToken, code: "123456" });
    expect(verified.statusCode).toBe(401);
    expect(verified.json().error.code).toBe("otp_expired");
  });

  it("logs a throttled request once, with the staff id and without the e-mail", async () => {
    const schoolId = await createSchool();
    const seed = await seedTenant(schoolId);
    const lines: string[] = [];
    const app = buildApp({ logger: { level: "warn", stream: { write: (line: string) => lines.push(line) } } });
    for (let i = 0; i < 3; i++) {
      await app.inject({ method: "POST", url: "/api/admin/v1/auth/otp/request", payload: { email: seed.email } });
    }
    expect(lines).toEqual([]);
    const fourth = await app.inject({
      method: "POST",
      url: "/api/admin/v1/auth/otp/request",
      payload: { email: seed.email },
    });
    expect(fourth.statusCode).toBe(200);
    expect(Object.keys(fourth.json())).toEqual(["otpToken"]);
    const throttled = lines.map((l) => JSON.parse(l)).filter((l) => l.event === "otp_issuance_throttled");
    expect(throttled).toHaveLength(1);
    expect(throttled[0]).toMatchObject({ level: 40, subject_kind: "staff", subject_id: seed.staffUserId });
    expect(lines.join("\n")).not.toContain(seed.email);
    expect(lines.join("\n")).not.toContain(fourth.json().otpToken);
  });
});
