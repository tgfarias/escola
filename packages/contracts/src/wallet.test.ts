import { describe, expect, it } from "vitest";
import { AccountListResponse, SchoolSettings, WalletAdjustmentResponse, WalletEntryKind } from "./wallet";

describe("wallet contracts", () => {
  it("knows the counter and top-up entry kinds", () => {
    for (const k of ["counter_charge", "counter_void", "topup_credit"]) expect(WalletEntryKind.parse(k)).toBe(k);
  });

  it("allows a negative balance", () => {
    expect(WalletAdjustmentResponse.parse({ balanceCents: -1500 })).toEqual({ balanceCents: -1500 });
    const list = { debtLimitCents: 5000, accounts: [{ guardianId: "0193a3b0-0000-7000-8000-000000000001", firstName: "Ana", students: ["Léo"], balanceCents: -1200 }], overLimitSales: [] };
    expect(AccountListResponse.parse(list)).toEqual(list);
  });

  it("bounds the school debt limit", () => {
    expect(SchoolSettings.parse({ debtLimitCents: 0 })).toEqual({ debtLimitCents: 0 });
    expect(() => SchoolSettings.parse({ debtLimitCents: -1 })).toThrow();
    expect(() => SchoolSettings.parse({ debtLimitCents: 1_000_001 })).toThrow();
  });
});
