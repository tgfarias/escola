import { describe, expect, it } from "vitest";
import { canSell, cartLines, cartTotal, filterRoster, isValidSale, pendingDelta, rosterRows, setQty, voidsReadyToSend, type RosterRow, type SaleLine } from "./counter";

const row = (studentId: string, firstName: string, className: string, guardianId: string | null, balanceCents = 0): RosterRow => ({
  studentId, firstName, className, restrictions: null, guardianId, guardianFirstName: guardianId ? "Ana" : null, balanceCents,
});
const ITEMS = [
  { id: "m", name: "Misto quente", priceCents: 900 },
  { id: "s", name: "Suco", priceCents: 450 },
];

describe("counter rules", () => {
  it("filters by first name without accents and by class", () => {
    const rows = [row("1", "Léo", "3A", "g"), row("2", "Bia", "3A", "g"), row("3", "Leandro", "4B", "h")];
    expect(filterRoster(rows, { query: "leo", className: null }).map((r) => r.studentId)).toEqual(["1"]);
    expect(filterRoster(rows, { query: "le", className: "4B" }).map((r) => r.studentId)).toEqual(["3"]);
    expect(filterRoster(rows, { query: "", className: "3A" }).map((r) => r.studentId)).toEqual(["1", "2"]);
  });

  it("computes lines and total in integer cents, clamping quantities to 1–10", () => {
    let cart = setQty({}, "m", 2);
    cart = setQty(cart, "s", 15);
    expect(cartLines(cart, ITEMS)).toEqual([
      { menuItemId: "m", name: "Misto quente", qty: 2, unitPriceCents: 900 },
      { menuItemId: "s", name: "Suco", qty: 10, unitPriceCents: 450 },
    ]);
    expect(cartTotal(cart, ITEMS)).toBe(6300);
    expect(cartLines(setQty(cart, "s", 0), ITEMS)).toHaveLength(1);
  });

  it("allows a sale while the balance after stays at or above -limit", () => {
    expect(canSell(0, 5000, 5000)).toBe(true);
    expect(canSell(0, 5001, 5000)).toBe(false);
    expect(canSell(-4000, 900, 5000)).toBe(true);
    expect(canSell(1000, 0, 5000)).toBe(false);
  });

  it("re-applies pending sales and voids to the server balance", () => {
    const pending = [
      { kind: "counter_sale", guardianId: "g", totalCents: 900 },
      { kind: "counter_void", guardianId: "g", totalCents: 450 },
      { kind: "counter_sale", guardianId: "h", totalCents: 100 },
      { kind: "delivery" },
    ];
    expect(pendingDelta(pending, "g")).toBe(-450);
    const rows = rosterRows(
      {
        debtLimitCents: 5000,
        items: ITEMS,
        students: [
          { id: "1", firstName: "Léo", className: "3A", restrictions: "sem lactose", guardian: { id: "g", firstName: "Ana", balanceCents: 1000 } },
          { id: "2", firstName: "Bia", className: "3A", restrictions: null, guardian: null },
        ],
      },
      pending,
    );
    expect(rows).toEqual([
      { studentId: "1", firstName: "Léo", className: "3A", restrictions: "sem lactose", guardianId: "g", guardianFirstName: "Ana", balanceCents: 550 },
      { studentId: "2", firstName: "Bia", className: "3A", restrictions: null, guardianId: null, guardianFirstName: null, balanceCents: 0 },
    ]);
  });

  it("accepts only sales within the contract limits", () => {
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const line = (n: number, qty = 1, unitPriceCents = 900): SaleLine => ({ menuItemId: id(n), name: `Item ${n}`, qty, unitPriceCents });
    const student = id(99);
    expect(isValidSale(student, [line(1), line(2, 10)])).toBe(true);
    expect(isValidSale(student, Array.from({ length: 10 }, (_, i) => line(i + 1)))).toBe(true);
    expect(isValidSale(student, [])).toBe(false);
    expect(isValidSale(student, Array.from({ length: 11 }, (_, i) => line(i + 1)))).toBe(false);
    expect(isValidSale(student, [line(1, 0)])).toBe(false);
    expect(isValidSale(student, [line(1, 11)])).toBe(false);
    expect(isValidSale(student, [line(1, 1.5)])).toBe(false);
    expect(isValidSale(student, [line(1), line(1)])).toBe(false);
    expect(isValidSale(student, [{ ...line(1), menuItemId: "m" }])).toBe(false);
    expect(isValidSale("s1", [line(1)])).toBe(false);
    expect(isValidSale(student, [line(1, 1, 0)])).toBe(false);
    expect(isValidSale(student, [line(1, 1, 9.5)])).toBe(false);
  });

  it("holds back a void while its sale is still in the outbox", () => {
    const voids = [
      { eventId: "e1", saleId: "a" },
      { eventId: "e2", saleId: "b" },
      { eventId: "e3", saleId: "c" },
    ];
    expect(voidsReadyToSend(voids, new Set(["b"])).map((v) => v.eventId)).toEqual(["e1", "e3"]);
    expect(voidsReadyToSend(voids, new Set())).toEqual(voids);
    expect(voidsReadyToSend(voids, new Set(["a", "b", "c"]))).toEqual([]);
  });
});
