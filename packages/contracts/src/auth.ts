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

export const StaffOtpRequest = z.object({ email: z.string().email().max(200) });
export type StaffOtpRequest = z.infer<typeof StaffOtpRequest>;

export const StaffOtpRequestResponse = z.object({ otpToken: z.string() });
export type StaffOtpRequestResponse = z.infer<typeof StaffOtpRequestResponse>;

export const StaffOtpVerifyResponse = z.object({ status: z.literal("ok"), role: StaffRole });
export type StaffOtpVerifyResponse = z.infer<typeof StaffOtpVerifyResponse>;

export const StaffMeResponse = z.object({
  id: z.string().uuid(),
  email: z.string(),
  role: StaffRole,
  schoolName: z.string(),
});
export type StaffMeResponse = z.infer<typeof StaffMeResponse>;
