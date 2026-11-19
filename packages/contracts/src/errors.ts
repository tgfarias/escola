import { z } from "zod";

export const errorCodes = [
  "validation_failed",
  "unauthenticated",
  "insufficient_scope",
  "origin_rejected",
  "not_found",
  "invalid_token",
  "otp_invalid",
  "otp_expired",
  "otp_too_many_attempts",
  "invalid_signature",
  "payload_too_large",
  "request_rejected",
  "idempotency_key_required",
  "idempotency_key_reused",
  "cutoff_passed",
  "service_day_locked",
  "service_day_open",
  "menu_item_name_taken",
  "insufficient_balance",
  "order_already_exists",
  "checkout_not_cancellable",
  "invalid_order",
  "document_template_invalid",
  "document_template_outdated",
  "document_missing_data",
  "document_batch_not_ready",
  "document_batch_published",
  "internal_error",
] as const;

export const ErrorCode = z.enum(errorCodes);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorResponse = z.object({
  error: z.object({ code: ErrorCode, message: z.string(), details: z.record(z.string(), z.unknown()).optional() }),
});

export type ErrorResponse = z.infer<typeof ErrorResponse>;
