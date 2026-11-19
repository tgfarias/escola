import { z } from "zod";
import { Cents, IsoDateTime, Uuid } from "./common";

export const WalletEntryKind = z.enum([
  "checkout_hold",
  "hold_release",
  "late_payment_credit",
  "cancel_credit",
  "refund",
  "manual_adjustment",
  "counter_charge",
  "counter_void",
  "topup_credit",
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

export const WalletAdjustmentResponse = z.object({ balanceCents: z.number().int() });
export type WalletAdjustmentResponse = z.infer<typeof WalletAdjustmentResponse>;

/** Linha de extrato: lançamento do balcão traz o aluno, o selo de ultrapassagem e se foi estornado. */
export const StatementEntry = z.object({
  id: Uuid,
  kind: WalletEntryKind,
  amountCents: z.number().int(),
  createdAt: IsoDateTime,
  saleId: Uuid.nullable(),
  studentFirstName: z.string().nullable(),
  overLimit: z.boolean(),
  voided: z.boolean(),
});
export type StatementEntry = z.infer<typeof StatementEntry>;

/** GET /api/admin/v1/accounts — débitos primeiro; `students` = alunos de quem ele é o financeiro. */
export const AccountListResponse = z.object({
  debtLimitCents: z.number().int().nonnegative(),
  accounts: z.array(z.object({ guardianId: Uuid, firstName: z.string(), students: z.array(z.string()), balanceCents: z.number().int() })),
  overLimitSales: z.array(
    z.object({
      saleId: Uuid,
      guardianId: Uuid,
      guardianFirstName: z.string(),
      studentFirstName: z.string(),
      occurredAt: IsoDateTime,
      totalCents: Cents,
    }),
  ),
});
export type AccountListResponse = z.infer<typeof AccountListResponse>;

/** GET /api/admin/v1/guardians/:guardianId/statement */
export const AccountStatementResponse = z.object({
  guardian: z.object({ id: Uuid, firstName: z.string() }),
  balanceCents: z.number().int(),
  debtLimitCents: z.number().int().nonnegative(),
  entries: z.array(StatementEntry),
});
export type AccountStatementResponse = z.infer<typeof AccountStatementResponse>;

/** GET/PUT /api/admin/v1/school/settings */
export const SchoolSettings = z.object({ debtLimitCents: z.number().int().min(0).max(1_000_000) }).strict();
export type SchoolSettings = z.infer<typeof SchoolSettings>;

/** POST /api/admin/v1/guardians/:guardianId/payment-requests */
export const PaymentRequestResponse = z.object({ amountDueCents: Cents });
export type PaymentRequestResponse = z.infer<typeof PaymentRequestResponse>;
