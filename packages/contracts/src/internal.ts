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
