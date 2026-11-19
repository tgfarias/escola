import { describe, expect, it } from "vitest";
import { GuardianTopupRequest, StaffTopupRequest, TOPUP_MAX_CENTS, TOPUP_MIN_CENTS } from "./topups";

describe("topup contracts", () => {
  it("lets the guardian pay the debt without an amount", () => {
    expect(GuardianTopupRequest.parse({ purpose: "debt" })).toEqual({ purpose: "debt" });
    expect(() => GuardianTopupRequest.parse({ purpose: "debt", amountCents: 500 })).toThrow();
  });

  it("limits free credits to R$ 10,00 – R$ 1.000,00", () => {
    expect(GuardianTopupRequest.parse({ purpose: "credit", amountCents: TOPUP_MIN_CENTS })).toEqual({ purpose: "credit", amountCents: 1000 });
    expect(GuardianTopupRequest.parse({ purpose: "credit", amountCents: TOPUP_MAX_CENTS })).toEqual({ purpose: "credit", amountCents: 100000 });
    expect(() => GuardianTopupRequest.parse({ purpose: "credit", amountCents: 999 })).toThrow();
    expect(() => GuardianTopupRequest.parse({ purpose: "credit", amountCents: 100001 })).toThrow();
    expect(() => GuardianTopupRequest.parse({ purpose: "credit", amountCents: 1500.5 })).toThrow();
  });

  it("lets staff charge any positive amount up to R$ 10.000,00", () => {
    expect(StaffTopupRequest.parse({ amountCents: 1 })).toEqual({ amountCents: 1 });
    expect(() => StaffTopupRequest.parse({ amountCents: 0 })).toThrow();
    expect(() => StaffTopupRequest.parse({ amountCents: 1_000_001 })).toThrow();
  });
});
