import { describe, expect, it } from "vitest";
import { MeResponse } from "./auth";
import { CheckoutView, OrderStatus } from "./checkout";

const BIA = "0193a000-0000-7000-8000-000000000012";

describe("checkout contracts per shift", () => {
  it("accepts the spec B.2 example of a guardian's children with their shifts", () => {
    const example = {
      guardian: { id: "0193a000-0000-7000-8000-000000000010", firstName: "Ana" },
      students: [
        { id: "0193a000-0000-7000-8000-000000000011", firstName: "Léo", className: "Infantil 3A", shift: "matutino" },
        { id: BIA, firstName: "Bia", className: "Infantil 5C", shift: "vespertino" },
      ],
      walletBalanceCents: 0,
    };
    expect(MeResponse.parse(example)).toEqual(example);
    expect(() => MeResponse.parse({ ...example, students: [{ ...example.students[0], shift: "noturno" }] })).toThrow();
    const noShift = { ...example.students[0]!, shift: undefined };
    expect(() => MeResponse.parse({ ...example, students: [noShift] })).toThrow();
  });

  it("accepts the spec B.2 example of a checkout with its shift", () => {
    const example = {
      id: "0193a000-0000-7000-8000-000000000020",
      serviceDate: "2026-11-23",
      shift: "vespertino",
      cutoffAt: "2026-11-23T16:00:00.000Z",
      status: "pending_payment",
      totalCents: 900,
      walletAppliedCents: 0,
      amountDueCents: 900,
      orders: [
        {
          id: "0193a000-0000-7000-8000-000000000021",
          studentId: BIA,
          studentFirstName: "Bia",
          status: "pending",
          items: [{ menuItemId: "0193a000-0000-7000-8000-000000000030", name: "Misto quente", qty: 1, unitPriceCents: 900 }],
        },
      ],
      payment: { status: "pending", amountCents: 900, pixCopyPaste: "000201…", pixQrPngBase64: null, expiresAt: "2026-11-23T16:00:00.000Z" },
    };
    expect(CheckoutView.parse(example)).toEqual(example);
    expect(() => CheckoutView.parse({ ...example, shift: undefined })).toThrow();
    const notCollected = { ...example, status: "paid", orders: [{ ...example.orders[0]!, status: "not_collected" }] };
    expect(CheckoutView.parse(notCollected)).toEqual(notCollected);
  });

  it("has not_collected as an order status", () => {
    expect(OrderStatus.parse("not_collected")).toBe("not_collected");
  });
});
