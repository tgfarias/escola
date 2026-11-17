import { sql } from "kysely";
import { getDb, type Trx } from "../../db/index";

export async function resolveMagicLink(
  tokenHash: string,
): Promise<{ schoolId: string; magicLinkId: string } | undefined> {
  const { rows } = await sql<{ schoolId: string; magicLinkId: string }>`
    SELECT school_id, magic_link_id FROM resolve_magic_link(${tokenHash})`.execute(getDb());
  return rows[0];
}

export async function resolveStaffEmail(
  email: string,
): Promise<{ schoolId: string; staffUserId: string } | undefined> {
  const { rows } = await sql<{ schoolId: string; staffUserId: string }>`
    SELECT school_id, staff_user_id FROM resolve_staff_email(${email})`.execute(getDb());
  return rows[0];
}

export async function insertMagicLink(
  trx: Trx,
  row: {
    id: string;
    schoolId: string;
    guardianId: string;
    tokenHash: string;
    scope: "order" | "documents";
    serviceDate: string | null;
    expiresAt: Date;
  },
): Promise<void> {
  await trx.insertInto("magicLinks").values(row).execute();
}

/** Insere o desafio com validade de 5 minutos pelo relógio do banco e devolve o vencimento. */
export async function insertChallenge(
  trx: Trx,
  row: { id: string; schoolId: string; subjectKind: "guardian" | "staff"; subjectId: string; codeHash: string },
): Promise<Date> {
  const inserted = await trx
    .insertInto("otpChallenges")
    .values({ ...row, expiresAt: sql<Date>`now() + interval '5 minutes'` })
    .returning("expiresAt")
    .executeTakeFirstOrThrow();
  return inserted.expiresAt;
}

export async function lockChallenge(trx: Trx, id: string) {
  return trx
    .selectFrom("otpChallenges")
    .select(["id", "codeHash", "attempts", "consumedAt"])
    .select(sql<boolean>`${sql.ref("expiresAt")} <= now()`.as("expired"))
    .where("id", "=", id)
    .forUpdate()
    .executeTakeFirst();
}

export async function incrementAttempts(trx: Trx, id: string): Promise<void> {
  await trx
    .updateTable("otpChallenges")
    .set((eb) => ({ attempts: eb("attempts", "+", 1) }))
    .where("id", "=", id)
    .execute();
}

export async function consumeChallenge(trx: Trx, id: string): Promise<void> {
  await trx
    .updateTable("otpChallenges")
    .set({ consumedAt: sql<Date>`now()` })
    .where("id", "=", id)
    .execute();
}
