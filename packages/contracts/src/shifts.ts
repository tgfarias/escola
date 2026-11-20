import { z } from "zod";

/** Turno da turma e do dia (spec F5C, B.1). Turnos além destes ficam fora do escopo. */
export const Shift = z.enum(["matutino", "vespertino"]);
export type Shift = z.infer<typeof Shift>;
export const SHIFTS: readonly Shift[] = Shift.options;

/** open → closed (romaneio pronto) → finished (cozinha encerrou; pendentes viram não retirados). */
export const ShiftStatus = z.enum(["open", "closed", "finished"]);
export type ShiftStatus = z.infer<typeof ShiftStatus>;

/** Horário local "HH:MM". */
export const CutoffTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
