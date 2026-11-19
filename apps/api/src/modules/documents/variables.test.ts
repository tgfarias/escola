import { describe, expect, it } from "vitest";
import { parseMarkdown } from "./markdown";
import {
  fillBlocks,
  formatDateBR,
  formatLongDateBR,
  missingVariables,
  placeholdersIn,
  templateProblems,
  usesGuardian,
  type VariableContext,
} from "./variables";

const ctx: VariableContext = {
  schoolName: "Escola Sol",
  student: { firstName: "Léo", fullName: "Leonardo Souza", birthDate: "2021-03-15", className: "Infantil 3A" },
  guardian: { firstName: "Ana", fullName: "Ana **Paula** Souza", cpf: "12345678909" },
  issuedOn: "2026-11-18",
  fields: [
    { key: "destino", label: "Destino", type: "texto" },
    { key: "data_passeio", label: "Data", type: "data" },
  ],
  fieldValues: { destino: "Zoológico", data_passeio: "2026-12-05" },
};

describe("template variables", () => {
  it("finds unique placeholders, tolerating inner spaces", () => {
    expect(placeholdersIn("{{ aluno.primeiro_nome }} e {{aluno.primeiro_nome}} {{campo.destino}}")).toEqual(["aluno.primeiro_nome", "campo.destino"]);
  });

  it("reports unknown variables, undeclared fields and unclosed braces", () => {
    const fields = [{ key: "destino", label: "Destino", type: "texto" as const }];
    expect(templateProblems("{{aluno.nome_completo}} {{campo.destino}}", fields)).toEqual([]);
    expect(templateProblems("{{aluno.apelido}} {{campo.hora}} {{campo.destino}}", fields)).toEqual(["{{aluno.apelido}}", "{{campo.hora}}"]);
    expect(templateProblems("Olá {{aluno.primeiro_nome", fields)).toEqual(["{{"]);
  });

  it("detects templates addressed to a guardian", () => {
    expect(usesGuardian("{{responsavel.cpf}}")).toBe(true);
    expect(usesGuardian("{{aluno.primeiro_nome}}")).toBe(false);
  });

  it("lists variables without a value, empty strings included", () => {
    const body = "{{aluno.nome_completo}} {{aluno.data_nascimento}} {{responsavel.cpf}} {{campo.destino}}";
    expect(missingVariables(body, ctx)).toEqual([]);
    const blank = { ...ctx, student: { ...ctx.student, fullName: "  ", birthDate: null }, guardian: null };
    expect(missingVariables(body, blank)).toEqual(["aluno.nome_completo", "aluno.data_nascimento", "responsavel.cpf"]);
  });

  it("fills text, dates and CPF in every block without turning values into markup", () => {
    const blocks = parseMarkdown(
      "# {{escola.nome}}\n\nEu, **{{responsavel.nome_completo}}**, CPF {{responsavel.cpf}}, autorizo {{aluno.primeiro_nome}} em {{campo.data_passeio}}.\n\n| Destino |\n|---|\n| {{campo.destino}} |\n\n- {{data.hoje}} ({{data.ano_letivo}})",
    );
    expect(fillBlocks(blocks, ctx)).toEqual([
      { type: "heading", level: 1, content: [{ text: "Escola Sol", bold: false }] },
      {
        type: "paragraph",
        content: [
          { text: "Eu, ", bold: false },
          { text: "Ana **Paula** Souza", bold: true },
          { text: ", CPF 123.456.789-09, autorizo Léo em 05/12/2026.", bold: false },
        ],
      },
      { type: "table", header: [[{ text: "Destino", bold: false }]], rows: [[[{ text: "Zoológico", bold: false }]]] },
      { type: "list", ordered: false, items: [[{ text: "18 de novembro de 2026 (2026)", bold: false }]] },
    ]);
  });

  it("formats dates", () => {
    expect(formatDateBR("2021-03-05")).toBe("05/03/2021");
    expect(formatLongDateBR("2026-01-01")).toBe("1 de janeiro de 2026");
  });
});
