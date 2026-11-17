import { z } from "zod";

export const Uuid = z.string().uuid();

/** Data civil `YYYY-MM-DD` válida (rejeita 2030-02-31). */
export const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "invalid date");

/** Centavos inteiros positivos, até R$ 10.000,00. */
export const Cents = z.number().int().positive().max(1_000_000);

export const IsoDateTime = z.string().datetime({ offset: true });
