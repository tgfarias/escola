import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

export async function migrate(opts: { adminUrl: string; appPassword: string }): Promise<string[]> {
  const client = new pg.Client({ connectionString: opts.adminUrl });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock(727001)");
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
          CREATE ROLE app_user LOGIN;
        END IF;
      END $$`);
    await client.query(`ALTER ROLE app_user PASSWORD ${client.escapeLiteral(opts.appPassword)}`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const done = new Set(
      (await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map(
        (r) => r.name,
      ),
    );
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    const applied: string[] = [];
    for (const file of files) {
      if (done.has(file)) continue;
      const sqlText = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sqlText);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
      applied.push(file);
    }
    return applied;
  } finally {
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  const appPassword = process.env.APP_DB_PASSWORD;
  if (!adminUrl || !appPassword) {
    console.error("DATABASE_ADMIN_URL and APP_DB_PASSWORD are required");
    process.exit(1);
  }
  migrate({ adminUrl, appPassword }).then(
    (applied) => console.log(applied.length ? `applied: ${applied.join(", ")}` : "up to date"),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
