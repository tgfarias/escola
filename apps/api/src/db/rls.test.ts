import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { beforeAll, describe, expect, it } from "vitest";
import { adminDb, createSchool, seedTenant } from "../../test/helpers";
import { getDb, withTenant } from "./index";

/** Toda tabela com school_id. Ao criar tabela nova, acrescente aqui e em seedTenant. */
const TENANT_TABLES = [
  "audit_log",
  "classes",
  "guardian_students",
  "guardians",
  "outbox_events",
  "staff_users",
  "students",
];

describe("row level security", () => {
  let schoolA: string;
  let schoolB: string;

  beforeAll(async () => {
    schoolA = await createSchool("A");
    schoolB = await createSchool("B");
    await seedTenant(schoolA);
    await seedTenant(schoolB);
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

  it("does not leak the tenant setting to the next transaction on the same connection", async () => {
    await withTenant(schoolA, (trx) => trx.selectFrom("classes").select("id").execute());
    const rows = await getDb().selectFrom("classes").select("id").execute();
    expect(rows).toEqual([]);
  });
});
