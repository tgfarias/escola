import { describe, expect, it } from "vitest";
import { CounterSaleItems, StaffCounterSaleRequest } from "./counter";
import { KdsCounterSalesRequest, KdsCounterVoidsRequest } from "./kds";

const A = "0193a3b0-0000-7000-8000-000000000001";
const B = "0193a3b0-0000-7000-8000-000000000002";

describe("counter contracts", () => {
  it("accepts items and quantities only, without prices", () => {
    expect(CounterSaleItems.parse([{ menuItemId: A, qty: 2 }])).toEqual([{ menuItemId: A, qty: 2 }]);
    expect(() => CounterSaleItems.parse([{ menuItemId: A, qty: 2, priceCents: 1 }])).not.toThrow();
    expect(CounterSaleItems.parse([{ menuItemId: A, qty: 2, priceCents: 1 }])).toEqual([{ menuItemId: A, qty: 2 }]);
  });

  it("rejects repeated items, empty sales and quantities out of range", () => {
    expect(() => CounterSaleItems.parse([{ menuItemId: A, qty: 1 }, { menuItemId: A, qty: 1 }])).toThrow();
    expect(() => CounterSaleItems.parse([])).toThrow();
    expect(() => CounterSaleItems.parse([{ menuItemId: A, qty: 11 }])).toThrow();
  });

  it("takes the over-limit confirmation only from staff", () => {
    const body = { studentId: B, items: [{ menuItemId: A, qty: 1 }], allowOverLimit: true };
    expect(StaffCounterSaleRequest.parse(body)).toEqual(body);
    expect(() => StaffCounterSaleRequest.parse({ ...body, guardianId: A })).toThrow();
  });

  it("caps tablet batches at 100", () => {
    const sale = { id: A, studentId: B, items: [{ menuItemId: A, qty: 1 }], occurredAt: "2026-11-19T10:05:00-03:00" };
    expect(KdsCounterSalesRequest.parse({ sales: [sale] })).toEqual({ sales: [sale] });
    expect(() => KdsCounterSalesRequest.parse({ sales: Array.from({ length: 101 }, () => sale) })).toThrow();
    const v = { saleId: A, occurredAt: "2026-11-19T10:06:00-03:00" };
    expect(KdsCounterVoidsRequest.parse({ voids: [v] })).toEqual({ voids: [v] });
    expect(() => KdsCounterVoidsRequest.parse({ voids: [] })).toThrow();
  });
});
