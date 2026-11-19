import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RosterRow } from "../../ui/counter";
import type { CounterSaleRow } from "./db";
import { CounterView } from "./CounterView";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ROSTER: RosterRow[] = [
  { studentId: "s1", firstName: "Léo", className: "Infantil 3A", restrictions: "sem lactose", guardianId: "g1", guardianFirstName: "Ana", balanceCents: -4000 },
  { studentId: "s2", firstName: "Bia", className: "Infantil 3A", restrictions: null, guardianId: "g1", guardianFirstName: "Ana", balanceCents: -4000 },
  { studentId: "s3", firstName: "Caio", className: "Infantil 4B", restrictions: null, guardianId: null, guardianFirstName: null, balanceCents: 0 },
];
const ITEMS = [
  { id: "m", name: "Misto quente", priceCents: 900 },
  { id: "s", name: "Suco", priceCents: 450 },
];
const SALES: CounterSaleRow[] = [
  { saleId: "v1", serviceDate: "2031-11-05", occurredAt: "2031-11-05T12:00:00.000Z", studentId: "s1", studentFirstName: "Léo", guardianId: "g1", lines: [{ menuItemId: "m", name: "Misto quente", qty: 1, unitPriceCents: 900 }], totalCents: 900, status: "accepted", voided: false },
  { saleId: "v2", serviceDate: "2031-11-05", occurredAt: "2031-11-05T11:00:00.000Z", studentId: "s2", studentFirstName: "Bia", guardianId: "g1", lines: [{ menuItemId: "s", name: "Suco", qty: 1, unitPriceCents: 450 }], totalCents: 450, status: "rejected", voided: false },
];

function setup(overrides: Partial<Parameters<typeof CounterView>[0]> = {}) {
  const onSell = vi.fn(async () => undefined);
  const onUndo = vi.fn(async () => undefined);
  render(<CounterView roster={ROSTER} items={ITEMS} limitCents={5000} sales={SALES} onSell={onSell} onUndo={onUndo} {...overrides} />);
  return { onSell, onUndo };
}

describe("CounterView", () => {
  it("finds a student by name, shows the totals and sells the cart", async () => {
    const { onSell } = setup();
    fireEvent.change(screen.getByTestId("kds-counter-search"), { target: { value: "leo" } });
    expect(screen.queryByTestId("kds-counter-student-s2")).toBeNull();
    fireEvent.click(screen.getByTestId("kds-counter-student-s1"));
    expect(screen.getByText("Conta de Ana")).toBeTruthy();
    expect(screen.getByText("Restrição: sem lactose")).toBeTruthy();
    fireEvent.click(screen.getByTestId("kds-counter-item-m-plus"));
    expect(screen.getByTestId("kds-counter-balance-after").textContent).toBe("-R$ 49,00");
    fireEvent.click(screen.getByTestId("kds-counter-submit"));
    expect(onSell).toHaveBeenCalledWith("s1", [{ menuItemId: "m", name: "Misto quente", qty: 1, unitPriceCents: 900 }]);
  });

  it("disables the sale past the debt limit and explains", () => {
    const { onSell } = setup();
    fireEvent.click(screen.getByTestId("kds-counter-student-s1"));
    fireEvent.click(screen.getByTestId("kds-counter-item-m-plus"));
    fireEvent.click(screen.getByTestId("kds-counter-item-m-plus"));
    expect((screen.getByTestId("kds-counter-submit") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("kds-counter-over-limit").textContent).toBe("Saldo insuficiente: peça à secretaria");
    expect(onSell).not.toHaveBeenCalled();
  });

  it("does not sell to a student without a financial guardian", () => {
    setup();
    fireEvent.click(screen.getByTestId("kds-counter-student-s3"));
    fireEvent.click(screen.getByTestId("kds-counter-item-s-plus"));
    expect(screen.getByText("Sem responsável financeiro: peça à secretaria")).toBeTruthy();
    expect((screen.getByTestId("kds-counter-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("lists today's sales and undoes one after confirmation", () => {
    vi.stubGlobal("confirm", () => true);
    const { onUndo } = setup();
    const accepted = screen.getByTestId("kds-counter-sale-v1");
    fireEvent.click(within(accepted).getByTestId("kds-counter-undo-v1"));
    expect(onUndo).toHaveBeenCalledWith("v1");
    const rejected = screen.getByTestId("kds-counter-sale-v2");
    expect(within(rejected).getByText("recusado")).toBeTruthy();
    expect(within(rejected).queryByTestId("kds-counter-undo-v2")).toBeNull();
  });
});
