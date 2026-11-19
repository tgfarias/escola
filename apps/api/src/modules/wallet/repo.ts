import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import type { Trx } from "../../db/index";

export async function ensureWallet(trx: Trx, schoolId: string, guardianId: string): Promise<void> {
  await trx
    .insertInto("wallets")
    .values({ id: uuidv7(), schoolId, guardianId })
    .onConflict((oc) => oc.columns(["schoolId", "guardianId"]).doNothing())
    .execute();
}

export async function lockWallet(trx: Trx, guardianId: string) {
  return trx
    .selectFrom("wallets")
    .select(["id", "balanceCents"])
    .where("guardianId", "=", guardianId)
    .forUpdate()
    .executeTakeFirstOrThrow();
}

export async function insertEntry(
  trx: Trx,
  entry: {
    id: string;
    schoolId: string;
    walletId: string;
    kind: string;
    amountCents: number;
    sourceType: string;
    sourceId: string;
    note: string | null;
  },
): Promise<boolean> {
  const row = await trx
    .insertInto("walletEntries")
    .values(entry)
    .onConflict((oc) => oc.columns(["schoolId", "sourceType", "sourceId", "kind"]).doNothing())
    .returning("id")
    .executeTakeFirst();
  return row !== undefined;
}

export async function setBalance(trx: Trx, walletId: string, balanceCents: number): Promise<void> {
  await trx.updateTable("wallets").set({ balanceCents }).where("id", "=", walletId).execute();
}

export async function readBalance(trx: Trx, guardianId: string): Promise<number> {
  const row = await trx.selectFrom("wallets").select("balanceCents").where("guardianId", "=", guardianId).executeTakeFirst();
  return row?.balanceCents ?? 0;
}

export async function financialStudentNames(trx: Trx, guardianId: string): Promise<string[]> {
  const rows = await trx
    .selectFrom("guardianStudents")
    .innerJoin("students", "students.id", "guardianStudents.studentId")
    .select("students.firstName")
    .where("guardianStudents.guardianId", "=", guardianId)
    .where("guardianStudents.financial", "=", true)
    .where("students.active", "=", true)
    .orderBy("students.firstName")
    .execute();
  return rows.map((r) => r.firstName);
}

/** Lanches dos alunos do responsável lançados na carteira de outro (30 dias). */
export async function salesChargedToOthers(trx: Trx, guardianId: string) {
  const { rows } = await sql<{ id: string; studentFirstName: string; occurredAt: Date; totalCents: number; voided: boolean }>`
    SELECT cs.id, st.first_name AS student_first_name, cs.occurred_at, cs.total_cents, (cs.voided_at IS NOT NULL) AS voided
    FROM counter_sales cs
    JOIN guardian_students gs ON gs.student_id = cs.student_id AND gs.guardian_id = ${guardianId}
    JOIN students st ON st.id = cs.student_id AND st.active
    WHERE cs.guardian_id <> ${guardianId} AND cs.occurred_at > now() - interval '30 days'
    ORDER BY cs.occurred_at DESC, cs.id DESC
    LIMIT 50`.execute(trx);
  return rows;
}

export async function guardianExists(trx: Trx, guardianId: string): Promise<boolean> {
  const row = await trx.selectFrom("guardians").select("id").where("id", "=", guardianId).executeTakeFirst();
  return row !== undefined;
}

/** Trava as carteiras em ordem de guardian_id: lotes de balcão de dois tablets nunca se travam em ordens opostas. */
export async function lockWallets(trx: Trx, guardianIds: string[]): Promise<void> {
  if (guardianIds.length === 0) return;
  await trx.selectFrom("wallets").select("id").where("guardianId", "in", guardianIds).orderBy("guardianId").forUpdate().execute();
}

/** Marca o aviso das carteiras negativas sem aviso há 3 dias (relógio do banco) e devolve quais eram. */
export async function claimDueDebtNotices(trx: Trx) {
  const { rows } = await sql<{ guardianId: string; balanceCents: number }>`
    UPDATE wallets SET debt_notice_at = now()
    WHERE balance_cents < 0 AND (debt_notice_at IS NULL OR debt_notice_at <= now() - interval '3 days')
    RETURNING guardian_id, balance_cents`.execute(trx);
  return rows;
}

export async function markDebtNotice(trx: Trx, guardianId: string): Promise<void> {
  await trx.updateTable("wallets").set({ debtNoticeAt: sql<Date>`now()` }).where("guardianId", "=", guardianId).execute();
}

export async function guardianContact(trx: Trx, guardianId: string) {
  return trx.selectFrom("guardians").select(["phoneE164", "firstName"]).where("id", "=", guardianId).executeTakeFirstOrThrow();
}

export async function debtLimit(trx: Trx): Promise<number> {
  return (await trx.selectFrom("schools").select("debtLimitCents").executeTakeFirstOrThrow()).debtLimitCents;
}

/** Limite atual com a linha da escola travada FOR UPDATE (duas alterações não se cruzam na auditoria). */
export async function lockDebtLimit(trx: Trx): Promise<number> {
  return (await trx.selectFrom("schools").select("debtLimitCents").forUpdate().executeTakeFirstOrThrow()).debtLimitCents;
}

export async function setDebtLimit(trx: Trx, debtLimitCents: number): Promise<void> {
  await trx.updateTable("schools").set({ debtLimitCents }).execute();
}

export async function guardianName(trx: Trx, guardianId: string) {
  return trx.selectFrom("guardians").select(["id", "firstName"]).where("id", "=", guardianId).executeTakeFirst();
}

/** Todos os responsáveis, débitos primeiro; `students` = alunos ativos de quem ele é o financeiro. */
export async function listAccounts(trx: Trx) {
  const { rows } = await sql<{ guardianId: string; firstName: string; balanceCents: number; students: string[] }>`
    SELECT g.id AS guardian_id, g.first_name, coalesce(w.balance_cents, 0) AS balance_cents,
      coalesce(array_agg(s.first_name ORDER BY s.first_name) FILTER (WHERE s.id IS NOT NULL), '{}') AS students
    FROM guardians g
    LEFT JOIN wallets w ON w.guardian_id = g.id
    LEFT JOIN guardian_students gs ON gs.guardian_id = g.id AND gs.financial
    LEFT JOIN students s ON s.id = gs.student_id AND s.active
    GROUP BY g.id, g.first_name, w.balance_cents
    ORDER BY coalesce(w.balance_cents, 0), g.first_name, g.id`.execute(trx);
  return rows;
}

/** Lançamentos acima do limite, não estornados, recebidos nos últimos 7 dias (relógio do banco). */
export async function recentOverLimitSales(trx: Trx) {
  const { rows } = await sql<{
    saleId: string;
    guardianId: string;
    guardianFirstName: string;
    studentFirstName: string;
    occurredAt: Date;
    totalCents: number;
  }>`
    SELECT cs.id AS sale_id, cs.guardian_id, g.first_name AS guardian_first_name, s.first_name AS student_first_name,
      cs.occurred_at, cs.total_cents
    FROM counter_sales cs
    JOIN guardians g ON g.id = cs.guardian_id
    JOIN students s ON s.id = cs.student_id
    WHERE cs.over_limit AND cs.voided_at IS NULL AND cs.received_at > now() - interval '7 days'
    ORDER BY cs.occurred_at DESC, cs.id DESC
    LIMIT 50`.execute(trx);
  return rows;
}

/** Extrato: lançamentos do balcão trazem o aluno, o selo de ultrapassagem e se foram estornados. */
export async function statementEntries(trx: Trx, guardianId: string, limit: number) {
  const { rows } = await sql<{
    id: string;
    kind: string;
    amountCents: number;
    createdAt: Date;
    saleId: string | null;
    studentFirstName: string | null;
    overLimit: boolean;
    voided: boolean;
  }>`
    SELECT e.id, e.kind, e.amount_cents, e.created_at, cs.id AS sale_id, st.first_name AS student_first_name,
      coalesce(e.kind = 'counter_charge' AND cs.over_limit, false) AS over_limit,
      coalesce(cs.voided_at IS NOT NULL, false) AS voided
    FROM wallet_entries e
    JOIN wallets w ON w.id = e.wallet_id
    LEFT JOIN counter_sales cs ON e.source_type = 'counter_sale' AND cs.id = e.source_id
    LEFT JOIN students st ON st.id = cs.student_id
    WHERE w.guardian_id = ${guardianId}
    ORDER BY e.created_at DESC, e.id DESC
    LIMIT ${limit}`.execute(trx);
  return rows;
}
