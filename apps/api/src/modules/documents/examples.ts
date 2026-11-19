import type { DocumentCategory, DocumentField } from "@app-lanche/contracts";
import type { VariableContext } from "./variables";

export type TemplateExampleDef = { key: string; name: string; category: DocumentCategory; bodyMd: string; fields: DocumentField[] };

/** Quatro exemplos prontos (spec 8.2): a escola copia para um modelo seu e edita. */
export const TEMPLATE_EXAMPLES: TemplateExampleDef[] = [
  {
    key: "declaracao-matricula",
    name: "Declaração de matrícula",
    category: "declaracao",
    fields: [],
    bodyMd: [
      "# Declaração de matrícula",
      "",
      "Declaramos, para os devidos fins, que **{{aluno.nome_completo}}**, nascido(a) em {{aluno.data_nascimento}}, está regularmente matriculado(a) nesta escola no ano letivo de {{data.ano_letivo}}, na turma {{turma.nome}}.",
      "",
      "{{escola.nome}}, {{data.hoje}}.",
      "",
      "Secretaria escolar",
    ].join("\n"),
  },
  {
    key: "declaracao-frequencia",
    name: "Declaração de frequência",
    category: "declaracao",
    fields: [{ key: "periodo", label: "Período", type: "texto" }],
    bodyMd: [
      "# Declaração de frequência",
      "",
      "Declaramos que **{{aluno.nome_completo}}**, da turma {{turma.nome}}, frequenta regularmente as aulas desta escola no período de {{campo.periodo}}.",
      "",
      "Declaração emitida a pedido de {{responsavel.nome_completo}}, CPF {{responsavel.cpf}}.",
      "",
      "{{escola.nome}}, {{data.hoje}}.",
    ].join("\n"),
  },
  {
    key: "comunicado-geral",
    name: "Comunicado geral",
    category: "comunicado",
    fields: [{ key: "data_evento", label: "Data", type: "data" }],
    bodyMd: [
      "# Comunicado",
      "",
      "Prezadas famílias da turma {{turma.nome}},",
      "",
      "Informamos que no dia **{{campo.data_evento}}** não haverá aula, em razão de atividades de planejamento pedagógico.",
      "",
      "Contamos com a compreensão de todos.",
      "",
      "{{escola.nome}}, {{data.hoje}}.",
    ].join("\n"),
  },
  {
    key: "autorizacao-passeio",
    name: "Autorização de passeio",
    category: "autorizacao",
    fields: [
      { key: "destino", label: "Destino", type: "texto" },
      { key: "data_passeio", label: "Data do passeio", type: "data" },
      { key: "horario", label: "Horário", type: "texto" },
    ],
    bodyMd: [
      "# Autorização de passeio",
      "",
      "Eu, {{responsavel.nome_completo}}, CPF {{responsavel.cpf}}, autorizo **{{aluno.nome_completo}}**, da turma {{turma.nome}}, a participar do passeio a {{campo.destino}}.",
      "",
      "| Item | Detalhe |",
      "|---|---|",
      "| Destino | {{campo.destino}} |",
      "| Data | {{campo.data_passeio}} |",
      "| Horário | {{campo.horario}} |",
      "",
      "O que levar:",
      "",
      "- lanche e garrafa de água;",
      "- boné e protetor solar.",
      "",
      "Assinatura do responsável: ______________________________",
      "",
      "{{escola.nome}}, {{data.hoje}}.",
    ].join("\n"),
  },
];

/** Dados fictícios da prévia; campos de texto mostram o próprio rótulo entre colchetes. */
export function sampleContext(schoolName: string, today: string, fields: DocumentField[]): VariableContext {
  return {
    schoolName,
    student: { firstName: "Maria", fullName: "Maria Eduarda Alves", birthDate: "2021-03-15", className: "Infantil 3A" },
    guardian: { firstName: "Ana", fullName: "Ana Paula Alves", cpf: "12345678909" },
    issuedOn: today,
    fields,
    fieldValues: Object.fromEntries(fields.map((f) => [f.key, f.type === "data" ? today : `[${f.label}]`])),
  };
}
