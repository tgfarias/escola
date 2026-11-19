import type { ClassListResponse, StudentListResponse } from "@app-lanche/contracts";

export type StudentRow = StudentListResponse["students"][number];

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

export function filterStudents(students: StudentRow[], filter: { classId: string; query: string }): StudentRow[] {
  const q = fold(filter.query.trim());
  return students.filter(
    (s) => (filter.classId === "" || s.classId === filter.classId) && (q === "" || fold(`${s.firstName} ${s.fullName ?? ""}`).includes(q)),
  );
}

export function studentLabel(s: StudentRow): string {
  return s.fullName ?? s.firstName;
}

export type ClassRow = ClassListResponse["classes"][number];
