import { describe, expect, it } from "vitest";
import { KdsEventsRequest, KdsPairRequest, PAIRING_ALPHABET } from "./kds";

const E = "0193a3b0-0000-7000-8000-000000000001";

describe("kds contracts", () => {
  it("normalizes a typed pairing code", () => {
    expect(KdsPairRequest.parse({ code: " abcd2345 " })).toEqual({ code: "ABCD2345" });
  });

  it("rejects ambiguous characters in a pairing code", () => {
    for (const code of ["ABCD234O", "ABCD2341", "ABCDEFGI", "ABCDEFGL", "ABC"]) {
      expect(() => KdsPairRequest.parse({ code })).toThrow();
    }
    expect(PAIRING_ALPHABET).toHaveLength(31);
  });

  it("accepts the delivery event example from spec 7.3 and caps a batch at 100", () => {
    const ev = { eventId: E, orderId: E, type: "delivered", occurredAt: "2026-11-17T10:05:00-03:00" };
    expect(KdsEventsRequest.parse({ events: [ev] })).toEqual({ events: [ev] });
    expect(() => KdsEventsRequest.parse({ events: Array.from({ length: 101 }, () => ev) })).toThrow();
    expect(() => KdsEventsRequest.parse({ events: [] })).toThrow();
  });
});
