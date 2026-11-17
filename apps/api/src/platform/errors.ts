import type { ErrorCode } from "@app-lanche/contracts";

const STATUS: Record<ErrorCode, number> = {
  validation_failed: 400,
  unauthenticated: 401,
  insufficient_scope: 403,
  origin_rejected: 403,
  not_found: 404,
  invalid_token: 401,
  otp_invalid: 401,
  otp_expired: 401,
  otp_too_many_attempts: 429,
  invalid_signature: 401,
  payload_too_large: 413,
  request_rejected: 400,
  idempotency_key_required: 400,
  idempotency_key_reused: 422,
  cutoff_passed: 409,
  service_day_locked: 409,
  menu_item_name_taken: 409,
  insufficient_balance: 409,
  order_already_exists: 409,
  checkout_not_cancellable: 409,
  invalid_order: 422,
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

/** Violação de UNIQUE (23505) de uma constraint ou índice específico. */
export function isUniqueViolation(err: unknown, constraint: string): boolean {
  const e = err as { code?: unknown; constraint?: unknown } | null;
  return e?.code === "23505" && e.constraint === constraint;
}
