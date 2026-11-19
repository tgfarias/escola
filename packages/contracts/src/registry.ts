import { z } from "zod";
import { IsoDate, Uuid } from "./common";
import { Cpf } from "./cpf";

export const ImportStudentsRequest = z.object({ csv: z.string().min(1).max(900_000) });
export type ImportStudentsRequest = z.infer<typeof ImportStudentsRequest>;

export const ImportStudentsResponse = z.object({
  applied: z.boolean(),
  errors: z.array(z.object({ line: z.number().int(), message: z.string() })),
  classes: z.number().int(),
  students: z.number().int(),
  guardians: z.number().int(),
});
export type ImportStudentsResponse = z.infer<typeof ImportStudentsResponse>;

export const ClassListResponse = z.object({
  classes: z.array(z.object({ id: z.string().uuid(), name: z.string() })),
});
export type ClassListResponse = z.infer<typeof ClassListResponse>;

export const PersonName = z.string().trim().min(1).max(200);

export const StudentListResponse = z.object({
  students: z.array(
    z.object({
      id: Uuid,
      externalCode: z.string(),
      firstName: z.string(),
      fullName: z.string().nullable(),
      birthDate: IsoDate.nullable(),
      classId: Uuid,
      className: z.string(),
      guardians: z.array(
        z.object({ id: Uuid, firstName: z.string(), fullName: z.string().nullable(), phone: z.string(), cpfMasked: z.string().nullable(), financial: z.boolean() }),
      ),
    }),
  ),
});
export type StudentListResponse = z.infer<typeof StudentListResponse>;

/** PUT /api/admin/v1/students/:id — null apaga o valor. */
export const UpdateStudentRequest = z.object({ fullName: PersonName.nullable(), birthDate: IsoDate.nullable() }).strict();
export type UpdateStudentRequest = z.infer<typeof UpdateStudentRequest>;

/** PUT /api/admin/v1/students/:id/financial-guardian — o responsável precisa estar vinculado ao aluno. */
export const SetFinancialGuardianRequest = z.object({ guardianId: Uuid }).strict();
export type SetFinancialGuardianRequest = z.infer<typeof SetFinancialGuardianRequest>;

/** GET /api/admin/v1/guardians/:id — único lugar com o CPF completo (formulário de edição). */
export const GuardianDetail = z.object({ id: Uuid, firstName: z.string(), fullName: z.string().nullable(), cpf: z.string().nullable() });
export type GuardianDetail = z.infer<typeof GuardianDetail>;

export const UpdateGuardianRequest = z.object({ fullName: PersonName.nullable(), cpf: Cpf.nullable() }).strict();
export type UpdateGuardianRequest = z.infer<typeof UpdateGuardianRequest>;
