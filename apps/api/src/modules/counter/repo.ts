import { sql } from "kysely";
import type { Trx } from "../../db/index";

export async function existingSaleIds(trx: Trx, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await trx.selectFrom("counterSales").select("id").where("id", "in", ids).execute();
  return new Set(rows.map((r) => r.id));
}

export async function activeStudentIds(trx: Trx, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await trx.selectFrom("students").select("id").where("id", "in", ids).where("active", "=", true).execute();
  return new Set(rows.map((r) => r.id));
}

/** Preço atual dos itens ativos do cardápio: o servidor calcula o total (CLAUDE.md regra 7). */
export async function activeItemPrices(trx: Trx, ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await trx.selectFrom("menuItems").select(["id", "priceCents"]).where("id", "in", ids).where("active", "=", true).execute();
  return new Map(rows.map((r) => [r.id, r.priceCents]));
}

/** Responsável financeiro de cada aluno, FOR SHARE (a troca trava FOR UPDATE). Ordem: guardian_students → wallets. */
export async function lockFinancialGuardians(trx: Trx, studentIds: string[]): Promise<Map<string, string>> {
  if (studentIds.length === 0) return new Map();
  const { rows } = await sql<{ studentId: string; guardianId: string }>`
    SELECT student_id, guardian_id FROM guardian_students
    WHERE student_id = ANY(${studentIds}::uuid[]) AND financial
    ORDER BY student_id FOR SHARE`.execute(trx);
  return new Map(rows.map((r) => [r.studentId, r.guardianId]));
}

export async function debtLimit(trx: Trx): Promise<number> {
  return (await trx.selectFrom("schools").select("debtLimitCents").executeTakeFirstOrThrow()).debtLimitCents;
}

/** occurred_at limitado a 5 min à frente do relógio do banco; sem instante do cliente (secretaria), now(). */
export async function insertSale(
  trx: Trx,
  row: {
    id: string;
    schoolId: string;
    studentId: string;
    guardianId: string;
    source: "kitchen" | "staff";
    deviceId: string | null;
    staffUserId: string | null;
    occurredAt: string | null;
    totalCents: number;
    overLimit: boolean;
    walletEntryId: string;
  },
): Promise<void> {
  await sql`
    INSERT INTO counter_sales (id, school_id, student_id, guardian_id, source, device_id, staff_user_id, occurred_at,
                               total_cents, over_limit, wallet_entry_id)
    VALUES (${row.id}, ${row.schoolId}, ${row.studentId}, ${row.guardianId}, ${row.source}, ${row.deviceId}, ${row.staffUserId},
            least(coalesce(${row.occurredAt}::timestamptz, now()), now() + interval '5 minutes'),
            ${row.totalCents}, ${row.overLimit}, ${row.walletEntryId})`.execute(trx);
}

export async function insertSaleItems(
  trx: Trx,
  rows: { schoolId: string; saleId: string; menuItemId: string; qty: number; unitPriceCents: number }[],
): Promise<void> {
  if (rows.length > 0) await trx.insertInto("counterSaleItems").values(rows).execute();
}

export type LockedSale = { id: string; guardianId: string; totalCents: number; source: "kitchen" | "staff"; voidedAt: Date | null; occurredAt: Date };

/** Lançamentos travados FOR UPDATE em ordem de id (antes das carteiras). */
export async function lockSales(trx: Trx, ids: string[]): Promise<Map<string, LockedSale>> {
  if (ids.length === 0) return new Map();
  const { rows } = await sql<LockedSale>`
    SELECT id, guardian_id, total_cents, source, voided_at, occurred_at FROM counter_sales
    WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`.execute(trx);
  return new Map(rows.map((r) => [r.id, r]));
}

/** Mesmo dia no fuso da escola: o do lançamento e o do estorno (limitado ao relógio do banco). */
export async function sameSchoolDay(trx: Trx, saleAt: Date, voidAt: string): Promise<boolean> {
  const { rows } = await sql<{ same: boolean }>`
    SELECT (${saleAt}::timestamptz AT TIME ZONE s.timezone)::date
         = (least(${voidAt}::timestamptz, now()) AT TIME ZONE s.timezone)::date AS same
    FROM schools s WHERE s.id = app_school_id()`.execute(trx);
  return rows[0]?.same ?? false;
}

export async function markVoided(trx: Trx, saleId: string, entryId: string): Promise<boolean> {
  const res = await sql`
    UPDATE counter_sales SET voided_at = now(), void_entry_id = ${entryId}
    WHERE id = ${saleId} AND voided_at IS NULL`.execute(trx);
  return Number(res.numAffectedRows ?? 0) === 1;
}

/** Restrição alimentar só com consentimento de um responsável (spec 4.5), como no romaneio. */
export async function rosterStudents(trx: Trx) {
  const { rows } = await sql<{
    id: string;
    firstName: string;
    className: string;
    restrictions: string | null;
    guardianId: string | null;
    guardianFirstName: string | null;
    balanceCents: number;
  }>`
    SELECT s.id, s.first_name, c.name AS class_name,
      CASE WHEN EXISTS (
        SELECT 1 FROM guardian_students x WHERE x.student_id = s.id AND x.restriction_consent_at IS NOT NULL
      ) THEN s.dietary_restrictions END AS restrictions,
      g.id AS guardian_id, g.first_name AS guardian_first_name, coalesce(w.balance_cents, 0) AS balance_cents
    FROM students s
    JOIN classes c ON c.id = s.class_id
    LEFT JOIN guardian_students gs ON gs.student_id = s.id AND gs.financial
    LEFT JOIN guardians g ON g.id = gs.guardian_id
    LEFT JOIN wallets w ON w.guardian_id = g.id
    WHERE s.active
    ORDER BY c.name, s.first_name, s.id`.execute(trx);
  return rows;
}

export async function rosterItems(trx: Trx) {
  return trx.selectFrom("menuItems").select(["id", "name", "priceCents"]).where("active", "=", true).orderBy("name").execute();
}
