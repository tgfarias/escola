import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../../db/migrate";

describe("migrate", () => {
  let admin: pg.Client;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
    await admin.connect();
  });
  afterAll(async () => {
    await admin.end();
  });

  it("recorded the migrations applied by global setup", async () => {
    const { rows } = await admin.query("SELECT name FROM schema_migrations ORDER BY name");
    expect(rows[0].name).toBe("0001_schools.sql");
  });

  it("applies nothing on a second run", async () => {
    const applied = await migrate({
      adminUrl: process.env.DATABASE_ADMIN_URL!,
      appPassword: "app_user",
    });
    expect(applied).toEqual([]);
  });

  it("lets app_user connect but not bypass RLS", async () => {
    const { rows } = await admin.query(
      "SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'app_user'",
    );
    expect(rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
    const app = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await app.connect();
    const res = await app.query("SELECT app_school_id() AS id");
    expect(res.rows[0].id).toBeNull();
    await app.end();
  });
});
