import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { config, resetConfigForTests } from "./config";

const valid = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  INTERNAL_SERVICE_TOKEN: "s".repeat(32),
  INTERNAL_HMAC_SECRET: "h".repeat(32),
  SESSION_SECRET: "e".repeat(32),
  APP_BASE_URL: "https://app.example.com",
};

describe("config", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    resetConfigForTests();
  });

  afterEach(() => {
    process.env = { ...saved };
    resetConfigForTests();
  });

  function setEnv(overrides: Record<string, string | undefined> = {}) {
    process.env = { ...saved, ...valid, ...overrides } as NodeJS.ProcessEnv;
    for (const [k, v] of Object.entries(overrides)) if (v === undefined) delete process.env[k];
  }

  it("parses a valid environment", () => {
    setEnv();
    expect(config()).toEqual({
      databaseUrl: valid.DATABASE_URL,
      internalServiceToken: valid.INTERNAL_SERVICE_TOKEN,
      internalHmacSecret: valid.INTERNAL_HMAC_SECRET,
      sessionSecret: valid.SESSION_SECRET,
      appBaseUrl: valid.APP_BASE_URL,
      paymentProvider: "fake",
      fakePaymentsEnabled: true,
      efiEnv: "homologacao",
      efiPlatformAccount: null,
    });
  });

  it("refuses the fake payment provider unless ENABLE_FAKE_PAYMENTS is true", () => {
    setEnv({ PAYMENT_PROVIDER: undefined, ENABLE_FAKE_PAYMENTS: "false" });
    expect(() => config()).toThrow(/PAYMENT_PROVIDER/);
    resetConfigForTests();
    setEnv({ PAYMENT_PROVIDER: undefined, ENABLE_FAKE_PAYMENTS: undefined });
    expect(() => config()).toThrow(/PAYMENT_PROVIDER/);
  });

  it("enables the fake payment provider explicitly", () => {
    setEnv({ PAYMENT_PROVIDER: undefined, ENABLE_FAKE_PAYMENTS: "true" });
    expect(config().fakePaymentsEnabled).toBe(true);
    expect(config().paymentProvider).toBe("fake");
  });

  it("starts with the efi provider without ENABLE_FAKE_PAYMENTS and defaults EFI_ENV to homologacao", () => {
    setEnv({ PAYMENT_PROVIDER: "efi", ENABLE_FAKE_PAYMENTS: undefined });
    expect(config().paymentProvider).toBe("efi");
    expect(config().efiEnv).toBe("homologacao");
  });

  it("validates EFI_PLATFORM_ACCOUNT, naming the variable", () => {
    setEnv({ EFI_PLATFORM_ACCOUNT: JSON.stringify({ document_type: "rg", document: "12", account: "1" }) });
    expect(() => config()).toThrow(/EFI_PLATFORM_ACCOUNT/);
    resetConfigForTests();
    setEnv({ EFI_PLATFORM_ACCOUNT: "not json" });
    expect(() => config()).toThrow(/EFI_PLATFORM_ACCOUNT/);
    resetConfigForTests();
    setEnv({ EFI_PLATFORM_ACCOUNT: JSON.stringify({ document_type: "cnpj", document: "12345678000190", account: "123456" }) });
    expect(config().efiPlatformAccount).toEqual({ documentType: "cnpj", document: "12345678000190", account: "123456" });
  });

  it("rejects a short secret, naming the variable but not leaking its value", () => {
    setEnv({ INTERNAL_HMAC_SECRET: "too-short-secret" });
    expect(() => config()).toThrow(/INTERNAL_HMAC_SECRET/);
    expect(() => config()).not.toThrow(/too-short-secret/);
  });

  it("rejects a missing DATABASE_URL", () => {
    setEnv({ DATABASE_URL: undefined });
    expect(() => config()).toThrow(/DATABASE_URL/);
  });

  it("strips the trailing slash from APP_BASE_URL", () => {
    setEnv({ APP_BASE_URL: "https://app.example.com/" });
    expect(config().appBaseUrl).toBe("https://app.example.com");
  });
});
