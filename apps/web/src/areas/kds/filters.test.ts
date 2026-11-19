import { describe, expect, it } from "vitest";
import { visibleGroups, type ClassGroup } from "./filters";

const [A, B, C] = ["0193a3b0-0000-7000-8000-000000000001", "0193a3b0-0000-7000-8000-000000000002", "0193a3b0-0000-7000-8000-000000000003"];
const GROUPS: ClassGroup[] = [
  {
    class: "Infantil 3A",
    orders: [
      { order_id: A, student: "Léo", items: ["Misto quente"], restrictions: null },
      { order_id: B, student: "Bia", items: ["Suco"], restrictions: "sem lactose" },
    ],
  },
  { class: "Infantil 4B", orders: [{ order_id: C, student: "Caio", items: ["Pão"], restrictions: null }] },
];
const delivered = new Set([A]);
const names = (groups: ClassGroup[]) => groups.map((g) => [g.class, g.orders.map((o) => o.student)]);

describe("visibleGroups", () => {
  it("shows every class and order with the default filter", () => {
    expect(names(visibleGroups(GROUPS, delivered, { className: null, state: "all" }))).toEqual([
      ["Infantil 3A", ["Léo", "Bia"]],
      ["Infantil 4B", ["Caio"]],
    ]);
  });

  it("filters by class", () => {
    expect(names(visibleGroups(GROUPS, delivered, { className: "Infantil 4B", state: "all" }))).toEqual([["Infantil 4B", ["Caio"]]]);
  });

  it("filters by delivery state and hides classes left empty", () => {
    expect(names(visibleGroups(GROUPS, delivered, { className: null, state: "pending" }))).toEqual([
      ["Infantil 3A", ["Bia"]],
      ["Infantil 4B", ["Caio"]],
    ]);
    expect(names(visibleGroups(GROUPS, delivered, { className: null, state: "delivered" }))).toEqual([["Infantil 3A", ["Léo"]]]);
  });
});
