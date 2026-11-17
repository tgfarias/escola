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

/** Novos tipos de evento entram nesta união. */
export const OutboxEvent = z.discriminatedUnion("type", [OtpRequestedEvent]);
export type OutboxEvent = z.infer<typeof OutboxEvent>;

export const OutboxEnvelope = z.object({
  id: z.string().uuid(),
  type: z.string(),
  school_id: z.string().uuid(),
  occurred_at: z.string().datetime({ offset: true }),
  data: z.record(z.string(), z.unknown()),
});
export type OutboxEnvelope = z.infer<typeof OutboxEnvelope>;
