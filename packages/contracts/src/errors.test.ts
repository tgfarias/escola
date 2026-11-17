import { describe, expect, it } from "vitest";
import { ErrorResponse } from "./index";

describe("ErrorResponse", () => {
  it("accepts a known error code", () => {
    const parsed = ErrorResponse.parse({ error: { code: "not_found", message: "x" } });
    expect(parsed.error.code).toBe("not_found");
  });

  it("rejects an unknown error code", () => {
    expect(() => ErrorResponse.parse({ error: { code: "whatever", message: "x" } })).toThrow();
  });
});
