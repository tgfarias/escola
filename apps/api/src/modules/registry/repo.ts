import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import type { Trx } from "../../db/index";

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

export async function linkGuardianStudent(
  trx: Trx,
  row: { schoolId: string; guardianId: string; studentId: string },
): Promise<void> {
  await trx
    .insertInto("guardianStudents")
    .values(row)
    .onConflict((oc) => oc.doNothing())
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
