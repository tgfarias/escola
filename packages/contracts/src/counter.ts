import { z } from "zod";
import { Cents, Uuid } from "./common";

/** O cliente envia só itens e quantidades; preço e total vêm do servidor (CLAUDE.md regra 7). */
export const CounterSaleItems = z
  .array(z.object({ menuItemId: Uuid, qty: z.number().int().min(1).max(10) }))
  .min(1)
  .max(10)
  .refine((items) => new Set(items.map((i) => i.menuItemId)).size === items.length, "duplicate item");
export type CounterSaleItems = z.infer<typeof CounterSaleItems>;

/** POST /api/admin/v1/counter-sales — `allowOverLimit` é a confirmação explícita da secretaria. */
export const StaffCounterSaleRequest = z
  .object({ studentId: Uuid, items: CounterSaleItems, allowOverLimit: z.boolean().optional() })
  .strict();
export type StaffCounterSaleRequest = z.infer<typeof StaffCounterSaleRequest>;

export const CounterSaleResult = z.object({ saleId: Uuid, totalCents: Cents, balanceCents: z.number().int(), overLimit: z.boolean() });
export type CounterSaleResult = z.infer<typeof CounterSaleResult>;

/** POST /api/admin/v1/counter-sales/:id/void */
export const CounterVoidResult = z.object({ saleId: Uuid, balanceCents: z.number().int() });
export type CounterVoidResult = z.infer<typeof CounterVoidResult>;

/** GET /api/kds/v1/roster e GET /api/admin/v1/counter/roster: alunos ativos, responsável financeiro com saldo, limite e itens ativos. */
export const CounterRosterResponse = z.object({
  debtLimitCents: z.number().int().nonnegative(),
  items: z.array(z.object({ id: Uuid, name: z.string(), priceCents: Cents })),
  students: z.array(
    z.object({
      id: Uuid,
      firstName: z.string(),
      className: z.string(),
      restrictions: z.string().nullable(),
      guardian: z.object({ id: Uuid, firstName: z.string(), balanceCents: z.number().int() }).nullable(),
    }),
  ),
});
export type CounterRosterResponse = z.infer<typeof CounterRosterResponse>;
