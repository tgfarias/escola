import { describe, expect, it } from "vitest";
import { normalizePhoneBR, parseShift, parseStudentsCsv } from "./csv";

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
      { line: 2, externalCode: "A001", firstName: "Léo", className: "Infantil 3A", guardianFirstName: "Ana", guardianPhone: "+5511999990001", fullName: null, birthDate: null, guardianFullName: null, guardianCpf: null, shift: null },
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

  it("reports the physical line when a blank line separates data rows", () => {
    const { errors } = parseStudentsCsv(`${HEADER}\nA001,Léo,Infantil 3A,Ana,11999990001\n\nA002,Bia,Infantil 3A,Ana,123\n`);
    expect(errors).toEqual([{ line: 4, message: "telefone inválido" }]);
  });

  it("reports the physical line after a quoted field containing a newline", () => {
    const { errors } = parseStudentsCsv(
      `${HEADER}\nA001,Léo,"Infantil\n3A",Ana,11999990001\nA002,Bia,Infantil 3A,Ana,123\n`,
    );
    expect(errors).toEqual([{ line: 4, message: "telefone inválido" }]);
  });

  it("keeps only the first word of the student and guardian names", () => {
    const { rows, errors } = parseStudentsCsv(`${HEADER}\nA001,  Léo  Henrique ,Infantil 3A,Ana Maria Souza,11999990001\n`);
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({ firstName: "Léo", guardianFirstName: "Ana" });
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

describe("optional personal columns", () => {
  const H = `${HEADER},nome_completo,data_nascimento,responsavel_nome_completo,responsavel_cpf`;

  it("reads full names, birth dates in two formats and CPFs with punctuation", () => {
    const { rows, errors } = parseStudentsCsv(
      `${H}\nA001,Léo,Infantil 3A,Ana,11999990001,Leonardo  Souza,15/03/2021,Ana Paula Souza,529.982.247-25\nA002,Bia,Infantil 3A,Ana,11999990001,,2022-07-02,,\n`,
    );
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({ fullName: "Leonardo Souza", birthDate: "2021-03-15", guardianFullName: "Ana Paula Souza", guardianCpf: "52998224725" });
    expect(rows[1]).toMatchObject({ fullName: null, birthDate: "2022-07-02", guardianFullName: null, guardianCpf: null });
  });

  it("reports invalid dates and CPFs without echoing the CPF", () => {
    const { rows, errors } = parseStudentsCsv(
      `${H}\nA001,Léo,Infantil 3A,Ana,11999990001,,31/02/2021,,\nA002,Bia,Infantil 3A,Rui,11988880002,,,,529.982.247-24\n`,
    );
    expect(rows).toEqual([]);
    expect(errors).toEqual([
      { line: 2, message: "data_nascimento inválida" },
      { line: 3, message: "responsavel_cpf inválido" },
    ]);
  });

  it("refuses the same guardian phone with different CPFs", () => {
    const { errors } = parseStudentsCsv(
      `${H}\nA001,Léo,Infantil 3A,Ana,11999990001,,,,52998224725\nA002,Bia,Infantil 3A,Ana,11999990001,,,,11144477735\n`,
    );
    expect(errors).toEqual([{ line: 3, message: "responsavel_telefone repetido com dados diferentes" }]);
  });

  it("detects a conflict after an empty value: empty, A, B for the same key", () => {
    const guardian = parseStudentsCsv(
      `${H}\nA001,Léo,Infantil 3A,Ana,11999990001,,,,\nA002,Bia,Infantil 3A,Ana,11999990001,,,Ana Souza,\nA003,Caio,Infantil 3A,Ana,11999990001,,,Ana Lima,\n`,
    );
    expect(guardian.errors).toEqual([{ line: 4, message: "responsavel_telefone repetido com dados diferentes" }]);
    const student = parseStudentsCsv(
      `${H}\nA001,Léo,Infantil 3A,Ana,11999990001,,,,\nA001,Léo,Infantil 3A,Rui,11988880002,Leonardo Souza,,,\nA001,Léo,Infantil 3A,Eva,11977770003,Leonardo Lima,,,\n`,
    );
    expect(student.errors).toEqual([{ line: 4, message: "codigo_aluno repetido com dados diferentes" }]);
    const birth = parseStudentsCsv(
      `${H}\nA001,Léo,Infantil 3A,Ana,11999990001,,,,\nA001,Léo,Infantil 3A,Rui,11988880002,,15/03/2021,,\nA001,Léo,Infantil 3A,Eva,11977770003,,16/03/2021,,\n`,
    );
    expect(birth.errors).toEqual([{ line: 4, message: "codigo_aluno repetido com dados diferentes" }]);
  });

  it("hints at a lost leading zero for a CPF with 10 digits", () => {
    const { errors } = parseStudentsCsv(`${H}\nA001,Léo,Infantil 3A,Ana,11999990001,,,,1234567890\n`);
    expect(errors).toEqual([{ line: 2, message: "responsavel_cpf inválido. CPF com 10 dígitos: confira se o zero inicial foi perdido na planilha." }]);
  });

  it("keeps working without the optional columns", () => {
    const { rows, errors } = parseStudentsCsv(`${HEADER}\nA001,Léo,Infantil 3A,Ana,11999990001\n`);
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({ fullName: null, guardianCpf: null });
  });
});

describe("turno column", () => {
  const HEADER_T = "codigo_aluno,primeiro_nome,turma,responsavel_nome,responsavel_telefone,turno";

  it("accepts morning and afternoon names without case or accents and leaves blanks as null", () => {
    expect(parseShift("Matutino")).toBe("matutino");
    expect(parseShift(" MANHÃ ")).toBe("matutino");
    expect(parseShift("manha")).toBe("matutino");
    expect(parseShift("Vespertino")).toBe("vespertino");
    expect(parseShift("tarde")).toBe("vespertino");
    expect(parseShift("integral")).toBeNull();
    const { rows, errors } = parseStudentsCsv(`${HEADER_T}\nA1,Léo,3A,Ana,11999990001,Tarde\nA2,Bia,4B,Rui,11999990002,`);
    expect(errors).toEqual([]);
    expect(rows.map((r) => r.shift)).toEqual(["vespertino", null]);
  });

  it("rejects an unknown shift and a class with two shifts in the same file", () => {
    expect(parseStudentsCsv(`${HEADER_T}\nA1,Léo,3A,Ana,11999990001,noite`).errors).toEqual([{ line: 2, message: "turno inválido" }]);
    expect(parseStudentsCsv(`${HEADER_T}\nA1,Léo,3A,Ana,11999990001,manhã\nA2,Bia,3A,Rui,11999990002,tarde`).errors).toEqual([
      { line: 3, message: "turma com turnos diferentes" },
    ]);
  });
});
