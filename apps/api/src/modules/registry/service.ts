import type { ClassListResponse, ImportStudentsResponse, StudentListResponse } from "@app-lanche/contracts";
import { withTenant } from "../../db/index";
import { audit } from "../../platform/audit";
import type { SessionClaims } from "../../platform/session";
import { parseStudentsCsv } from "./csv";
import * as repo from "./repo";

export async function importStudents(session: SessionClaims, csv: string): Promise<ImportStudentsResponse> {
  const { rows, errors } = parseStudentsCsv(csv);
  if (errors.length > 0) return { applied: false, errors, classes: 0, students: 0, guardians: 0 };
  const schoolId = session.schoolId;

  return withTenant(schoolId, async (trx) => {
    const classIds = new Map<string, string>();
    const studentIds = new Map<string, string>();
    const guardianIds = new Map<string, string>();

    for (const row of rows) {
      if (!classIds.has(row.className)) {
        classIds.set(row.className, await repo.upsertClass(trx, schoolId, row.className));
      }
      if (!studentIds.has(row.externalCode)) {
        studentIds.set(
          row.externalCode,
          await repo.upsertStudent(trx, {
            schoolId,
            externalCode: row.externalCode,
            firstName: row.firstName,
            classId: classIds.get(row.className)!,
          }),
        );
      }
      if (!guardianIds.has(row.guardianPhone)) {
        guardianIds.set(
          row.guardianPhone,
          await repo.upsertGuardian(trx, {
            schoolId,
            phoneE164: row.guardianPhone,
            firstName: row.guardianFirstName,
          }),
        );
      }
      await repo.linkGuardianStudent(trx, {
        schoolId,
        guardianId: guardianIds.get(row.guardianPhone)!,
        studentId: studentIds.get(row.externalCode)!,
      });
    }

    const totals = { classes: classIds.size, students: studentIds.size, guardians: guardianIds.size };
    await audit(trx, {
      schoolId,
      actorKind: "staff",
      actorId: session.sub,
      action: "students.import",
      detail: totals,
    });
    return { applied: true, errors: [], ...totals };
  });
}

export async function listClasses(session: SessionClaims): Promise<ClassListResponse> {
  return { classes: await withTenant(session.schoolId, (trx) => repo.listClasses(trx)) };
}

export async function listStudents(session: SessionClaims): Promise<StudentListResponse> {
  return withTenant(session.schoolId, async (trx) => {
    const students = await repo.listStudents(trx);
    const links = await repo.listGuardianLinks(trx);
    return {
      students: students.map((s) => ({
        ...s,
        guardians: links
          .filter((l) => l.studentId === s.id)
          .map((l) => ({ id: l.id, firstName: l.firstName, phone: l.phone })),
      })),
    };
  });
}
