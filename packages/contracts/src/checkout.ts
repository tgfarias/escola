import { z } from "zod";
import { Cents, IsoDate, IsoDateTime, Uuid } from "./common";

export const CheckoutStatus = z.enum(["pending_payment", "paid", "expired", "late_credited", "cancelled"]);
export type CheckoutStatus = z.infer<typeof CheckoutStatus>;
export const OrderStatus = z.enum(["pending", "confirmed", "delivered", "expired", "expired_late", "cancelled"]);
export type OrderStatus = z.infer<typeof OrderStatus>;
export const PaymentStatus = z.enum(["pending", "paid", "expired", "refunded"]);
export type PaymentStatus = z.infer<typeof PaymentStatus>;

export const CreateCheckoutRequest = z.object({
  serviceDate: IsoDate,
  orders: z
    .array(
      z.object({
        studentId: Uuid,
        items: z.array(z.object({ menuItemId: Uuid, qty: z.number().int().min(1).max(10) })).min(1).max(10),
      }),
    )
    .min(1)
    .max(10),
});
export type CreateCheckoutRequest = z.infer<typeof CreateCheckoutRequest>;

export const PaymentView = z.object({
  status: PaymentStatus,
  amountCents: Cents,
  pixCopyPaste: z.string().nullable(),
  pixQrPngBase64: z.string().nullable(),
  expiresAt: IsoDateTime,
});
export type PaymentView = z.infer<typeof PaymentView>;

export const CheckoutView = z.object({
  id: Uuid,
  serviceDate: IsoDate,
  cutoffAt: IsoDateTime,
  status: CheckoutStatus,
  totalCents: Cents,
  walletAppliedCents: z.number().int().nonnegative(),
  amountDueCents: z.number().int().nonnegative(),
  orders: z.array(
    z.object({
      id: Uuid,
      studentId: Uuid,
      studentFirstName: z.string(),
      status: OrderStatus,
      items: z.array(z.object({ menuItemId: Uuid, name: z.string(), qty: z.number().int().positive(), unitPriceCents: Cents })),
    }),
  ),
  payment: PaymentView.nullable(),
});
export type CheckoutView = z.infer<typeof CheckoutView>;

export const CheckoutListResponse = z.object({ checkouts: z.array(CheckoutView) });
export type CheckoutListResponse = z.infer<typeof CheckoutListResponse>;

export const CheckoutListQuery = z.object({ serviceDate: IsoDate });
