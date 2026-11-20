import { z } from "zod";
import { IsoDate } from "./common";

export const DashboardPeriod = z.enum(["today", "7d", "month"]);
export type DashboardPeriod = z.infer<typeof DashboardPeriod>;

/** GET /api/admin/v1/dashboard?period=… (padrão: hoje). */
export const DashboardQuery = z.object({ period: DashboardPeriod.default("today") });
export type DashboardQuery = z.infer<typeof DashboardQuery>;

const Count = z.number().int().nonnegative();
/** Totais do período: podem passar do teto de uma cobrança (`Cents`) e podem ser zero. */
const TotalCents = z.number().int().nonnegative();

/**
 * Indicadores da página inicial do admin (spec F5C, A.3). `from`/`to` são datas locais da escola, inclusivas.
 * `documents` e `money` são `null` para a cozinha.
 */
export const DashboardResponse = z.object({
  period: DashboardPeriod,
  from: IsoDate,
  to: IsoDate,
  snacks: z.object({
    paidOrders: Count,
    deliveredOrders: Count,
    notCollectedOrders: Count,
    counterSales: Count,
    topItems: z.array(z.object({ name: z.string(), qty: Count })).max(5),
  }),
  documents: z
    .object({ published: Count, viewed: Count, batchesRendering: Count, batchesWithFailures: Count })
    .nullable(),
  money: z
    .object({ pixReceivedCents: TotalCents, counterCents: TotalCents, creditsCents: TotalCents, debtCents: TotalCents, debtors: Count })
    .nullable(),
});
export type DashboardResponse = z.infer<typeof DashboardResponse>;
