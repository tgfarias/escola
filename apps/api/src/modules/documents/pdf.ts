import { createRequire } from "node:module";
import type { Content, TDocumentDefinitions } from "pdfmake/interfaces";
import { parseMarkdown, type Block, type Inline } from "./markdown";
import { fillBlocks, type VariableContext } from "./variables";

// pdfmake 0.3 no Node é CommonJS e exporta uma instância; createRequire evita depender de interop de default import.
const pdfmake = createRequire(import.meta.url)("pdfmake") as typeof import("pdfmake");

// As 14 fontes padrão do PDF não precisam de arquivo e cobrem o português (WinAnsi).
const STANDARD_FONTS = new Set(["Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique"]);
let configured = false;

function setup(): void {
  if (configured) return;
  pdfmake.setFonts({ Helvetica: { normal: "Helvetica", bold: "Helvetica-Bold", italics: "Helvetica-Oblique", bolditalics: "Helvetica-BoldOblique" } });
  // Nenhum recurso externo: sem URL e sem arquivo local além das fontes padrão.
  pdfmake.setUrlAccessPolicy(() => false);
  pdfmake.setLocalAccessPolicy((path) => STANDARD_FONTS.has(path));
  configured = true;
}

const text = (content: Inline[]) => content.map((c) => ({ text: c.text, bold: c.bold }));

function toContent(block: Block): Content {
  switch (block.type) {
    case "heading":
      return { text: text(block.content), style: block.level === 1 ? "h1" : "h2" };
    case "paragraph":
      return { text: text(block.content), style: "p" };
    case "list": {
      const items = block.items.map((item) => ({ text: text(item) }));
      return block.ordered ? { ol: items, style: "p" } : { ul: items, style: "p" };
    }
    case "table":
      return {
        style: "p",
        table: {
          headerRows: 1,
          widths: block.header.map(() => "*"),
          body: [block.header.map((c) => ({ text: text(c), bold: true })), ...block.rows.map((row) => row.map((c) => ({ text: text(c) })))],
        },
      };
  }
}

export async function renderPdf(title: string, blocks: Block[]): Promise<Buffer> {
  setup();
  const doc: TDocumentDefinitions = {
    info: { title },
    pageSize: "A4",
    pageMargins: [56, 56, 56, 56],
    defaultStyle: { font: "Helvetica", fontSize: 11, lineHeight: 1.3 },
    styles: {
      h1: { fontSize: 16, bold: true, alignment: "center", margin: [0, 0, 0, 16] },
      h2: { fontSize: 13, bold: true, margin: [0, 12, 0, 8] },
      p: { alignment: "justify", margin: [0, 0, 0, 10] },
    },
    content: blocks.map(toContent),
  };
  return pdfmake.createPdf(doc).getBuffer();
}

export function renderDocument(title: string, bodyMd: string, ctx: VariableContext): Promise<Buffer> {
  return renderPdf(title, fillBlocks(parseMarkdown(bodyMd), ctx));
}
