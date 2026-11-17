import { z } from "zod";
import { IsoDateTime, Uuid } from "./common";

export const WalletEntryKind = z.enum([
  "checkout_hold",
  "hold_release",
  "late_payment_credit",
  "cancel_credit",
  "refund",
  "manual_adjustment",
]);
export type WalletEntryKind = z.infer<typeof WalletEntryKind>;

export const WalletResponse = z.object({
  balanceCents: z.number().int().nonnegative(),
  entries: z.array(z.object({ id: Uuid, kind: WalletEntryKind, amountCents: z.number().int(), createdAt: IsoDateTime })),
});
export type WalletResponse = z.infer<typeof WalletResponse>;

export const WalletAdjustmentRequest = z.object({
  amountCents: z
    .number()
    .int()
    .min(-1_000_000)
    .max(1_000_000)
    .refine((v) => v !== 0, "zero adjustment"),
  reason: z.string().trim().min(1).max(200),
});
export type WalletAdjustmentRequest = z.infer<typeof WalletAdjustmentRequest>;

export const WalletAdjustmentResponse = z.object({ balanceCents: z.number().int().nonnegative() });
export type WalletAdjustmentResponse = z.infer<typeof WalletAdjustmentResponse>;
