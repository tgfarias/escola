import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { describe, expect, it } from "vitest";
import { getDb } from "../../db/index";
import { adminDb, createSchool, seedTenant } from "../../../test/helpers";
import { resolveMagicLink, resolveStaffEmail } from "./repo";

describe("tenant resolution", () => {
  it("pins the search_path of the resolve functions", async () => {
    const { rows } = await sql<{ proname: string; proconfig: string[] }>`
      SELECT proname, proconfig FROM pg_proc
      WHERE proname IN ('resolve_magic_link', 'resolve_staff_email') ORDER BY proname`.execute(adminDb());
    expect(rows).toEqual([
      { proname: "resolve_magic_link", proconfig: ["search_path=pg_catalog, public, pg_temp"] },
      { proname: "resolve_staff_email", proconfig: ["search_path=pg_catalog, public, pg_temp"] },
    ]);
  });

  it("indexes recent challenges by subject", async () => {
    const { rows } = await sql<{ indexdef: string }>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'otp_challenges_subject_recent'`.execute(adminDb());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexdef).toContain("(school_id, subject_kind, subject_id, created_at)");
  });

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
