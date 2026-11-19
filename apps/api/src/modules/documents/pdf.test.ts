import { describe, expect, it } from "vitest";
import { parseMarkdown } from "./markdown";
import { renderDocument, renderPdf } from "./pdf";
import { sampleContext } from "./examples";

const isPdf = (b: Buffer) => b.subarray(0, 5).toString("latin1") === "%PDF-";

describe("pdf", () => {
  it("renders every block type with accents to a PDF", async () => {
    const blocks = parseMarkdown("# Declaração\n\nAção **ênfase** çã.\n\n- um\n- dois\n\n1. três\n\n| A | B |\n|---|---|\n| 1 | 2 |");
    const bytes = await renderPdf("Declaração", blocks);
    expect(isPdf(bytes)).toBe(true);
    expect(bytes.length).toBeGreaterThan(500);
  });

  it("fills variables before drawing", async () => {
    const ctx = sampleContext("Escola Sol", "2026-11-18", []);
    expect(isPdf(await renderDocument("Teste", "Olá {{aluno.nome_completo}}", ctx))).toBe(true);
  });
});
