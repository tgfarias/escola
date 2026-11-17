import { describe, expect, it } from "vitest";
import { normalizePhoneBR, parseStudentsCsv } from "./csv";

const HEADER = "codigo_aluno,primeiro_nome,turma,responsavel_nome,responsavel_telefone";

describe("normalizePhoneBR", () => {
  it.each([
    ["(11) 99999-0001", "+5511999990001"],
    ["11 3333-4444", "+551133334444"],
    ["5511999990001", "+5511999990001"],
    ["+55 11 99999-0001", "+5511999990001"],
    ["+1 415 555 0100", "+14155550100"],
  ])("%s -> %s", (raw, expected) => {
    expect(normalizePhoneBR(raw)).toBe(expected);
  });

  it.each(["", "123", "999990001", "abc"])("rejects %j", (raw) => {
    expect(normalizePhoneBR(raw)).toBeNull();
  });
});

describe("parseStudentsCsv", () => {
  it("parses rows and normalizes phones", () => {
    const { rows, errors } = parseStudentsCsv(`${HEADER}\nA001,Léo,Infantil 3A,Ana,(11) 99999-0001\n`);
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { line: 2, externalCode: "A001", firstName: "Léo", className: "Infantil 3A", guardianFirstName: "Ana", guardianPhone: "+5511999990001" },
    ]);
  });

  it("reports the line of each invalid row", () => {
    const { rows, errors } = parseStudentsCsv(
      `${HEADER}\nA001,Léo,Infantil 3A,Ana,123\n,Bia,Infantil 3A,Ana,11999990001\n`,
    );
    expect(rows).toEqual([]);
    expect(errors).toEqual([
      { line: 2, message: "telefone inválido" },
      { line: 3, message: "codigo_aluno vazio" },
    ]);
  });

  it("reports a missing column in the header", () => {
    const { errors } = parseStudentsCsv("codigo_aluno,primeiro_nome\nA001,Léo\n");
    expect(errors).toEqual([
      { line: 1, message: "coluna ausente: turma, responsavel_nome, responsavel_telefone" },
    ]);
  });

  it("reports a file that cannot be parsed", () => {
    const { errors } = parseStudentsCsv(`${HEADER}\n"A001,Léo`);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("arquivo CSV inválido");
  });

  it("accepts the same student repeated with identical data (two guardians)", () => {
    const { rows, errors } = parseStudentsCsv(
      `${HEADER}\nA001,Léo,Infantil 3A,Ana,11999990001\nA001,Léo,Infantil 3A,Rui,11988880002\n`,
    );
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(2);
  });

  it.each([
    ["primeiro_nome", "A001,Leo,Infantil 3A,Rui,11988880002"],
    ["turma", "A001,Léo,Infantil 2B,Rui,11988880002"],
  ])("rejects a repeated codigo_aluno with a different %s", (_field, second) => {
    const { rows, errors } = parseStudentsCsv(`${HEADER}\nA001,Léo,Infantil 3A,Ana,11999990001\n${second}\n`);
    expect(rows).toEqual([]);
    expect(errors).toEqual([{ line: 3, message: "codigo_aluno repetido com dados diferentes" }]);
  });
});
