import { z } from "zod";

export const OtpRequestedEvent = z.object({
  type: z.literal("auth.otp_requested"),
  data: z.object({
    channel: z.enum(["whatsapp", "email"]),
    to: z.string(),
    first_name: z.string().nullable(),
    code: z.string().regex(/^\d{6}$/),
    expires_at: z.string().datetime({ offset: true }),
  }),
});

export const PaymentConfirmedEvent = z.object({
  type: z.literal("payment.confirmed"),
  data: z.object({
    guardian_id: z.string().uuid(),
    phone: z.string(),
    first_name: z.string(),
    checkout_id: z.string().uuid(),
    service_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    students: z.array(z.string()).min(1),
    total_cents: z.number().int().positive(),
  }),
});

export const PaymentLateCreditedEvent = z.object({
  type: z.literal("payment.late_credited"),
  data: z.object({
    guardian_id: z.string().uuid(),
    phone: z.string(),
    first_name: z.string(),
    amount_cents: z.number().int().positive(),
    wallet_balance_cents: z.number().int(),
  }),
});

export const ServiceDayClosedEvent = z.object({
  type: z.literal("service_day.closed"),
  data: z.object({
    service_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    orders: z.number().int().nonnegative(),
    late_credits: z.number().int().nonnegative(),
  }),
});

export const DocumentPublishedEvent = z.object({
  type: z.literal("document.published"),
  data: z.object({
    guardian_id: z.string().uuid(),
    phone: z.string(),
    first_name: z.string(),
    batch_id: z.string().uuid(),
    template_name: z.string().min(1),
    students: z.array(z.string()).min(1),
  }),
});

const WalletContact = { guardian_id: z.string().uuid(), phone: z.string(), first_name: z.string() };

/** Saldo passou a negativo (na hora) ou segue negativo (a cada 3 dias). O n8n pede o link de escopo `wallet`. */
export const WalletDebtNoticeEvent = z.object({
  type: z.literal("wallet.debt_notice"),
  data: z.object({ ...WalletContact, amount_due_cents: z.number().int().positive() }),
});

/** Link de pagamento enviado a pedido da secretaria. */
export const WalletPaymentRequestedEvent = z.object({
  type: z.literal("wallet.payment_requested"),
  data: z.object({ ...WalletContact, amount_due_cents: z.number().int().positive() }),
});

export const WalletTopupConfirmedEvent = z.object({
  type: z.literal("wallet.topup_confirmed"),
  data: z.object({ ...WalletContact, amount_cents: z.number().int().positive(), wallet_balance_cents: z.number().int() }),
});

/** Novos tipos de evento entram nesta união. */
export const OutboxEvent = z.discriminatedUnion("type", [OtpRequestedEvent, PaymentConfirmedEvent, PaymentLateCreditedEvent, ServiceDayClosedEvent, DocumentPublishedEvent, WalletDebtNoticeEvent, WalletPaymentRequestedEvent, WalletTopupConfirmedEvent]);
export type OutboxEvent = z.infer<typeof OutboxEvent>;

export const OutboxEnvelope = z.object({
  id: z.string().uuid(),
  type: z.string(),
  school_id: z.string().uuid(),
  occurred_at: z.string().datetime({ offset: true }),
  data: z.record(z.string(), z.unknown()),
});
export type OutboxEnvelope = z.infer<typeof OutboxEnvelope>;
