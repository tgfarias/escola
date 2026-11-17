import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { sql } from "kysely";
import type { Trx } from "../db/index";
import { DomainError } from "./errors";

export const IDEMPOTENCY_HEADER = "idempotency-key";
const KEY_FORMAT = /^[A-Za-z0-9_-]{8,200}$/;

export function idempotencyKeyFrom(req: FastifyRequest): string {
  const value = req.headers[IDEMPOTENCY_HEADER];
  if (typeof value !== "string" || !KEY_FORMAT.test(value)) throw new DomainError("idempotency_key_required");
  return value;
}

/** Identifica a requisição: a mesma chave com outra rota, outro autor ou outro corpo é recusada. */
export function requestHash(parts: { route: string; actorId: string; body: unknown }): string {
  return createHash("sha256")
    .update(JSON.stringify([parts.route, parts.actorId, parts.body ?? null]))
    .digest("hex");
}

/**
 * Executa `fn` uma única vez por (escola, chave), na transação de quem chama.
 * - A chave é gravada antes do trabalho; uma repetição concorrente espera na chave primária até o commit
 *   da primeira e então devolve a resposta gravada.
 * - Se o trabalho falhar, a transação inteira volta e a chave não fica gravada: a repetição executa de novo.
 * - A resposta é lida como texto para não ter as chaves convertidas pelo CamelCasePlugin.
 */
export async function idempotent<T>(
  trx: Trx,
  input: { schoolId: string; key: string; requestHash: string },
  fn: () => Promise<T>,
): Promise<{ response: T; replayed: boolean }> {
  const claimed = await trx
    .insertInto("idempotencyKeys")
    .values({ schoolId: input.schoolId, key: input.key, requestHash: input.requestHash })
    .onConflict((oc) => oc.columns(["schoolId", "key"]).doNothing())
    .returning("key")
    .executeTakeFirst();

  if (!claimed) {
    const row = await trx
      .selectFrom("idempotencyKeys")
      .select(["requestHash", sql<string | null>`response::text`.as("responseText")])
      .where("schoolId", "=", input.schoolId)
      .where("key", "=", input.key)
      .executeTakeFirstOrThrow();
    if (row.requestHash !== input.requestHash || row.responseText === null) {
      throw new DomainError("idempotency_key_reused");
    }
    return { response: JSON.parse(row.responseText) as T, replayed: true };
  }

  const response = await fn();
  const text = JSON.stringify(response);
  await trx
    .updateTable("idempotencyKeys")
    .set({ response: text })
    .where("schoolId", "=", input.schoolId)
    .where("key", "=", input.key)
    .execute();
  return { response: JSON.parse(text) as T, replayed: false };
}
