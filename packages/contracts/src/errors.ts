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
  "internal_error",
] as const;

export const ErrorCode = z.enum(errorCodes);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorResponse = z.object({
  error: z.object({ code: ErrorCode, message: z.string() }),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;
