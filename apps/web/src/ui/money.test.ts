import { describe, expect, it } from "vitest";
import { formatCents, parsePriceToCents } from "./money";

describe("formatCents", () => {
  it.each([
    [0, "R$ 0,00"],
    [5, "R$ 0,05"],
    [1350, "R$ 13,50"],
    [125000, "R$ 1.250,00"],
    [-900, "-R$ 9,00"],
  ])("%i → %s", (cents, text) => {
    expect(formatCents(cents)).toBe(text);
  });
});

describe("parsePriceToCents", () => {
  it.each([
    ["9", 900],
    ["9,5", 950],
    ["9,50", 950],
    ["1.250,00", 125000],
    ["0", null],
    ["9.5", null],
    ["abc", null],
    ["10000,01", null],
  ])("%s → %s", (text, cents) => {
    expect(parsePriceToCents(text)).toBe(cents);
  });
});
