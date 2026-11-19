import { z } from "zod";
import { PaymentView } from "./checkout";
import { Cents, IsoDateTime, Uuid } from "./common";

export const TopupStatus = z.enum(["pending_payment", "paid", "expired", "cancelled"]);
export type TopupStatus = z.infer<typeof TopupStatus>;

export const TOPUP_MIN_CENTS = 1000;
export const TOPUP_MAX_CENTS = 100_000;

/** POST /api/v1/topups — "Pagar débito" (o servidor usa o débito atual) ou "Adicionar créditos" (valor livre). */
export const GuardianTopupRequest = z.discriminatedUnion("purpose", [
  z.object({ purpose: z.literal("debt") }).strict(),
  z.object({ purpose: z.literal("credit"), amountCents: z.number().int().min(TOPUP_MIN_CENTS).max(TOPUP_MAX_CENTS) }).strict(),
]);
export type GuardianTopupRequest = z.infer<typeof GuardianTopupRequest>;

/** POST /api/admin/v1/guardians/:guardianId/topups — QR na tela do balcão. */
export const StaffTopupRequest = z.object({ amountCents: Cents }).strict();
export type StaffTopupRequest = z.infer<typeof StaffTopupRequest>;

export const TopupView = z.object({
  id: Uuid,
  status: TopupStatus,
  amountCents: Cents,
  createdAt: IsoDateTime,
  paidAt: IsoDateTime.nullable(),
  /** Saldo atual da carteira do responsável da recarga. */
  balanceCents: z.number().int(),
  payment: PaymentView.nullable(),
});
export type TopupView = z.infer<typeof TopupView>;
