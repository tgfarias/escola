import { uuidv7 } from "uuidv7";
import { describe, expect, it } from "vitest";
import { getDb } from "../../db/index";
import { adminDb, createSchool, seedTenant } from "../../../test/helpers";
import { resolveMagicLink, resolveStaffEmail } from "./repo";

describe("tenant resolution", () => {
  it("resolves a magic link hash to its school", async () => {
    const schoolId = await createSchool();
    const seed = await seedTenant(schoolId);
    const id = uuidv7();
    const tokenHash = `hash-${id}`;
    await adminDb()
      .insertInto("magicLinks")
      .values({
        id,
        schoolId,
        guardianId: seed.guardianId,
        tokenHash,
        scope: "order",
        expiresAt: new Date(Date.now() + 60_000),
      })
      .execute();
    expect(await resolveMagicLink(tokenHash)).toEqual({ schoolId, magicLinkId: id });
  });

  it("returns undefined for an unknown hash", async () => {
    expect(await resolveMagicLink("nope")).toBeUndefined();
  });

  it("resolves an active staff e-mail case-insensitively", async () => {
    const schoolId = await createSchool();
    const seed = await seedTenant(schoolId);
    expect(await resolveStaffEmail(seed.email.toUpperCase())).toEqual({
      schoolId,
      staffUserId: seed.staffUserId,
    });
  });

  it("does not resolve inactive staff", async () => {
    const schoolId = await createSchool();
    const seed = await seedTenant(schoolId);
    await adminDb().updateTable("staffUsers").set({ active: false }).where("id", "=", seed.staffUserId).execute();
    expect(await resolveStaffEmail(seed.email)).toBeUndefined();
  });

  it("crosses the tenant boundary through the function, not through table access", async () => {
    const schoolId = await createSchool();
    const seed = await seedTenant(schoolId);
    const id = uuidv7();
    const tokenHash = `hash-${id}`;
    await adminDb()
      .insertInto("magicLinks")
      .values({
        id,
        schoolId,
        guardianId: seed.guardianId,
        tokenHash,
        scope: "order",
        expiresAt: new Date(Date.now() + 60_000),
      })
      .execute();
    // app_user, no tenant set: RLS hides every row (a row exists, as the admin sees).
    const visible = await getDb().selectFrom("magicLinks").select("id").where("tokenHash", "=", tokenHash).execute();
    expect(visible).toEqual([]);
    const asAdmin = await adminDb().selectFrom("magicLinks").select("id").where("tokenHash", "=", tokenHash).execute();
    expect(asAdmin).toHaveLength(1);
    // ...yet the SECURITY DEFINER function still resolves it.
    expect(await resolveMagicLink(tokenHash)).toEqual({ schoolId, magicLinkId: id });
  });
});
