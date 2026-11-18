import { describe, expect, it } from "vitest";
import { chunk, isNewer, mergeEvent } from "./state";

const at = (s: string) => `2031-11-05T10:00:${s}.000Z`;

describe("kds state", () => {
  it("prefers the later occurredAt", () => {
    expect(isNewer({ occurredAt: at("05"), eventId: "a" }, { occurredAt: at("04"), eventId: "z" })).toBe(true);
    expect(isNewer({ occurredAt: at("04"), eventId: "z" }, { occurredAt: at("05"), eventId: "a" })).toBe(false);
  });

  it("breaks a tie by the greater eventId", () => {
    expect(isNewer({ occurredAt: at("05"), eventId: "b" }, { occurredAt: at("05"), eventId: "a" })).toBe(true);
    expect(isNewer({ occurredAt: at("05"), eventId: "a" }, { occurredAt: at("05"), eventId: "a" })).toBe(false);
  });

  it("compares instants, not strings with different offsets", () => {
    expect(isNewer({ occurredAt: "2031-11-05T07:00:06-03:00", eventId: "a" }, { occurredAt: at("05"), eventId: "z" })).toBe(true);
  });

  it("merges only newer events", () => {
    const cur = mergeEvent(undefined, { eventId: "b", orderId: "o", type: "delivered", occurredAt: at("05") }, "2031-11-05")!;
    expect(cur.state).toBe("delivered");
    expect(mergeEvent(cur, { eventId: "a", orderId: "o", type: "undelivered", occurredAt: at("05") }, "2031-11-05")).toBeUndefined();
    expect(mergeEvent(cur, { eventId: "c", orderId: "o", type: "undelivered", occurredAt: at("05") }, "2031-11-05")?.state).toBe("pending");
  });

  it("chunks batches of 100", () => {
    expect(chunk(Array.from({ length: 250 }, (_, i) => i), 100).map((c) => c.length)).toEqual([100, 100, 50]);
    expect(chunk([], 100)).toEqual([]);
  });
});
