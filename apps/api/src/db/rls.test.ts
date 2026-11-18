import { CamelCasePlugin, Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { uuidv7 } from "uuidv7";
import { beforeAll, describe, expect, it } from "vitest";
import { adminDb, createSchool, seedTenant, type SeedIds } from "../../test/helpers";
import { getDb, withTenant } from "./index";
import type { DB } from "./types";

/** Toda tabela com school_id. Ao criar tabela nova, acrescente aqui e em seedTenant. */
const TENANT_TABLES = [
  "audit_log",
  "checkouts",
  "classes",
  "delivery_events",
  "devices",
  "guardian_students",
  "guardians",
  "idempotency_keys",
  "magic_links",
  "manifests",
  "menu_items",
  "message_deliveries",
  "order_items",
  "orders",
  "otp_challenges",
  "outbox_events",
  "payment_events",
  "payments",
  "reminder_batches",
  "service_day_items",
  "service_days",
  "staff_users",
  "students",
  "wallet_entries",
  "wallets",
];

describe("row level security", () => {
  let schoolA: string;
  let schoolB: string;
  let idsB: SeedIds;

  beforeAll(async () => {
    schoolA = await createSchool("A");
    schoolB = await createSchool("B");
    await seedTenant(schoolA);
    idsB = await seedTenant(schoolB);
  });

  it.each([...TENANT_TABLES, "schools"])("%s: has exactly one tenant_isolation policy for ALL commands", async (table) => {
    const { rows } = await sql<{ policyname: string; cmd: string; permissive: string; qual: string | null }>`
      SELECT policyname, cmd, permissive, qual FROM pg_policies
      WHERE schemaname = 'public' AND tablename = ${table}`.execute(adminDb());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.policyname).toBe("tenant_isolation");
    expect(rows[0]?.cmd).toBe("ALL");
    expect(rows[0]?.permissive).toBe("PERMISSIVE");
    expect(rows[0]?.qual).toContain("app_school_id()");
  });

  it("lists every table that has a school_id column", async () => {
    const { rows } = await sql<{ tableName: string }>`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'school_id'
      ORDER BY table_name`.execute(adminDb());
    expect(rows.map((r) => r.tableName)).toEqual(TENANT_TABLES);
  });

  it("has RLS enabled on every table except schema_migrations", async () => {
    const { rows } = await sql<{ relname: string }>`
      SELECT c.relname FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND NOT c.relrowsecurity AND c.relname <> 'schema_migrations'`.execute(adminDb());
    expect(rows).toEqual([]);
  });

  it.each(TENANT_TABLES)("%s: tenant A sees only its own rows", async (table) => {
    const visible = await withTenant(schoolA, (trx) =>
      sql<{ schoolId: string }>`SELECT school_id FROM ${sql.table(table)}`.execute(trx),
    );
    expect(visible.rows.length).toBeGreaterThan(0);
    expect(new Set(visible.rows.map((r) => r.schoolId))).toEqual(new Set([schoolA]));
  });

  it("sees only its own school", async () => {
    const rows = await withTenant(schoolA, (trx) => trx.selectFrom("schools").select("id").execute());
    expect(rows).toEqual([{ id: schoolA }]);
  });

  it("sees nothing without a tenant", async () => {
    const rows = await getDb().selectFrom("classes").select("id").execute();
    expect(rows).toEqual([]);
  });

  it("rejects writing a row for another tenant", async () => {
    await expect(
      withTenant(schoolA, (trx) =>
        trx.insertInto("classes").values({ id: uuidv7(), schoolId: schoolB, name: "X" }).execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("cannot update another tenant's row", async () => {
    const res = await withTenant(schoolA, (trx) =>
      trx.updateTable("classes").set({ name: "hacked" }).where("id", "=", idsB.classId).executeTakeFirst(),
    );
    expect(res.numUpdatedRows).toBe(0n);
    const row = await adminDb()
      .selectFrom("classes")
      .select("name")
      .where("id", "=", idsB.classId)
      .executeTakeFirstOrThrow();
    expect(row.name).toBe("Infantil 3A");
  });

  it("cannot delete another tenant's row", async () => {
    const res = await withTenant(schoolA, (trx) =>
      trx.deleteFrom("classes").where("id", "=", idsB.classId).executeTakeFirst(),
    );
    expect(res.numDeletedRows).toBe(0n);
    const row = await adminDb()
      .selectFrom("classes")
      .select("id")
      .where("id", "=", idsB.classId)
      .executeTakeFirst();
    expect(row?.id).toBe(idsB.classId);
  });

  it("a blanket update as tenant A touches only A's rows", async () => {
    const own = await adminDb()
      .selectFrom("classes")
      .select("id")
      .where("schoolId", "=", schoolA)
      .execute();
    const res = await withTenant(schoolA, (trx) =>
      sql`UPDATE classes SET name = name`.execute(trx),
    );
    expect(res.numAffectedRows).toBe(BigInt(own.length));
    expect(own.length).toBeGreaterThan(0);
  });

  it("audit_log is append-only: update and delete are denied even on own rows", async () => {
    await expect(
      withTenant(schoolA, (trx) => sql`UPDATE audit_log SET action = 'tampered'`.execute(trx)),
    ).rejects.toThrow(/permission denied/);
    await expect(withTenant(schoolA, (trx) => sql`DELETE FROM audit_log`.execute(trx))).rejects.toThrow(
      /permission denied/,
    );
  });

  it("does not leak the tenant setting to the next transaction on the same connection", async () => {
    const single = new Kysely<DB>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 }),
      }),
      plugins: [new CamelCasePlugin()],
    });
    try {
      const pid = (r: { rows: { pid: number }[] }) => r.rows[0]?.pid;
      const inTx = await single.transaction().execute(async (trx) => {
        await sql`SELECT set_config('app.school_id', ${schoolA}, true)`.execute(trx);
        const seen = await trx.selectFrom("classes").select("id").execute();
        expect(seen.length).toBeGreaterThan(0);
        return pid(await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx));
      });
      const rows = await single.selectFrom("classes").select("id").execute();
      const after = pid(await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(single));
      expect(rows).toEqual([]);
      expect(after).toBe(inTx);
    } finally {
      await single.destroy();
    }
  });
});
