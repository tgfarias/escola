import { describe, expect, it } from "vitest";
import { getSecret } from "./secrets";

describe("getSecret", () => {
  it("reads a secret mapped into the environment", () => {
    expect(getSecret("PAYMENT_WEBHOOK_SECRET_TEST")).toBe(process.env.PAYMENT_WEBHOOK_SECRET_TEST);
  });
  it("rejects malformed references, missing and short secrets without echoing values", () => {
    expect(() => getSecret("path/../etc")).toThrow(/invalid secret reference/);
    expect(() => getSecret("MISSING_SECRET_REF")).toThrow(/MISSING_SECRET_REF/);
    process.env.SHORT_SECRET_REF = "short-value";
    expect(() => getSecret("SHORT_SECRET_REF")).toThrow(/SHORT_SECRET_REF/);
    expect(() => getSecret("SHORT_SECRET_REF")).not.toThrow(/short-value/);
  });
});
