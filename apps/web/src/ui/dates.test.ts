import { describe, expect, it } from "vitest";
import { formatIsoDate } from "./dates";

describe("dates", () => {
  it("formats a civil date without time zone shifts", () => {
    expect(formatIsoDate("2021-03-05")).toBe("05/03/2021");
  });
});
