// Markdown restrito da spec 8.2: # e ##, parágrafos, listas "-" e "1.", **negrito** e tabela simples com "|".
// Tudo o mais é texto. O texto das variáveis é substituído depois do parse, então um valor nunca vira marcação.

export type Inline = { text: string; bold: boolean };
export type Block =
  | { type: "heading"; level: 1 | 2; content: Inline[] }
  | { type: "paragraph"; content: Inline[] }
  | { type: "list"; ordered: boolean; items: Inline[][] }
  | { type: "table"; header: Inline[][]; rows: Inline[][][] };

const HEADING = /^(#{1,2})\s+(.*)$/;
const BULLET = /^-\s+(.*)$/;
const ORDERED = /^\d{1,3}\.\s+(.*)$/;
const TABLE_ROW = /^\|.*\|$/;
const TABLE_SEPARATOR = /^\|(:?-{3,}:?\|)+$/;

/** `**negrito**`; um `**` sem par fica como texto. */
export function parseInline(text: string): Inline[] {
  const parts = text.split("**");
  const markers = parts.length - 1;
  const paired = markers - (markers % 2);
  const out: Inline[] = [];
  let bold = false;
  const push = (s: string) => {
    if (s === "") return;
    const last = out[out.length - 1];
    if (last && last.bold === bold) last.text += s;
    else out.push({ text: s, bold });
  };
  parts.forEach((part, i) => {
    if (i > 0) {
      if (i <= paired) bold = !bold;
      else push("**");
    }
    push(part);
  });
  return out;
}

function isSeparator(line: string | undefined): boolean {
  return line !== undefined && TABLE_SEPARATOR.test(line.replace(/\s/g, ""));
}

function startsTable(lines: string[], i: number): boolean {
  return TABLE_ROW.test(lines[i]!) && isSeparator(lines[i + 1]);
}

function cells(row: string): string[] {
  return row.slice(1, -1).split("|").map((c) => c.trim());
}

export function parseMarkdown(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim());
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line === "") {
      i += 1;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1]!.length as 1 | 2, content: parseInline(heading[2]!.trim()) });
      i += 1;
      continue;
    }
    if (BULLET.test(line) || ORDERED.test(line)) {
      const ordered = ORDERED.test(line);
      const re = ordered ? ORDERED : BULLET;
      const items: Inline[][] = [];
      for (let m = re.exec(lines[i] ?? ""); m; m = re.exec(lines[i] ?? "")) {
        items.push(parseInline(m[1]!.trim()));
        i += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }
    if (startsTable(lines, i)) {
      const header = cells(line);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && TABLE_ROW.test(lines[i]!)) {
        const row = cells(lines[i]!);
        rows.push(header.map((_, c) => parseInline(row[c] ?? "")));
        i += 1;
      }
      blocks.push({ type: "table", header: header.map(parseInline), rows });
      continue;
    }
    // Parágrafo: linhas seguidas até uma em branco ou o início de outro bloco. A primeira linha nunca inicia bloco
    // (os casos acima já a teriam consumido), então o laço sempre avança.
    const text: string[] = [];
    while (i < lines.length) {
      const l = lines[i]!;
      if (l === "" || HEADING.test(l) || BULLET.test(l) || ORDERED.test(l) || startsTable(lines, i)) break;
      text.push(l);
      i += 1;
    }
    blocks.push({ type: "paragraph", content: parseInline(text.join(" ")) });
  }
  return blocks;
}
