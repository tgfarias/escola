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
