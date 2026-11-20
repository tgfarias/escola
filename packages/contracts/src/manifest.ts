import { z } from "zod";
import { ServiceDayStatus } from "./catalog";
import { IsoDate } from "./common";
import { Shift } from "./shifts";

export const ManifestContent = z.object({
  totals: z.object({
    orders: z.number().int().nonnegative(),
    by_item: z.array(z.object({ item: z.string(), qty: z.number().int().positive() })),
  }),
  by_class: z.array(
    z.object({
      class: z.string(),
      orders: z.array(
        z.object({
          order_id: z.string().uuid(),
          student: z.string(),
          items: z.array(z.string()).min(1),
          restrictions: z.string().nullable(),
        }),
      ),
    }),
  ),
  late_credits: z.number().int().nonnegative(),
});
export type ManifestContent = z.infer<typeof ManifestContent>;

/** Romaneio de um turno, congelado no fechamento (regra 18). `status` é o do turno. */
export const ManifestResponse = ManifestContent.extend({
  shift: Shift,
  status: z.enum(["closed", "finished"]),
  closed_at: z.string().datetime({ offset: true }),
  manifest_version: z.number().int().positive(),
  kitchen_phone: z.string().nullable(),
});
export type ManifestResponse = z.infer<typeof ManifestResponse>;

/** Fechamento do dia (n8n, segurança, equipe): turnos já fechados ou finalizados, matutino primeiro. */
export const ServiceDayCloseResponse = z.object({
  service_date: IsoDate,
  status: ServiceDayStatus,
  shifts: z.array(ManifestResponse).min(1),
});
export type ServiceDayCloseResponse = z.infer<typeof ServiceDayCloseResponse>;

/** `?shift=` das rotas de leitura do romaneio; sem ele, o da manhã (eventos anteriores aos turnos). */
export const ManifestQuery = z.object({ shift: Shift.default("matutino") });
