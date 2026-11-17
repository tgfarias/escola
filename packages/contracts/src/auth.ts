import { z } from "zod";

export const GuardianScope = z.enum(["order", "documents"]);
export type GuardianScope = z.infer<typeof GuardianScope>;

export const StaffRole = z.enum(["admin", "secretaria", "cozinha"]);
export type StaffRole = z.infer<typeof StaffRole>;

export const ExchangeRequest = z.object({
  token: z.string().min(20).max(200),
  deviceSecret: z.string().min(32).max(200),
});
export type ExchangeRequest = z.infer<typeof ExchangeRequest>;

export const ExchangeResponse = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), scope: GuardianScope }),
  z.object({ status: z.literal("step_up_required"), otpToken: z.string() }),
]);
export type ExchangeResponse = z.infer<typeof ExchangeResponse>;

export const OtpVerifyRequest = z.object({
  otpToken: z.string().min(1),
  code: z.string().regex(/^\d{6}$/),
});
export type OtpVerifyRequest = z.infer<typeof OtpVerifyRequest>;

export const OtpVerifyResponse = z.object({ status: z.literal("ok"), scope: GuardianScope });
export type OtpVerifyResponse = z.infer<typeof OtpVerifyResponse>;

export const MeResponse = z.object({
  guardian: z.object({ id: z.string().uuid(), firstName: z.string() }),
  students: z.array(
    z.object({ id: z.string().uuid(), firstName: z.string(), className: z.string() }),
  ),
});
export type MeResponse = z.infer<typeof MeResponse>;
