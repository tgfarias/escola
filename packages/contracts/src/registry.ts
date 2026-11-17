import { z } from "zod";

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

export const StudentListResponse = z.object({
  students: z.array(
    z.object({
      id: z.string().uuid(),
      externalCode: z.string(),
      firstName: z.string(),
      className: z.string(),
      guardians: z.array(z.object({ id: z.string().uuid(), firstName: z.string(), phone: z.string() })),
    }),
  ),
});
export type StudentListResponse = z.infer<typeof StudentListResponse>;
