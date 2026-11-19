import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import type { Trx } from "../../db/index";

/** Hoje no fuso da escola, pelo relógio do banco (AAAA-MM-DD). */
export async function schoolToday(trx: Trx): Promise<string> {
  const { rows } = await sql<{ today: string }>`
    SELECT (now() AT TIME ZONE s.timezone)::date::text AS today FROM schools s WHERE s.id = app_school_id()`.execute(trx);
  return rows[0]!.today;
}

export async function upsertClass(trx: Trx, schoolId: string, name: string): Promise<string> {
  const row = await trx
    .insertInto("classes")
    .values({ id: uuidv7(), schoolId, name })
    .onConflict((oc) => oc.columns(["schoolId", "name"]).doUpdateSet({ name }))
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function upsertStudent(
  trx: Trx,
  row: {
    schoolId: string;
    externalCode: string;
    firstName: string;
    classId: string;
    fullName: string | null;
    birthDate: string | null;
  },
): Promise<string> {
  const saved = await trx
    .insertInto("students")
    .values({ id: uuidv7(), ...row })
    .onConflict((oc) =>
      oc.columns(["schoolId", "externalCode"]).doUpdateSet({
        firstName: row.firstName,
        classId: row.classId,
        // A later import without these columns never erases what is already stored.
        fullName: sql<string | null>`coalesce(excluded.full_name, students.full_name)`,
        birthDate: sql<string | null>`coalesce(excluded.birth_date, students.birth_date)`,
      }),
    )
    .returning("id")
    .executeTakeFirstOrThrow();
  return saved.id;
}

export async function upsertGuardian(
  trx: Trx,
  row: { schoolId: string; phoneE164: string; firstName: string; fullName: string | null; cpf: string | null },
): Promise<string> {
  const saved = await trx
    .insertInto("guardians")
    .values({ id: uuidv7(), ...row })
    .onConflict((oc) =>
      oc.columns(["schoolId", "phoneE164"]).doUpdateSet({
        firstName: row.firstName,
        fullName: sql<string | null>`coalesce(excluded.full_name, guardians.full_name)`,
        cpf: sql<string | null>`coalesce(excluded.cpf, guardians.cpf)`,
      }),
    )
    .returning("id")
    .executeTakeFirstOrThrow();
  return saved.id;
}

/** Novo vínculo é o financeiro se o aluno ainda não tem um. O alvo explícito do ON CONFLICT não engole o índice parcial. */
export async function linkGuardianStudent(
  trx: Trx,
  row: { schoolId: string; guardianId: string; studentId: string },
): Promise<void> {
  await trx
    .insertInto("guardianStudents")
    .values({
      ...row,
      financial: sql<boolean>`NOT EXISTS (SELECT 1 FROM guardian_students f WHERE f.student_id = ${row.studentId} AND f.financial)`,
    })
    .onConflict((oc) => oc.columns(["schoolId", "guardianId", "studentId"]).doNothing())
    .execute();
}

export async function listClasses(trx: Trx) {
  return trx.selectFrom("classes").select(["id", "name"]).orderBy("name").execute();
}

export async function listStudents(trx: Trx) {
  return trx
    .selectFrom("students")
    .innerJoin("classes", "classes.id", "students.classId")
    .select([
      "students.id",
      "students.externalCode",
      "students.firstName",
      "students.fullName",
      "students.birthDate",
      "students.classId",
      "classes.name as className",
    ])
    .where("students.active", "=", true)
    .orderBy("students.firstName")
    .execute();
}

export async function listGuardianLinks(trx: Trx) {
  return trx
    .selectFrom("guardianStudents")
    .innerJoin("guardians", "guardians.id", "guardianStudents.guardianId")
    .select([
      "guardianStudents.studentId",
      "guardians.id",
      "guardians.firstName",
      "guardians.fullName",
      "guardians.cpf",
      "guardians.phoneE164 as phone",
      "guardianStudents.financial",
    ])
    .orderBy("guardians.firstName")
    .execute();
}

export async function updateStudent(trx: Trx, id: string, values: { fullName: string | null; birthDate: string | null }): Promise<boolean> {
  const res = await trx.updateTable("students").set(values).where("id", "=", id).executeTakeFirst();
  return res.numUpdatedRows > 0n;
}

export async function findGuardian(trx: Trx, id: string) {
  return trx.selectFrom("guardians").select(["id", "firstName", "fullName", "cpf"]).where("id", "=", id).executeTakeFirst();
}

export async function updateGuardian(trx: Trx, id: string, values: { fullName: string | null; cpf: string | null }): Promise<boolean> {
  const res = await trx.updateTable("guardians").set(values).where("id", "=", id).executeTakeFirst();
  return res.numUpdatedRows > 0n;
}

/** Vínculos do aluno, travados FOR UPDATE em ordem de responsável. Ordem de travas: guardian_students → wallets. */
export async function lockStudentLinks(trx: Trx, studentId: string) {
  return trx
    .selectFrom("guardianStudents")
    .select(["guardianId", "financial"])
    .where("studentId", "=", studentId)
    .orderBy("guardianId")
    .forUpdate()
    .execute();
}

export async function setFinancial(trx: Trx, studentId: string, guardianId: string): Promise<void> {
  // Primeiro desmarca o atual: o índice único parcial é conferido a cada comando.
  await trx
    .updateTable("guardianStudents")
    .set({ financial: false })
    .where("studentId", "=", studentId)
    .where("financial", "=", true)
    .where("guardianId", "<>", guardianId)
    .execute();
  await trx.updateTable("guardianStudents").set({ financial: true }).where("studentId", "=", studentId).where("guardianId", "=", guardianId).execute();
}
