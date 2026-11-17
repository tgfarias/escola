import { z } from "zod";

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

export const ManifestResponse = ManifestContent.extend({
  status: z.literal("closed"),
  closed_at: z.string().datetime({ offset: true }),
  manifest_version: z.number().int().positive(),
  kitchen_phone: z.string().nullable(),
});
export type ManifestResponse = z.infer<typeof ManifestResponse>;
