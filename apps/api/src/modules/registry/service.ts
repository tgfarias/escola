import {
  maskCpf,
  type ClassListResponse,
  type GuardianDetail,
  type ImportStudentsResponse,
  type StudentListResponse,
  type UpdateGuardianRequest,
  type UpdateStudentRequest,
} from "@app-lanche/contracts";
import { withTenant } from "../../db/index";
import { audit } from "../../platform/audit";
import { DomainError } from "../../platform/errors";
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
      // Upsert on every row (not only the first of each code/phone): a value that only shows up on a
      // later row is stored, and coalesce in the repo never erases an existing one.
      studentIds.set(
        row.externalCode,
        await repo.upsertStudent(trx, {
          schoolId,
          externalCode: row.externalCode,
          firstName: row.firstName,
          classId: classIds.get(row.className)!,
          fullName: row.fullName,
          birthDate: row.birthDate,
        }),
      );
      guardianIds.set(
        row.guardianPhone,
        await repo.upsertGuardian(trx, {
          schoolId,
          phoneE164: row.guardianPhone,
          firstName: row.guardianFirstName,
          fullName: row.guardianFullName,
          cpf: row.guardianCpf,
        }),
      );
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
          .map((l) => ({
            id: l.id,
            firstName: l.firstName,
            fullName: l.fullName,
            phone: l.phone,
            cpfMasked: l.cpf ? maskCpf(l.cpf) : null,
          })),
      })),
    };
  });
}

export async function updateStudent(session: SessionClaims, studentId: string, body: UpdateStudentRequest): Promise<void> {
  await withTenant(session.schoolId, async (trx) => {
    if (!(await repo.updateStudent(trx, studentId, body))) throw new DomainError("not_found");
    await audit(trx, { schoolId: session.schoolId, actorKind: "staff", actorId: session.sub, action: "student.updated", detail: { student_id: studentId, fields: ["full_name", "birth_date"] } });
  });
}

export async function getGuardian(session: SessionClaims, guardianId: string): Promise<GuardianDetail> {
  const row = await withTenant(session.schoolId, (trx) => repo.findGuardian(trx, guardianId));
  if (!row) throw new DomainError("not_found");
  return row;
}

export async function updateGuardian(session: SessionClaims, guardianId: string, body: UpdateGuardianRequest): Promise<void> {
  await withTenant(session.schoolId, async (trx) => {
    if (!(await repo.updateGuardian(trx, guardianId, body))) throw new DomainError("not_found");
    await audit(trx, { schoolId: session.schoolId, actorKind: "staff", actorId: session.sub, action: "guardian.updated", detail: { guardian_id: guardianId, fields: ["full_name", "cpf"] } });
  });
}
