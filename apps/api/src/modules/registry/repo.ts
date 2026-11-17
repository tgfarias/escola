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
  row: { schoolId: string; externalCode: string; firstName: string; classId: string },
): Promise<string> {
  const saved = await trx
    .insertInto("students")
    .values({ id: uuidv7(), ...row })
    .onConflict((oc) =>
      oc.columns(["schoolId", "externalCode"]).doUpdateSet({ firstName: row.firstName, classId: row.classId }),
    )
    .returning("id")
    .executeTakeFirstOrThrow();
  return saved.id;
}

export async function upsertGuardian(
  trx: Trx,
  row: { schoolId: string; phoneE164: string; firstName: string },
): Promise<string> {
  const saved = await trx
    .insertInto("guardians")
    .values({ id: uuidv7(), ...row })
    .onConflict((oc) => oc.columns(["schoolId", "phoneE164"]).doUpdateSet({ firstName: row.firstName }))
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
    .select(["students.id", "students.externalCode", "students.firstName", "classes.name as className"])
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
      "guardians.phoneE164 as phone",
    ])
    .orderBy("guardians.firstName")
    .execute();
}
