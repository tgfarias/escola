import { z } from "zod";
import { IsoDate, IsoDateTime, Uuid } from "./common";

/** POST /internal/v1/schools/{school_id}/magic-links (spec 6.2). */
export const InternalMagicLinkRequest = z
  .object({
    guardian_id: Uuid,
    scope: z.enum(["order", "documents"]),
    service_date: IsoDate.optional(),
  })
  .strict()
  .refine((b) => (b.scope === "order") === (b.service_date !== undefined), {
    message: "service_date is required for order links and not allowed for document links",
  });
export type InternalMagicLinkRequest = z.infer<typeof InternalMagicLinkRequest>;

export const InternalMagicLinkResponse = z.object({
  link_url: z.string().url(),
  expires_at: IsoDateTime,
});
export type InternalMagicLinkResponse = z.infer<typeof InternalMagicLinkResponse>;

export const DueActionName = z.enum(["send_reminders", "close_service_day"]);

/** GET /internal/v1/schedule/due */
export const ScheduleDueResponse = z.object({
  due: z.array(z.object({ action: DueActionName, school_id: Uuid, service_date: IsoDate })),
});
export type ScheduleDueResponse = z.infer<typeof ScheduleDueResponse>;

/** POST /internal/v1/schools/{school_id}/reminders/prepare */
export const RemindersPrepareRequest = z.object({ service_date: IsoDate, cursor: Uuid.nullable() }).strict();
export type RemindersPrepareRequest = z.infer<typeof RemindersPrepareRequest>;

export const ReminderRecipient = z.object({
  guardian_id: Uuid,
  phone: z.string(),
  first_name: z.string(),
  students: z.array(z.string()).min(1),
  link_url: z.string().url(),
  wallet_balance_cents: z.number().int().nonnegative(),
  cutoff_at: IsoDateTime,
  cutoff_local_time: z.string().regex(/^\d{2}:\d{2}$/),
});
export type ReminderRecipient = z.infer<typeof ReminderRecipient>;

export const RemindersPrepareResponse = z.object({
  batch_id: Uuid,
  next_cursor: Uuid.nullable(),
  recipients: z.array(ReminderRecipient).max(200),
});
export type RemindersPrepareResponse = z.infer<typeof RemindersPrepareResponse>;

/** POST /internal/v1/schools/{school_id}/reminders/{batch_id}/deliveries → 204 */
export const DeliveryResult = z.discriminatedUnion("status", [
  z.object({ guardian_id: Uuid, status: z.literal("sent"), wa_message_id: z.string().min(1).max(200) }).strict(),
  z.object({ guardian_id: Uuid, status: z.literal("failed"), error: z.string().regex(/^[a-z0-9_]{1,64}$/) }).strict(),
]);
export type DeliveryResult = z.infer<typeof DeliveryResult>;

export const DeliveriesRequest = z.object({ results: z.array(DeliveryResult).min(1).max(200) }).strict();
export type DeliveriesRequest = z.infer<typeof DeliveriesRequest>;

export const JobDispatchResponse = z.object({
  schools: z.number().int().nonnegative(),
  delivered: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  abandoned: z.number().int().nonnegative(),
});
export type JobDispatchResponse = z.infer<typeof JobDispatchResponse>;

export const SafetyCloseResponse = z.object({ closed: z.number().int().nonnegative(), failed: z.number().int().nonnegative() });
export type SafetyCloseResponse = z.infer<typeof SafetyCloseResponse>;
