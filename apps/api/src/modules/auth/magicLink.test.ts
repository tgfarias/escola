import { describe, expect, it } from "vitest";
import { adminDb, createSchool, seedTenant } from "../../../test/helpers";
import { withTenant } from "../../db/index";
import { createMagicLink } from "./magicLink";
import { hashToken } from "./tokens";

describe("createMagicLink", () => {
  it("returns a URL with the token in the fragment and stores only its hash", async () => {
    const schoolId = await createSchool();
    const seed = await seedTenant(schoolId);
    const expiresAt = new Date(Date.now() + 3_600_000);
    const link = await withTenant(schoolId, (trx) =>
      createMagicLink(trx, { schoolId, guardianId: seed.guardianId, scope: "order", serviceDate: "2026-11-17", expiresAt }),
    );
    expect(link.url.startsWith("https://app.test/l#")).toBe(true);
    const token = link.url.split("#")[1]!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = await adminDb()
      .selectFrom("magicLinks")
      .selectAll()
      .where("tokenHash", "=", hashToken(token))
      .executeTakeFirstOrThrow();
    expect(row.guardianId).toBe(seed.guardianId);
    expect(row.scope).toBe("order");
    const all = await adminDb().selectFrom("magicLinks").select("tokenHash").where("schoolId", "=", schoolId).execute();
    expect(all.some((r) => r.tokenHash === token)).toBe(false);
  });

  it("generates a different token each time", async () => {
    const schoolId = await createSchool();
    const seed = await seedTenant(schoolId);
    const input = { schoolId, guardianId: seed.guardianId, scope: "documents" as const, expiresAt: new Date(Date.now() + 1000) };
    const [a, b] = await withTenant(schoolId, async (trx) => [
      await createMagicLink(trx, input),
      await createMagicLink(trx, input),
    ]);
    expect(a!.url).not.toBe(b!.url);
  });
});
