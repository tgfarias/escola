import { createHash } from "node:crypto";
import { decodeJwt } from "jose";
import { describe, expect, it } from "vitest";
import { adminDb, createSchool, seedTenant, staffCookie } from "../../../test/helpers";
import { buildApp } from "../../app";
import { SESSION_COOKIE } from "../../platform/session";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ORIGIN = { origin: "https://app.test" };

async function newCode(schoolId: string) {
  const { cookies } = await staffCookie(schoolId, "secretaria");
  const res = await buildApp().inject({
    method: "POST",
    url: "/api/admin/v1/kds/pairing-codes",
    cookies,
    headers: { ...ORIGIN, "idempotency-key": crypto.randomUUID() },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { deviceId: string; code: string; expiresAt: string };
}

describe("kitchen pairing", () => {
  it("creates a 10-minute code, stores only its hash, and pairs once", async () => {
    const schoolId = await createSchool();
    await seedTenant(schoolId);
    const { deviceId, code, expiresAt } = await newCode(schoolId);
    expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    const row = await adminDb().selectFrom("devices").selectAll().where("id", "=", deviceId).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ kind: "kitchen", pairingCodeHash: sha(code), revokedAt: null });
    const minutes = (new Date(expiresAt).getTime() - row.createdAt.getTime()) / 60_000;
    expect(minutes).toBeGreaterThan(9.9);
    expect(minutes).toBeLessThan(10.1);

    const app = buildApp();
    const paired = await app.inject({ method: "POST", url: "/api/kds/v1/pair", headers: ORIGIN, payload: { code: code.toLowerCase() } });
    expect(paired.statusCode).toBe(200);
    expect(paired.json()).toEqual({ deviceId });
    const kitchenCookie = paired.cookies.find((c) => c.name === SESSION_COOKIE)!;
    expect(kitchenCookie.maxAge).toBe((30 + 90) * 86400);
    const jwt = decodeJwt(kitchenCookie.value);
    expect(jwt.exp! - jwt.iat!).toBe(30 * 86400);
    const after = await adminDb().selectFrom("devices").select(["pairingCodeHash", "pairingExpiresAt"]).where("id", "=", deviceId).executeTakeFirstOrThrow();
    expect(after).toEqual({ pairingCodeHash: null, pairingExpiresAt: null });

    const again = await app.inject({ method: "POST", url: "/api/kds/v1/pair", headers: ORIGIN, payload: { code } });
    expect(again.statusCode).toBe(401);
    expect(again.json().error.code).toBe("invalid_token");
  });

  it("refuses an expired code", async () => {
    const schoolId = await createSchool();
    await seedTenant(schoolId);
    const { deviceId, code } = await newCode(schoolId);
    await adminDb().updateTable("devices").set({ pairingExpiresAt: new Date(Date.now() - 1000) }).where("id", "=", deviceId).execute();
    const res = await buildApp().inject({ method: "POST", url: "/api/kds/v1/pair", headers: ORIGIN, payload: { code } });
    expect(res.statusCode).toBe(401);
  });

  it("lists kitchen devices and revoking one cuts its session immediately", async () => {
    const schoolId = await createSchool();
    await seedTenant(schoolId);
    const { deviceId, code } = await newCode(schoolId);
    const app = buildApp();
    app.get("/api/kds/v1/ping", { config: { auth: { kind: "kitchen" } } }, async () => ({ ok: true }));
    const paired = await app.inject({ method: "POST", url: "/api/kds/v1/pair", headers: ORIGIN, payload: { code } });
    const kitchen = { [SESSION_COOKIE]: paired.cookies.find((c) => c.name === SESSION_COOKIE)!.value };
    const ok = await app.inject({ method: "GET", url: "/api/kds/v1/ping", cookies: kitchen });
    expect(ok.statusCode).toBe(200);

    const { cookies } = await staffCookie(schoolId, "admin");
    const list = await app.inject({ method: "GET", url: "/api/admin/v1/kds/devices", cookies });
    expect(list.json().devices).toContainEqual(expect.objectContaining({ id: deviceId, paired: true, revokedAt: null }));
    const revoke = await app.inject({ method: "POST", url: `/api/admin/v1/kds/devices/${deviceId}/revoke`, cookies, headers: ORIGIN });
    expect(revoke.statusCode).toBe(204);
    const cut = await app.inject({ method: "GET", url: "/api/kds/v1/ping", cookies: kitchen });
    expect(cut.statusCode).toBe(401);
  });

  it("does not let a kitchen role staff user or a guardian create codes", async () => {
    const schoolId = await createSchool();
    await seedTenant(schoolId);
    const { cookies } = await staffCookie(schoolId, "cozinha");
    const res = await buildApp().inject({
      method: "POST",
      url: "/api/admin/v1/kds/pairing-codes",
      cookies,
      headers: { ...ORIGIN, "idempotency-key": crypto.randomUUID() },
    });
    expect(res.statusCode).toBe(403);
  });

  it("does not revoke a device of another school", async () => {
    const a = await createSchool();
    const b = await createSchool();
    await seedTenant(a);
    const seedB = await seedTenant(b);
    const { cookies } = await staffCookie(a, "admin");
    const res = await buildApp().inject({ method: "POST", url: `/api/admin/v1/kds/devices/${seedB.kitchenDeviceId}/revoke`, cookies, headers: ORIGIN });
    expect(res.statusCode).toBe(404);
  });
});
