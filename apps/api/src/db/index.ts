import { CamelCasePlugin, Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import pg from "pg";
import type { DB } from "./types";

// int8 → number (centavos cabem com folga em 2^53); date → "YYYY-MM-DD", nunca um Date no fuso do servidor.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error("int8 value out of safe integer range");
  return n;
});
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

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

const commitHooks = new WeakMap<Trx, Array<() => void>>();

/** Agenda `fn` para depois do commit da transação de `withTenant`; não roda se ela desfizer. */
export function afterCommit(trx: Trx, fn: () => void): void {
  const hooks = commitHooks.get(trx);
  if (hooks) hooks.push(fn);
  else commitHooks.set(trx, [fn]);
}

/** Único caminho para ler ou gravar dados de uma escola. */
export async function withTenant<T>(schoolId: string, fn: (trx: Trx) => Promise<T>): Promise<T> {
  let current: Trx | undefined;
  try {
    const result = await getDb()
      .transaction()
      .execute(async (trx) => {
        current = trx;
        await sql`SELECT set_config('app.school_id', ${schoolId}, true)`.execute(trx);
        return fn(trx);
      });
    const hooks = current && commitHooks.get(current);
    for (const hook of hooks ?? []) {
      try {
        hook();
      } catch {
        // Gancho é melhor esforço; quem precisa de garantia usa o job.
      }
    }
    return result;
  } finally {
    if (current) commitHooks.delete(current);
  }
}

export async function closeDb(): Promise<void> {
  await db?.destroy();
  db = undefined;
}
