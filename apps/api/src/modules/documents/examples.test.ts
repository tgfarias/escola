import { describe, expect, it } from "vitest";
import { TemplateInput } from "@app-lanche/contracts";
import { renderDocument } from "./pdf";
import { TEMPLATE_EXAMPLES, sampleContext } from "./examples";
import { missingVariables, templateProblems } from "./variables";

describe("built-in examples", () => {
  it("ships the four examples of spec 8.2", () => {
    expect(TEMPLATE_EXAMPLES.map((e) => e.key)).toEqual(["declaracao-matricula", "declaracao-frequencia", "comunicado-geral", "autorizacao-passeio"]);
  });

  it.each(TEMPLATE_EXAMPLES)("$key is a valid template that renders with sample data", async (example) => {
    expect(TemplateInput.parse({ name: example.name, category: example.category, bodyMd: example.bodyMd, fields: example.fields })).toBeTruthy();
    expect(templateProblems(example.bodyMd, example.fields)).toEqual([]);
    const ctx = sampleContext("Escola Sol", "2026-11-18", example.fields);
    expect(missingVariables(example.bodyMd, ctx)).toEqual([]);
    const bytes = await renderDocument(example.name, example.bodyMd, ctx);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});
