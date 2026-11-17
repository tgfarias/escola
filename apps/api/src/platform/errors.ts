import type { ErrorCode } from "@app-lanche/contracts";

const STATUS: Record<ErrorCode, number> = {
  validation_failed: 400,
  unauthenticated: 401,
  insufficient_scope: 403,
  not_found: 404,
  invalid_token: 401,
  otp_invalid: 401,
  otp_expired: 401,
  otp_too_many_attempts: 429,
  invalid_signature: 401,
  payload_too_large: 413,
  request_rejected: 400,
  internal_error: 500,
};

export class DomainError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message?: string,
  ) {
    super(message ?? code);
  }

  get status(): number {
    return STATUS[this.code];
  }
}
