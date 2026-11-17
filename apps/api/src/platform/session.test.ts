import { SignJWT } from "jose";
import { uuidv7 } from "uuidv7";
import { describe, expect, it } from "vitest";
import { adminDb, createSchool, seedTenant } from "../../test/helpers";
import { buildApp } from "../app";
import { SESSION_COOKIE, issueSession, signToken, type SessionClaims } from "./session";

const guardian: SessionClaims = { kind: "guardian", sub: uuidv7(), schoolId: uuidv7(), scope: "order" };
const staff: SessionClaims = { kind: "staff", sub: uuidv7(), schoolId: uuidv7(), role: "secretaria" };

function app() {
  const a = buildApp();
  a.get("/api/v1/g", { config: { auth: { kind: "guardian", scope: "order" } } }, async (req) => req.session);
  a.get("/api/admin/v1/s", { config: { auth: { kind: "staff", roles: ["admin"] } } }, async (req) => req.session);
  a.post("/api/v1/login", { config: { auth: "public" } }, async (_req, reply) => {
    await issueSession(reply, guardian, 7200);
    return { ok: true };
  });
  return a;
}

async function cookieFor(claims: SessionClaims, purpose: "session" | "otp" = "session", ttl = 60) {
  return { [SESSION_COOKIE]: await signToken(purpose, claims, ttl) };
}

describe("session guard", () => {
  it("rejects a request without cookie", async () => {
    const res = await app().inject({ method: "GET", url: "/api/v1/g" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthenticated");
  });

  it("exposes the claims to the handler", async () => {
    const res = await app().inject({ method: "GET", url: "/api/v1/g", cookies: await cookieFor(guardian) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject(guardian);
  });

  it("rejects an expired token", async () => {
    const res = await app().inject({
      method: "GET",
      url: "/api/v1/g",
      cookies: await cookieFor(guardian, "session", -10),
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a token issued for another purpose", async () => {
    const res = await app().inject({
      method: "GET",
      url: "/api/v1/g",
      cookies: await cookieFor(guardian, "otp"),
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a token signed with a different secret", async () => {
    const now = Math.floor(Date.now() / 1000);
    const forged = await new SignJWT({ ...guardian, purpose: "session" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .sign(new TextEncoder().encode("another-secret-that-is-at-least-32-chars-long"));
    const res = await app().inject({ method: "GET", url: "/api/v1/g", cookies: { [SESSION_COOKIE]: forged } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthenticated");
  });

  it("rejects a validly signed token without exp", async () => {
    const token = await new SignJWT({ ...guardian, purpose: "session" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .sign(new TextEncoder().encode(process.env.SESSION_SECRET!));
    const res = await app().inject({ method: "GET", url: "/api/v1/g", cookies: { [SESSION_COOKIE]: token } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthenticated");
  });

  it("rejects a validly signed token with an unknown kind", async () => {
    const token = await signToken("session", { kind: "kitchen", sub: uuidv7(), schoolId: uuidv7() }, 60);
    const res = await app().inject({ method: "GET", url: "/api/v1/g", cookies: { [SESSION_COOKIE]: token } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthenticated");
  });

  it("rejects the wrong kind", async () => {
    const res = await app().inject({ method: "GET", url: "/api/v1/g", cookies: await cookieFor(staff) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("insufficient_scope");
  });

  it("rejects the wrong guardian scope", async () => {
    const res = await app().inject({
      method: "GET",
      url: "/api/v1/g",
      cookies: await cookieFor({ ...guardian, scope: "documents" }),
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects a staff role outside the allowed list", async () => {
    // The role is re-read from the database, so the staff user must exist.
    const schoolId = await createSchool();
    const seed = await seedTenant(schoolId);
    await adminDb().updateTable("staffUsers").set({ role: "secretaria" }).where("id", "=", seed.staffUserId).execute();
    const claims: SessionClaims = { ...staff, sub: seed.staffUserId, schoolId };
    const res = await app().inject({ method: "GET", url: "/api/admin/v1/s", cookies: await cookieFor(claims) });
    expect(res.statusCode).toBe(403);
  });

  it("lets an allowed staff role through with the database role", async () => {
    const schoolId = await createSchool();
    const seed = await seedTenant(schoolId);
    const claims: SessionClaims = { ...staff, sub: seed.staffUserId, schoolId };
    const res = await app().inject({ method: "GET", url: "/api/admin/v1/s", cookies: await cookieFor(claims) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kind: "staff", sub: seed.staffUserId, role: "admin" });
  });

  it("sets the cookie with the required attributes", async () => {
    const res = await app().inject({ method: "POST", url: "/api/v1/login" });
    const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE)!;
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: 7200 });
  });
});
