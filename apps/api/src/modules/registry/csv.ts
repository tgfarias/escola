import { parse } from "csv-parse/sync";

const COLUMNS = ["codigo_aluno", "primeiro_nome", "turma", "responsavel_nome", "responsavel_telefone"] as const;

export type StudentRow = {
  line: number;
  externalCode: string;
  firstName: string;
  className: string;
  guardianFirstName: string;
  guardianPhone: string;
};

export type CsvError = { line: number; message: string };

/** Devolve o telefone em E.164 ou null. Sem código de país, assume Brasil. */
export function normalizePhoneBR(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (raw.trim().startsWith("+")) {
    return digits.length >= 8 && digits.length <= 15 && !digits.startsWith("0") ? `+${digits}` : null;
  }
  if (digits.length === 10 || digits.length === 11) return `+55${digits}`;
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith("55")) return `+${digits}`;
  return null;
}

/** First word of a trimmed name: only the first name is stored (LGPD; WhatsApp messages use first names only). */
function firstWord(name: string): string {
  return name.trim().split(/\s+/)[0]!;
}

export function parseStudentsCsv(csv: string): { rows: StudentRow[]; errors: CsvError[] } {
  let records: { record: Record<string, string>; info: { lines: number } }[];
  try {
    records = parse(csv, { columns: true, skip_empty_lines: true, trim: true, bom: true, info: true });
  } catch {
    return { rows: [], errors: [{ line: 1, message: "arquivo CSV inválido" }] };
  }
  const header = records[0] ? Object.keys(records[0].record) : [];
  const missing = COLUMNS.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    return { rows: [], errors: [{ line: 1, message: `coluna ausente: ${missing.join(", ")}` }] };
  }

  const rows: StudentRow[] = [];
  const errors: CsvError[] = [];
  const firstSeen = new Map<string, StudentRow>();
  // info.lines is the physical line where the record ends (blank lines and quoted newlines included).
  records.forEach(({ record, info }) => {
    const line = info.lines;
    const empty = COLUMNS.find((c) => !record[c]);
    if (empty) {
      errors.push({ line, message: `${empty} vazio` });
      return;
    }
    const phone = normalizePhoneBR(record.responsavel_telefone!);
    if (!phone) {
      errors.push({ line, message: "telefone inválido" });
      return;
    }
    const row: StudentRow = {
      line,
      externalCode: record.codigo_aluno!,
      firstName: firstWord(record.primeiro_nome!),
      className: record.turma!,
      guardianFirstName: firstWord(record.responsavel_nome!),
      guardianPhone: phone,
    };
    const first = firstSeen.get(row.externalCode);
    if (!first) {
      firstSeen.set(row.externalCode, row);
    } else if (first.firstName !== row.firstName || first.className !== row.className) {
      errors.push({ line, message: "codigo_aluno repetido com dados diferentes" });
      return;
    }
    rows.push(row);
  });
  return errors.length > 0 ? { rows: [], errors } : { rows, errors };
}
