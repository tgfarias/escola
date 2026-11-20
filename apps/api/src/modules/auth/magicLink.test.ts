import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { adminDb, createSchool, markDayClosed, seedServiceDay, seedTenant } from "../../../test/helpers";
import { withTenant } from "../../db/index";
import { createMagicLink } from "./magicLink";
import { hashToken } from "./tokens";

describe("createMagicLink", () => {
  it("returns a URL with the token in the fragment and stores only its hash", async () => {
    const schoolId = await createSchool();
    const seed = await seedTenant(schoolId);
    const day = await seedServiceDay(schoolId, { cutoffInMinutes: 60 });
    const link = await withTenant(schoolId, (trx) =>
      createMagicLink(trx, { schoolId, guardianId: seed.guardianId, scope: "order", serviceDate: day.serviceDate }),
    );
    expect(link.url.startsWith("https://app.test/l#")).toBe(true);
    const token = link.url.split("#")[1]!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = await adminDb().selectFrom("magicLinks").selectAll().where("tokenHash", "=", hashToken(token)).executeTakeFirstOrThrow();
    expect(row.guardianId).toBe(seed.guardianId);
    expect(row.scope).toBe("order");
    const all = await adminDb().selectFrom("magicLinks").select("tokenHash").where("schoolId", "=", schoolId).execute();
    expect(all.some((r) => r.tokenHash === token)).toBe(false);
  });

  it("expires an order link at the cutoff of its day", async () => {
    const schoolId = await createSchool();
    const seed = await seedTenant(schoolId);
    const day = await seedServiceDay(schoolId, { cutoffInMinutes: 90 });
    const link = await withTenant(schoolId, (trx) =>
      createMagicLink(trx, { schoolId, guardianId: seed.guardianId, scope: "order", serviceDate: day.serviceDate }),
    );
    const cutoff = await adminDb().selectFrom("serviceDays").select("cutoffAt").where("id", "=", day.serviceDayId).executeTakeFirstOrThrow();
    expect(link.expiresAt.getTime()).toBe(cutoff.cutoffAt.getTime());
  });

  it("expires a documents link seven days after now() of the database", async () => {
    const schoolId = await createSchool();
    const seed = await seedTenant(schoolId);
    const link = await withTenant(schoolId, (trx) =>
      createMagicLink(trx, { schoolId, guardianId: seed.guardianId, scope: "documents" }),
    );
    const { rows } = await sql<{ diff: number }>`
      SELECT extract(epoch FROM (${link.expiresAt}::timestamptz - (now() + interval '7 days')))::float8 AS diff`.execute(adminDb());
    expect(Math.abs(rows[0]!.diff)).toBeLessThan(60);
  });

  it("refuses an order link after the cutoff, for a closed day or for a missing day", async () => {
    const schoolId = await createSchool();
    const seed = await seedTenant(schoolId);
    const past = await seedServiceDay(schoolId, { serviceDate: "2031-03-03", cutoffInMinutes: -1 });
    const closed = await seedServiceDay(schoolId, { serviceDate: "2031-03-04", cutoffInMinutes: 60 });
    await markDayClosed(closed.serviceDayId);
    for (const serviceDate of [past.serviceDate, closed.serviceDate, "2031-03-05"]) {
      await expect(
        withTenant(schoolId, (trx) => createMagicLink(trx, { schoolId, guardianId: seed.guardianId, scope: "order", serviceDate })),
      ).rejects.toMatchObject({ code: "cutoff_passed" });
    }
  });

  it("generates a different token each time", async () => {
    const schoolId = await createSchool();
    const seed = await seedTenant(schoolId);
    const day = await seedServiceDay(schoolId, { cutoffInMinutes: 60 });
    const input = { schoolId, guardianId: seed.guardianId, scope: "order" as const, serviceDate: day.serviceDate };
    const [a, b] = await withTenant(schoolId, async (trx) => [await createMagicLink(trx, input), await createMagicLink(trx, input)]);
    expect(a.url).not.toBe(b.url);
  });
});
