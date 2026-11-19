import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "./markdown";

const t = (text: string, bold = false) => ({ text, bold });

describe("parseInline", () => {
  it("toggles bold on paired markers and keeps an unpaired one as text", () => {
    expect(parseInline("a **b** c")).toEqual([t("a "), t("b", true), t(" c")]);
    expect(parseInline("a **b** c **d")).toEqual([t("a "), t("b", true), t(" c **d")]);
    expect(parseInline("")).toEqual([]);
  });
});

describe("parseMarkdown", () => {
  it("parses headings and joins paragraph lines", () => {
    expect(parseMarkdown("# Título\r\n\r\nOlá **mundo**\ncontinua.\n\n## Seção\n### não é título")).toEqual([
      { type: "heading", level: 1, content: [t("Título")] },
      { type: "paragraph", content: [t("Olá "), t("mundo", true), t(" continua.")] },
      { type: "heading", level: 2, content: [t("Seção")] },
      { type: "paragraph", content: [t("### não é título")] },
    ]);
  });

  it("parses bullet and numbered lists", () => {
    expect(parseMarkdown("- a\n- **b**\n\n1. um\n2. dois")).toEqual([
      { type: "list", ordered: false, items: [[t("a")], [t("b", true)]] },
      { type: "list", ordered: true, items: [[t("um")], [t("dois")]] },
    ]);
  });

  it("parses a simple table and pads short rows", () => {
    expect(parseMarkdown("| Item | Detalhe |\n| --- | :---: |\n| Data | {{campo.data}} |\n| Só |")).toEqual([
      {
        type: "table",
        header: [[t("Item")], [t("Detalhe")]],
        rows: [
          [[t("Data")], [t("{{campo.data}}")]],
          [[t("Só")], []],
        ],
      },
    ]);
  });

  it("treats pipes without a separator line as a paragraph", () => {
    expect(parseMarkdown("| a | b |")).toEqual([{ type: "paragraph", content: [t("| a | b |")] }]);
  });

  it("starts a new block when a list follows a paragraph line", () => {
    expect(parseMarkdown("Leve:\n- água")).toEqual([
      { type: "paragraph", content: [t("Leve:")] },
      { type: "list", ordered: false, items: [[t("água")]] },
    ]);
  });
});
