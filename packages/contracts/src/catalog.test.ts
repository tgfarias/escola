import { describe, expect, it } from "vitest";
import {
  GuardianMenuResponse,
  GuardianServiceDay,
  GuardianServiceDayListResponse,
  ServiceDay,
  ServiceDayListResponse,
  UpsertServiceDayRequest,
} from "./catalog";

const ITEM = { menuItemId: "0193a3b0-0000-7000-8000-000000000001", name: "Misto quente", priceCents: 900 };

describe("catalog contracts", () => {
  it("accepts a cutoff per shift and defaults to none", () => {
    expect(UpsertServiceDayRequest.parse({ items: [{ menuItemId: ITEM.menuItemId }] }).cutoffTimes).toEqual({});
    expect(
      UpsertServiceDayRequest.parse({ cutoffTimes: { vespertino: "13:30" }, items: [{ menuItemId: ITEM.menuItemId }] }).cutoffTimes,
    ).toEqual({ vespertino: "13:30" });
    expect(() => UpsertServiceDayRequest.parse({ cutoffTimes: { noite: "19:00" }, items: [{ menuItemId: ITEM.menuItemId }] })).toThrow();
    expect(() => UpsertServiceDayRequest.parse({ cutoffTimes: { matutino: "7:30" }, items: [{ menuItemId: ITEM.menuItemId }] })).toThrow();
  });

  it("accepts the spec B.2 example of a day with two shifts", () => {
    const example = {
      serviceDate: "2026-11-23",
      cutoffAt: "2026-11-23T16:00:00.000Z",
      freezeAt: "2026-11-23T16:05:00.000Z",
      status: "open",
      shifts: [
        { shift: "matutino", cutoffAt: "2026-11-23T10:30:00.000Z", freezeAt: "2026-11-23T10:35:00.000Z", status: "closed" },
        { shift: "vespertino", cutoffAt: "2026-11-23T16:00:00.000Z", freezeAt: "2026-11-23T16:05:00.000Z", status: "open" },
      ],
      items: [ITEM],
    };
    expect(ServiceDay.parse(example)).toEqual(example);
    expect(ServiceDayListResponse.parse({ serviceDays: [example] })).toEqual({ serviceDays: [example] });
    expect(() => ServiceDay.parse({ ...example, shifts: [] })).toThrow();
    expect(() => ServiceDay.parse({ ...example, shifts: [{ ...example.shifts[0], status: "done" }] })).toThrow();
    const guardian = {
      serviceDate: example.serviceDate,
      cutoffAt: example.cutoffAt,
      items: [ITEM],
      shifts: [{ shift: "vespertino", cutoffAt: "2026-11-23T16:00:00.000Z", acceptingOrders: true }],
    };
    expect(GuardianServiceDay.parse(guardian)).toEqual(guardian);
    expect(GuardianServiceDayListResponse.parse({ serviceDays: [guardian] })).toEqual({ serviceDays: [guardian] });
    expect(() => GuardianServiceDay.parse({ ...guardian, shifts: [] })).toThrow();
  });

  it("accepts the spec B.2 example of a guardian menu", () => {
    const menu = {
      serviceDate: "2026-11-23",
      cutoffAt: "2026-11-23T16:00:00.000Z",
      acceptingOrders: true,
      items: [ITEM],
      shifts: [
        { shift: "matutino", cutoffAt: "2026-11-23T10:30:00.000Z", acceptingOrders: false },
        { shift: "vespertino", cutoffAt: "2026-11-23T16:00:00.000Z", acceptingOrders: true },
      ],
    };
    expect(GuardianMenuResponse.parse(menu)).toEqual(menu);
  });
});
