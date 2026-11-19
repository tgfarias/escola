import { describe, expect, it } from "vitest";
import { Cpf, formatCpf, isValidCpf, maskCpf } from "./cpf";

describe("cpf", () => {
  it.each(["52998224725", "11144477735", "12345678909"])("accepts %s", (cpf) => {
    expect(isValidCpf(cpf)).toBe(true);
  });

  it.each(["52998224724", "12345678900", "11111111111", "1234567890", "abcdefghijk"])("rejects %s", (cpf) => {
    expect(isValidCpf(cpf)).toBe(false);
  });

  it("normalizes punctuation and masks and formats", () => {
    expect(Cpf.parse("529.982.247-25")).toBe("52998224725");
    expect(() => Cpf.parse("529.982.247-24")).toThrow();
    expect(maskCpf("12345678909")).toBe("***.456.789-**");
    expect(formatCpf("12345678909")).toBe("123.456.789-09");
  });
});
