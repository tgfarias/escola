import { describe, expect, it } from "vitest";
import { CreateBatchRequest, TEMPLATE_VARIABLE_LABELS, TEMPLATE_VARIABLES, TemplateInput } from "./documents";

const U = (n: number) => `0193a3b0-0000-7000-8000-${String(n).padStart(12, "0")}`;
const base = { name: "Autorização", category: "autorizacao", bodyMd: "# Oi", fields: [] };

describe("document contracts", () => {
  it("labels every template variable", () => {
    expect(Object.keys(TEMPLATE_VARIABLE_LABELS).sort()).toEqual([...TEMPLATE_VARIABLES].sort());
  });

  it("accepts up to 10 fields with snake_case keys and rejects duplicates or bad keys", () => {
    const field = (key: string) => ({ key, label: "Rótulo", type: "texto" });
    expect(TemplateInput.parse({ ...base, fields: [field("data_passeio")] }).fields).toHaveLength(1);
    expect(() => TemplateInput.parse({ ...base, fields: Array.from({ length: 11 }, (_, i) => field(`c${i}`)) })).toThrow();
    expect(() => TemplateInput.parse({ ...base, fields: [field("a"), field("a")] })).toThrow();
    for (const key of ["Data", "1a", "a-b", "a".repeat(31)]) {
      expect(() => TemplateInput.parse({ ...base, fields: [field(key)] })).toThrow();
    }
    expect(() => TemplateInput.parse({ ...base, fields: [{ key: "x", label: "X", type: "numero" }] })).toThrow();
  });

  it("refuses duplicate students and unknown field keys in a batch", () => {
    const ok = { templateId: U(1), studentIds: [U(2), U(3)], fieldValues: { destino: "Zoológico" } };
    expect(CreateBatchRequest.parse(ok)).toEqual(ok);
    expect(() => CreateBatchRequest.parse({ ...ok, studentIds: [U(2), U(2)] })).toThrow();
    expect(() => CreateBatchRequest.parse({ ...ok, fieldValues: { Destino: "x" } })).toThrow();
    expect(() => CreateBatchRequest.parse({ ...ok, fieldValues: { destino: "  " } })).toThrow();
    expect(() => CreateBatchRequest.parse({ ...ok, studentIds: [] })).toThrow();
  });
});
