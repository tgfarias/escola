import { describe, expect, it } from "vitest";
import { ErrorResponse } from "./index";

describe("ErrorResponse", () => {
  it("accepts a known error code", () => {
    const parsed = ErrorResponse.parse({ error: { code: "not_found", message: "x" } });
    expect(parsed.error.code).toBe("not_found");
  });

  it("accepts optional details", () => {
    const parsed = ErrorResponse.parse({ error: { code: "document_missing_data", message: "x", details: { missing: [] } } });
    expect(parsed.error.details).toEqual({ missing: [] });
  });

  it("accepts shift_not_offered", () => {
    expect(ErrorResponse.parse({ error: { code: "shift_not_offered", message: "x" } }).error.code).toBe("shift_not_offered");
  });

  it("rejects an unknown error code", () => {
    expect(() => ErrorResponse.parse({ error: { code: "whatever", message: "x" } })).toThrow();
  });
});
