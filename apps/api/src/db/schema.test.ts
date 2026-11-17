import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { beforeAll, describe, expect, it } from "vitest";
import { adminDb, createSchool, seedTenant, type SeedIds } from "../../test/helpers";
import { withTenant } from "./index";

describe("F2 schema", () => {
  let schoolId: string;
  let ids: SeedIds;

  beforeAll(async () => {
    schoolId = await createSchool();
    ids = await seedTenant(schoolId);
  });

  it.each(["wallet_entries", "manifests", "payment_events", "order_items"])(
    "%s is append-only for the application role",
    async (table) => {
      await expect(
        withTenant(schoolId, (trx) => sql`UPDATE ${sql.table(table)} SET school_id = school_id`.execute(trx)),
      ).rejects.toThrow(/permission denied/);
      await expect(withTenant(schoolId, (trx) => sql`DELETE FROM ${sql.table(table)}`.execute(trx))).rejects.toThrow(
        /permission denied/,
      );
    },
  );

  it("allows one active order per student and date", async () => {
    const insertOrder = (status: string) =>
      withTenant(schoolId, (trx) =>
        trx
          .insertInto("orders")
          .values({
            id: uuidv7(),
            schoolId,
            checkoutId: ids.checkoutId,
            studentId: ids.studentId,
            serviceDate: "2099-06-01",
            status,
          })
          .execute(),
      );
    await insertOrder("pending");
    await expect(insertOrder("confirmed")).rejects.toThrow(/orders_one_active_per_student/);
    await insertOrder("expired");
    await insertOrder("cancelled");
  });

  it("rejects a negative wallet balance", async () => {
    await expect(
      withTenant(schoolId, (trx) =>
        trx.updateTable("wallets").set({ balanceCents: -1 }).where("id", "=", ids.walletId).execute(),
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it("enforces the sign of each wallet entry kind", async () => {
    const entry = (kind: string, amountCents: number) =>
      withTenant(schoolId, (trx) =>
        trx
          .insertInto("walletEntries")
          .values({ id: uuidv7(), schoolId, walletId: ids.walletId, kind, amountCents, sourceType: "checkout", sourceId: uuidv7() })
          .execute(),
      );
    await expect(entry("checkout_hold", 100)).rejects.toThrow(/check constraint/);
    await expect(entry("cancel_credit", -100)).rejects.toThrow(/check constraint/);
    await expect(entry("manual_adjustment", 0)).rejects.toThrow(/check constraint/);
  });

  it("reads int8 as number and date as YYYY-MM-DD text", async () => {
    const row = await withTenant(schoolId, (trx) =>
      trx
        .selectFrom("serviceDays")
        .innerJoin("serviceDayItems", "serviceDayItems.serviceDayId", "serviceDays.id")
        .select(["serviceDays.serviceDate", "serviceDayItems.priceCents"])
        .where("serviceDays.id", "=", ids.serviceDayId)
        .executeTakeFirstOrThrow(),
    );
    expect(row).toEqual({ serviceDate: "2099-12-31", priceCents: 900 });
    const { rows } = await sql<{ n: unknown }>`SELECT count(*) AS n FROM schools`.execute(adminDb());
    expect(typeof rows[0]!.n).toBe("number");
  });
});
