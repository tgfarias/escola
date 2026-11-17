import { CamelCasePlugin, Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import pg from "pg";
import type { DB } from "./types";

export type Trx = Transaction<DB>;

let db: Kysely<DB> | undefined;

/** Uso restrito a este diretório e a funções resolve_* (ver spec 4.4). */
export function getDb(): Kysely<DB> {
  if (!db) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required");
    db = new Kysely<DB>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString, max: Number(process.env.DB_POOL_MAX ?? 5) }),
      }),
      plugins: [new CamelCasePlugin()],
    });
  }
  return db;
}

/** Único caminho para ler ou gravar dados de uma escola. */
export async function withTenant<T>(schoolId: string, fn: (trx: Trx) => Promise<T>): Promise<T> {
  return getDb()
    .transaction()
    .execute(async (trx) => {
      await sql`SELECT set_config('app.school_id', ${schoolId}, true)`.execute(trx);
      return fn(trx);
    });
}

export async function closeDb(): Promise<void> {
  await db?.destroy();
  db = undefined;
}
