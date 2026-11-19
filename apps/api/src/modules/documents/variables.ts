import { TEMPLATE_VARIABLES, formatCpf, type DocumentField } from "@app-lanche/contracts";
import type { Block, Inline } from "./markdown";

export type VariableContext = {
  schoolName: string;
  student: { firstName: string; fullName: string | null; birthDate: string | null; className: string };
  /** null em documento por aluno (modelo sem `responsavel.*`). */
  guardian: { firstName: string; fullName: string | null; cpf: string | null } | null;
  /** Data de emissão do lote (`YYYY-MM-DD`, fuso da escola, relógio do banco). */
  issuedOn: string;
  fields: DocumentField[];
  fieldValues: Record<string, string>;
};

const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;
const KNOWN = new Set<string>(TEMPLATE_VARIABLES);
const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

export function formatDateBR(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

export function formatLongDateBR(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${Number(d)} de ${MONTHS[Number(m) - 1]} de ${y}`;
}

/** Nomes únicos, na ordem em que aparecem. */
export function placeholdersIn(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]!.trim()))];
}

/** Vazio = modelo válido. Cada item é o marcador como aparece para a secretaria; "{{" = chave sem fechamento. */
export function templateProblems(bodyMd: string, fields: DocumentField[]): string[] {
  const declared = new Set(fields.map((f) => `campo.${f.key}`));
  const problems = placeholdersIn(bodyMd)
    .filter((name) => !KNOWN.has(name) && !declared.has(name))
    .map((name) => `{{${name}}}`);
  const rest = bodyMd.replace(PLACEHOLDER, "");
  if (rest.includes("{{") || rest.includes("}}")) problems.push("{{");
  return problems;
}

export function usesGuardian(bodyMd: string): boolean {
  return placeholdersIn(bodyMd).some((name) => name.startsWith("responsavel."));
}

function present(value: string | null | undefined): string | null {
  return value && value.trim() !== "" ? value : null;
}

export function variableValue(name: string, ctx: VariableContext): string | null {
  switch (name) {
    case "escola.nome":
      return present(ctx.schoolName);
    case "aluno.primeiro_nome":
      return present(ctx.student.firstName);
    case "aluno.nome_completo":
      return present(ctx.student.fullName);
    case "aluno.data_nascimento":
      return ctx.student.birthDate ? formatDateBR(ctx.student.birthDate) : null;
    case "turma.nome":
      return present(ctx.student.className);
    case "responsavel.nome":
      return present(ctx.guardian?.firstName);
    case "responsavel.nome_completo":
      return present(ctx.guardian?.fullName);
    case "responsavel.cpf":
      return ctx.guardian?.cpf ? formatCpf(ctx.guardian.cpf) : null;
    case "data.hoje":
      return formatLongDateBR(ctx.issuedOn);
    case "data.ano_letivo":
      return ctx.issuedOn.slice(0, 4);
  }
  if (name.startsWith("campo.")) {
    const key = name.slice("campo.".length);
    const field = ctx.fields.find((f) => f.key === key);
    const raw = present(ctx.fieldValues[key]);
    if (!field || raw === null) return null;
    return field.type === "data" ? formatDateBR(raw) : raw;
  }
  return null;
}

export function missingVariables(bodyMd: string, ctx: VariableContext): string[] {
  return placeholdersIn(bodyMd).filter((name) => variableValue(name, ctx) === null);
}

export function fillText(text: string, ctx: VariableContext): string {
  return text.replace(PLACEHOLDER, (_, name: string) => variableValue(name.trim(), ctx) ?? "");
}

export function fillBlocks(blocks: Block[], ctx: VariableContext): Block[] {
  const fill = (content: Inline[]): Inline[] => content.map((c) => ({ ...c, text: fillText(c.text, ctx) }));
  return blocks.map((b): Block => {
    switch (b.type) {
      case "heading":
      case "paragraph":
        return { ...b, content: fill(b.content) };
      case "list":
        return { ...b, items: b.items.map(fill) };
      case "table":
        return { ...b, header: b.header.map(fill), rows: b.rows.map((r) => r.map(fill)) };
    }
  });
}
