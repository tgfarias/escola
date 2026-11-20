import { describe, expect, it } from "vitest";
import { DashboardQuery, DashboardResponse } from "./dashboard";

const SAMPLE = {
  period: "7d",
  from: "2026-11-14",
  to: "2026-11-20",
  snacks: { paidOrders: 42, deliveredOrders: 40, notCollectedOrders: 2, counterSales: 15, topItems: [{ name: "Misto quente", qty: 30 }] },
  documents: { published: 80, viewed: 61, batchesRendering: 0, batchesWithFailures: 1 },
  money: { pixReceivedCents: 125_000, counterCents: 22_500, creditsCents: 48_000, debtCents: 3_500, debtors: 3 },
};

describe("dashboard contracts", () => {
  it("defaults the period to today and refuses unknown periods", () => {
    expect(DashboardQuery.parse({})).toEqual({ period: "today" });
    expect(DashboardQuery.parse({ period: "month" })).toEqual({ period: "month" });
    expect(() => DashboardQuery.parse({ period: "year" })).toThrow();
  });

  it("accepts the spec example and the kitchen shape without documents and money", () => {
    expect(DashboardResponse.parse(SAMPLE)).toEqual(SAMPLE);
    expect(DashboardResponse.parse({ ...SAMPLE, documents: null, money: null }).money).toBeNull();
  });

  it("allows totals above the per-charge cap and zero, but no negatives, fractions or more than five top items", () => {
    expect(DashboardResponse.parse({ ...SAMPLE, money: { ...SAMPLE.money, pixReceivedCents: 50_000_000, debtCents: 0 } })).toBeTruthy();
    expect(() => DashboardResponse.parse({ ...SAMPLE, money: { ...SAMPLE.money, debtCents: -1 } })).toThrow();
    expect(() => DashboardResponse.parse({ ...SAMPLE, money: { ...SAMPLE.money, counterCents: 10.5 } })).toThrow();
    const six = Array.from({ length: 6 }, (_, i) => ({ name: `Item ${i}`, qty: 1 }));
    expect(() => DashboardResponse.parse({ ...SAMPLE, snacks: { ...SAMPLE.snacks, topItems: six } })).toThrow();
  });
});
