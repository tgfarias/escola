import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { beforeAll, describe, expect, it } from "vitest";
import { adminDb, createSchool, seedServiceDay, seedTenant, type SeedIds } from "../../test/helpers";
import { getDb, withTenant } from "./index";

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

describe("F3 schema", () => {
  it("pins the search_path of the F3 security definer functions and keeps them away from PUBLIC", async () => {
    const { rows } = await sql<{ proname: string; proconfig: string[]; prosecdef: boolean; publicExec: boolean }>`
      SELECT proname, proconfig, prosecdef,
             has_function_privilege('public', oid, 'EXECUTE') AS public_exec
      FROM pg_proc
      WHERE proname IN ('list_due_actions', 'list_schools_with_pending_events') ORDER BY proname`.execute(adminDb());
    expect(rows).toEqual([
      { proname: "list_due_actions", proconfig: ["search_path=pg_catalog, public, pg_temp"], prosecdef: true, publicExec: false },
      { proname: "list_schools_with_pending_events", proconfig: ["search_path=pg_catalog, public, pg_temp"], prosecdef: true, publicExec: false },
    ]);
  });

  it("lets the application role update but never delete reminder rows", async () => {
    const { rows } = await sql<{ table: string; update: boolean; del: boolean }>`
      SELECT t AS table,
             has_table_privilege('app_user', t, 'UPDATE') AS update,
             has_table_privilege('app_user', t, 'DELETE') AS del
      FROM unnest(ARRAY['reminder_batches', 'message_deliveries']) AS t ORDER BY t`.execute(adminDb());
    expect(rows).toEqual([
      { table: "message_deliveries", update: true, del: false },
      { table: "reminder_batches", update: true, del: false },
    ]);
  });

  it("restricts a delivery error to a short code", async () => {
    const schoolId = await createSchool();
    const seed = await seedTenant(schoolId);
    await expect(
      adminDb()
        .insertInto("messageDeliveries")
        .values({ id: uuidv7(), schoolId, batchId: seed.reminderBatchId, guardianId: seed.guardianId, status: "failed", error: "Número +55 11 inválido" })
        .execute(),
    ).rejects.toThrow(/check/i);
  });

  it("lists due reminders and closes by the database clock", async () => {
    const schoolId = await createSchool();
    await adminDb().updateTable("schools").set({ reminderLeadMinutes: 120 }).where("id", "=", schoolId).execute();
    await seedServiceDay(schoolId, { serviceDate: "2031-01-06", cutoffInMinutes: 60 }); // reminder window open
    await seedServiceDay(schoolId, { serviceDate: "2031-01-07", cutoffInMinutes: 600 }); // too early to remind
    await seedServiceDay(schoolId, { serviceDate: "2031-01-08", cutoffInMinutes: -7 }); // freeze passed, not overdue
    await seedServiceDay(schoolId, { serviceDate: "2031-01-09", cutoffInMinutes: -11 }); // overdue
    const { rows } = await sql<{ action: string; serviceDate: string; overdue: boolean }>`
      SELECT action, service_date, overdue FROM list_due_actions() WHERE school_id = ${schoolId}
      ORDER BY service_date, action`.execute(getDb());
    expect(rows).toEqual([
      { action: "send_reminders", serviceDate: "2031-01-06", overdue: false },
      { action: "close_service_day", serviceDate: "2031-01-08", overdue: false },
      { action: "close_service_day", serviceDate: "2031-01-09", overdue: true },
    ]);
  });

  it("drops reminders from the agenda once the batch is completed", async () => {
    const schoolId = await createSchool();
    await seedServiceDay(schoolId, { serviceDate: "2031-02-03", cutoffInMinutes: 60 });
    await adminDb()
      .insertInto("reminderBatches")
      .values({ id: uuidv7(), schoolId, serviceDate: "2031-02-03", completedAt: new Date() })
      .execute();
    const { rows } = await sql`SELECT 1 FROM list_due_actions() WHERE school_id = ${schoolId}`.execute(getDb());
    expect(rows).toHaveLength(0);
  });

  it("lists only schools with events ready to send", async () => {
    const ready = await createSchool();
    const later = await createSchool();
    const done = await createSchool();
    const insert = (schoolId: string, extra: Record<string, unknown>) =>
      adminDb().insertInto("outboxEvents").values({ id: uuidv7(), schoolId, type: "t", data: "{}", ...extra }).execute();
    await insert(ready, {});
    await insert(later, { nextAttemptAt: sql`now() + interval '1 hour'` });
    await insert(done, { deliveredAt: new Date() });
    await insert(done, { failedAt: new Date() });
    const { rows } = await sql<{ schoolId: string }>`SELECT school_id FROM list_schools_with_pending_events()`.execute(getDb());
    const ids = rows.map((r) => r.schoolId);
    expect(ids).toContain(ready);
    expect(ids).not.toContain(later);
    expect(ids).not.toContain(done);
  });
});
