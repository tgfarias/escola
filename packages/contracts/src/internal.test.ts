import { describe, expect, it } from "vitest";
import { InternalMagicLinkRequest, InternalMagicLinkResponse, ScheduleDueResponse } from "./internal";

const G = "0193a3b0-0000-7000-8000-000000000001";

describe("internal contracts", () => {
  it("accepts the magic-link examples from spec 6.2", () => {
    const req = { guardian_id: G, scope: "order", service_date: "2026-11-17" };
    expect(InternalMagicLinkRequest.parse(req)).toEqual(req);
    const res = { link_url: "https://app.example/l#Zk3", expires_at: "2026-11-17T07:30:00-03:00" };
    expect(InternalMagicLinkResponse.parse(res)).toEqual(res);
  });

  it("rejects a school_id in the body and a date on document links", () => {
    expect(() => InternalMagicLinkRequest.parse({ school_id: G, guardian_id: G, scope: "order", service_date: "2026-11-17" })).toThrow();
    expect(() => InternalMagicLinkRequest.parse({ guardian_id: G, scope: "documents", service_date: "2026-11-17" })).toThrow();
    expect(() => InternalMagicLinkRequest.parse({ guardian_id: G, scope: "order" })).toThrow();
  });

  it("accepts the schedule example from spec 6.2", () => {
    const example = {
      due: [
        { action: "send_reminders", school_id: G, service_date: "2026-11-17" },
        { action: "close_service_day", school_id: G, service_date: "2026-11-17" },
      ],
    };
    expect(ScheduleDueResponse.parse(example)).toEqual(example);
  });
});
