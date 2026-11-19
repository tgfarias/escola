import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { beforeAll, describe, expect, it } from "vitest";
import { adminDb, createSchool, seedFamily, seedServiceDay, seedTenant, type SeedIds } from "../../test/helpers";
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

describe("F4 schema", () => {
  it("pins resolve_pairing_code and keeps it away from PUBLIC", async () => {
    const { rows } = await sql<{ proconfig: string[]; prosecdef: boolean; publicExec: boolean }>`
      SELECT proconfig, prosecdef, has_function_privilege('public', oid, 'EXECUTE') AS public_exec
      FROM pg_proc WHERE proname = 'resolve_pairing_code'`.execute(adminDb());
    expect(rows).toEqual([{ proconfig: ["search_path=pg_catalog, public, pg_temp"], prosecdef: true, publicExec: false }]);
  });

  it("makes delivery events append-only for the application", async () => {
    const { rows } = await sql<{ update: boolean; del: boolean; ins: boolean }>`
      SELECT has_table_privilege('app_user', 'delivery_events', 'UPDATE') AS update,
             has_table_privilege('app_user', 'delivery_events', 'DELETE') AS del,
             has_table_privilege('app_user', 'delivery_events', 'INSERT') AS ins`.execute(adminDb());
    expect(rows[0]).toEqual({ update: false, del: false, ins: true });
  });

  it("keeps a pairing code unique while it is set", async () => {
    const schoolId = await createSchool();
    const insert = () =>
      adminDb()
        .insertInto("devices")
        .values({ id: uuidv7(), schoolId, kind: "kitchen", pairingCodeHash: "same-hash", pairingExpiresAt: new Date(Date.now() + 60_000) })
        .execute();
    await insert();
    await expect(insert()).rejects.toThrow(/devices_pairing_code/);
  });

  it("resolves a pairing code hash to its school and device, only while unexpired", async () => {
    const schoolId = await createSchool();
    const live = uuidv7();
    const dead = uuidv7();
    await adminDb()
      .insertInto("devices")
      .values([
        { id: live, schoolId, kind: "kitchen", pairingCodeHash: `live-${live}`, pairingExpiresAt: sql`now() + interval '5 minutes'` },
        { id: dead, schoolId, kind: "kitchen", pairingCodeHash: `dead-${dead}`, pairingExpiresAt: sql`now() - interval '1 second'` },
      ])
      .execute();
    const resolve = async (hash: string) =>
      (await sql<{ schoolId: string; deviceId: string }>`SELECT school_id, device_id FROM resolve_pairing_code(${hash})`.execute(getDb())).rows;
    expect(await resolve(`live-${live}`)).toEqual([{ schoolId, deviceId: live }]);
    expect(await resolve(`dead-${dead}`)).toEqual([]);
  });

  it("refuses a delivery event for an order of another school", async () => {
    const a = await createSchool();
    const b = await createSchool();
    const seedA = await seedTenant(a);
    const seedB = await seedTenant(b);
    await expect(
      adminDb()
        .insertInto("deliveryEvents")
        .values({ eventId: uuidv7(), schoolId: a, orderId: seedB.orderId, deviceId: seedA.kitchenDeviceId, type: "delivered", occurredAt: new Date() })
        .execute(),
    ).rejects.toThrow(/foreign key/i);
  });
});

describe("F5 schema", () => {
  it.each(["document_templates", "document_batches", "documents", "document_views"])(
    "%s cannot be deleted by the application",
    async (table) => {
      const { rows } = await sql<{ del: boolean }>`SELECT has_table_privilege('app_user', ${table}, 'DELETE') AS del`.execute(adminDb());
      expect(rows[0]).toEqual({ del: false });
    },
  );

  it("makes document views append-only", async () => {
    const { rows } = await sql<{ upd: boolean; ins: boolean }>`
      SELECT has_table_privilege('app_user', 'document_views', 'UPDATE') AS upd,
             has_table_privilege('app_user', 'document_views', 'INSERT') AS ins`.execute(adminDb());
    expect(rows[0]).toEqual({ upd: false, ins: true });
  });

  it("accepts only 11-digit CPFs", async () => {
    const schoolId = await createSchool();
    const ids = await seedTenant(schoolId);
    const setCpf = (cpf: string) => adminDb().updateTable("guardians").set({ cpf }).where("id", "=", ids.guardianId).execute();
    await setCpf("52998224725");
    await expect(setCpf("529.982.247-25")).rejects.toThrow(/check constraint/);
    await expect(setCpf("123")).rejects.toThrow(/check constraint/);
  });

  it("keeps template versions unique per group", async () => {
    const schoolId = await createSchool();
    const ids = await seedTenant(schoolId);
    const insert = () =>
      adminDb()
        .insertInto("documentTemplates")
        .values({ id: uuidv7(), schoolId, templateGroupId: ids.documentTemplateId, version: 1, name: "X", category: "outro", bodyMd: "x", fields: JSON.stringify([]), createdBy: ids.staffUserId })
        .execute();
    await expect(insert()).rejects.toThrow(/document_templates_version/);
  });

  it("allows one document per student and recipient in a batch, nulls included", async () => {
    const schoolId = await createSchool();
    const ids = await seedTenant(schoolId);
    const doc = (guardianId: string | null) =>
      adminDb().insertInto("documents").values({ id: uuidv7(), schoolId, batchId: ids.documentBatchId, studentId: ids.studentId, guardianId }).execute();
    await expect(doc(null)).rejects.toThrow(/documents_one_per_recipient/);
    await doc(ids.guardianId);
    await expect(doc(ids.guardianId)).rejects.toThrow(/documents_one_per_recipient/);
  });

  it("requires the hash and path of a rendered document and a lease while rendering", async () => {
    const schoolId = await createSchool();
    const ids = await seedTenant(schoolId);
    const fam = await seedFamily(schoolId, ["Caio"]);
    await expect(
      adminDb().insertInto("documents").values({ id: uuidv7(), schoolId, batchId: ids.documentBatchId, studentId: fam.studentIds[0]!, status: "rendered" }).execute(),
    ).rejects.toThrow(/check constraint/);
    await expect(
      adminDb().insertInto("documents").values({ id: uuidv7(), schoolId, batchId: ids.documentBatchId, studentId: fam.studentIds[0]!, status: "rendering" }).execute(),
    ).rejects.toThrow(/check constraint/);
  });

  it("refuses a document for a student of another school", async () => {
    const a = await createSchool();
    const b = await createSchool();
    const seedA = await seedTenant(a);
    const seedB = await seedTenant(b);
    await expect(
      adminDb().insertInto("documents").values({ id: uuidv7(), schoolId: a, batchId: seedA.documentBatchId, studentId: seedB.studentId }).execute(),
    ).rejects.toThrow(/foreign key/i);
  });
});
