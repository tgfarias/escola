import { describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { adminDb, createSchool, internalRequest, seedServiceDay, seedTenant } from "../../../test/helpers";
import { buildApp } from "../../app";
import { hashToken } from "../auth/tokens";

describe("POST /internal/v1/schools/:school_id/magic-links", () => {
  it("issues an order link that expires at the cutoff", async () => {
    const schoolId = await createSchool();
    const seed = await seedTenant(schoolId);
    const day = await seedServiceDay(schoolId, { cutoffInMinutes: 60 });
    const res = await buildApp().inject(
      internalRequest("POST", `/internal/v1/schools/${schoolId}/magic-links`, {
        guardian_id: seed.guardianId,
        scope: "order",
        service_date: day.serviceDate,
      }),
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const token = body.link_url.split("#")[1];
    const row = await adminDb().selectFrom("magicLinks").select(["schoolId", "expiresAt"]).where("tokenHash", "=", hashToken(token)).executeTakeFirstOrThrow();
    expect(row.schoolId).toBe(schoolId);
    expect(new Date(body.expires_at).getTime()).toBe(row.expiresAt.getTime());
  });

  it("does not issue a link for a guardian of another school", async () => {
    const schoolA = await createSchool();
    const schoolB = await createSchool();
    const seedB = await seedTenant(schoolB);
    const res = await buildApp().inject(
      internalRequest("POST", `/internal/v1/schools/${schoolA}/magic-links`, { guardian_id: seedB.guardianId, scope: "documents" }),
    );
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("answers 409 cutoff_passed when the day is past its cutoff", async () => {
    const schoolId = await createSchool();
    const seed = await seedTenant(schoolId);
    const day = await seedServiceDay(schoolId, { cutoffInMinutes: -1 });
    const res = await buildApp().inject(
      internalRequest("POST", `/internal/v1/schools/${schoolId}/magic-links`, {
        guardian_id: seed.guardianId,
        scope: "order",
        service_date: day.serviceDate,
      }),
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("cutoff_passed");
  });

  it("rejects a school_id in the body and an unsigned request", async () => {
    const schoolId = await createSchool();
    const seed = await seedTenant(schoolId);
    const app = buildApp();
    const withSchool = await app.inject(
      internalRequest("POST", `/internal/v1/schools/${schoolId}/magic-links`, { school_id: uuidv7(), guardian_id: seed.guardianId, scope: "documents" }),
    );
    expect(withSchool.statusCode).toBe(400);
    const unsigned = await app.inject({
      method: "POST",
      url: `/internal/v1/schools/${schoolId}/magic-links`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ guardian_id: seed.guardianId, scope: "documents" }),
    });
    expect(unsigned.statusCode).toBe(401);
  });
});
