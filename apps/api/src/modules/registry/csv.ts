import { isValidCpf } from "@app-lanche/contracts";
import { parse } from "csv-parse/sync";

const COLUMNS = ["codigo_aluno", "primeiro_nome", "turma", "responsavel_nome", "responsavel_telefone"] as const;

export type StudentRow = {
  line: number;
  externalCode: string;
  firstName: string;
  className: string;
  guardianFirstName: string;
  guardianPhone: string;
  fullName: string | null;
  birthDate: string | null;
  guardianFullName: string | null;
  guardianCpf: string | null;
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

/** "15/03/2021" ou "2021-03-15" → "2021-03-15"; data impossível → null. */
export function parseBirthDate(raw: string): string | null {
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
  const iso = br ? `${br[3]}-${br[2]}-${br[1]}` : raw;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
}

/** Coluna opcional: ausente ou vazia vira null; espaços repetidos viram um. */
function optional(value: string | undefined): string | null {
  const v = value?.trim().replace(/\s+/g, " ");
  return v ? v : null;
}

const differs = (a: string | null, b: string | null) => a !== null && b !== null && a !== b;

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
  const guardianSeen = new Map<string, StudentRow>();
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
    const fullName = optional(record.nome_completo);
    const guardianFullName = optional(record.responsavel_nome_completo);
    if ((fullName?.length ?? 0) > 200 || (guardianFullName?.length ?? 0) > 200) {
      errors.push({ line, message: "nome completo muito longo" });
      return;
    }
    const rawBirth = optional(record.data_nascimento);
    const birthDate = rawBirth === null ? null : parseBirthDate(rawBirth);
    if (rawBirth !== null && birthDate === null) {
      errors.push({ line, message: "data_nascimento inválida" });
      return;
    }
    const rawCpf = optional(record.responsavel_cpf);
    const guardianCpf = rawCpf === null ? null : rawCpf.replace(/[.\-\s]/g, "");
    if (guardianCpf !== null && !isValidCpf(guardianCpf)) {
      // Planilhas tratam o CPF como número e perdem o zero inicial.
      const hint = /^\d{10}$/.test(guardianCpf) ? ". CPF com 10 dígitos: confira se o zero inicial foi perdido na planilha." : "";
      errors.push({ line, message: `responsavel_cpf inválido${hint}` });
      return;
    }
    const row: StudentRow = {
      line,
      externalCode: record.codigo_aluno!,
      firstName: firstWord(record.primeiro_nome!),
      className: record.turma!,
      guardianFirstName: firstWord(record.responsavel_nome!),
      guardianPhone: phone,
      fullName,
      birthDate,
      guardianFullName,
      guardianCpf,
    };
    // Os mapas guardam cópias que acumulam os valores não vazios já vistos: vazio, "A" e depois "B" é conflito.
    const first = firstSeen.get(row.externalCode);
    if (!first) {
      firstSeen.set(row.externalCode, { ...row });
    } else if (
      first.firstName !== row.firstName ||
      first.className !== row.className ||
      differs(first.fullName, row.fullName) ||
      differs(first.birthDate, row.birthDate)
    ) {
      errors.push({ line, message: "codigo_aluno repetido com dados diferentes" });
      return;
    }
    const g = guardianSeen.get(row.guardianPhone);
    if (!g) {
      guardianSeen.set(row.guardianPhone, { ...row });
    } else if (differs(g.guardianCpf, row.guardianCpf) || differs(g.guardianFullName, row.guardianFullName)) {
      errors.push({ line, message: "responsavel_telefone repetido com dados diferentes" });
      return;
    }
    if (first) {
      first.fullName ??= row.fullName;
      first.birthDate ??= row.birthDate;
    }
    if (g) {
      g.guardianCpf ??= row.guardianCpf;
      g.guardianFullName ??= row.guardianFullName;
    }
    rows.push(row);
  });
  return errors.length > 0 ? { rows: [], errors } : { rows, errors };
}
