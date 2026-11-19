import { z } from "zod";
import { IsoDate, IsoDateTime, Uuid } from "./common";

export const DocumentCategory = z.enum(["declaracao", "comunicado", "autorizacao", "outro"]);
export type DocumentCategory = z.infer<typeof DocumentCategory>;

/** Lista fechada da spec 8.2; `campo.<chave>` vem dos campos declarados no modelo. */
export const TEMPLATE_VARIABLES = [
  "escola.nome",
  "aluno.primeiro_nome",
  "aluno.nome_completo",
  "aluno.data_nascimento",
  "turma.nome",
  "responsavel.nome",
  "responsavel.nome_completo",
  "responsavel.cpf",
  "data.hoje",
  "data.ano_letivo",
] as const;
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

export const TEMPLATE_VARIABLE_LABELS: Record<TemplateVariable, string> = {
  "escola.nome": "Nome da escola",
  "aluno.primeiro_nome": "Primeiro nome do aluno",
  "aluno.nome_completo": "Nome completo do aluno",
  "aluno.data_nascimento": "Data de nascimento do aluno",
  "turma.nome": "Turma",
  "responsavel.nome": "Primeiro nome do responsável",
  "responsavel.nome_completo": "Nome completo do responsável",
  "responsavel.cpf": "CPF do responsável",
  "data.hoje": "Data de hoje",
  "data.ano_letivo": "Ano letivo",
};

export const FieldKey = z.string().regex(/^[a-z][a-z0-9_]{0,29}$/);
export const DocumentFieldType = z.enum(["texto", "data"]);
export type DocumentFieldType = z.infer<typeof DocumentFieldType>;
export const DocumentField = z.object({ key: FieldKey, label: z.string().trim().min(1).max(80), type: DocumentFieldType }).strict();
export type DocumentField = z.infer<typeof DocumentField>;

/** Corpo de criação, nova versão e prévia. */
export const TemplateInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    category: DocumentCategory,
    bodyMd: z.string().trim().min(1).max(20_000),
    fields: z
      .array(DocumentField)
      .max(10)
      .refine((fields) => new Set(fields.map((f) => f.key)).size === fields.length, "duplicate field key"),
  })
  .strict();
export type TemplateInput = z.infer<typeof TemplateInput>;

export const TemplateSummary = z.object({
  id: Uuid,
  groupId: Uuid,
  version: z.number().int().positive(),
  name: z.string(),
  category: DocumentCategory,
  updatedAt: IsoDateTime,
});
export type TemplateSummary = z.infer<typeof TemplateSummary>;
export const TemplateListResponse = z.object({ templates: z.array(TemplateSummary) });
export type TemplateListResponse = z.infer<typeof TemplateListResponse>;

export const Template = TemplateSummary.extend({
  bodyMd: z.string(),
  fields: z.array(DocumentField),
  archived: z.boolean(),
  latest: z.boolean(),
});
export type Template = z.infer<typeof Template>;

export const TemplateExample = z.object({ key: z.string(), name: z.string(), category: DocumentCategory });
export type TemplateExample = z.infer<typeof TemplateExample>;
export const TemplateExampleListResponse = z.object({ examples: z.array(TemplateExample) });
export type TemplateExampleListResponse = z.infer<typeof TemplateExampleListResponse>;
export const CopyExampleRequest = z.object({ exampleKey: z.string().min(1).max(60) }).strict();
export type CopyExampleRequest = z.infer<typeof CopyExampleRequest>;

export const BatchStatus = z.enum(["rendering", "ready", "published"]);
export type BatchStatus = z.infer<typeof BatchStatus>;
export const DocumentStatus = z.enum(["pending", "rendering", "rendered", "failed"]);
export type DocumentStatus = z.infer<typeof DocumentStatus>;

/** POST /api/admin/v1/document-batches */
export const CreateBatchRequest = z
  .object({
    templateId: Uuid,
    studentIds: z
      .array(Uuid)
      .min(1)
      .max(1000)
      .refine((ids) => new Set(ids).size === ids.length, "duplicate student"),
    fieldValues: z.record(FieldKey, z.string().trim().min(1).max(200)),
  })
  .strict();
export type CreateBatchRequest = z.infer<typeof CreateBatchRequest>;

const Count = z.number().int().nonnegative();
/** `failed` não inclui os descartados; `discarded` conta só os descartados. */
export const BatchCounts = z.object({ total: Count, pending: Count, rendering: Count, rendered: Count, failed: Count, discarded: Count });
export type BatchCounts = z.infer<typeof BatchCounts>;

export const BatchSummary = z.object({
  id: Uuid,
  templateId: Uuid,
  templateName: z.string(),
  templateVersion: z.number().int().positive(),
  status: BatchStatus,
  createdAt: IsoDateTime,
  publishedAt: IsoDateTime.nullable(),
  counts: BatchCounts,
  /** Responsáveis que recebem algum documento não descartado. */
  recipients: Count,
  /** Responsáveis que abriram ao menos um documento do lote. */
  viewers: Count,
});
export type BatchSummary = z.infer<typeof BatchSummary>;
export const BatchListResponse = z.object({ batches: z.array(BatchSummary) });
export type BatchListResponse = z.infer<typeof BatchListResponse>;

export const BatchDocument = z.object({
  id: Uuid,
  studentId: Uuid,
  studentFirstName: z.string(),
  className: z.string(),
  guardianId: Uuid.nullable(),
  guardianFirstName: z.string().nullable(),
  status: DocumentStatus,
  discarded: z.boolean(),
  viewed: z.boolean(),
});
export type BatchDocument = z.infer<typeof BatchDocument>;
export const BatchDetail = BatchSummary.extend({
  issuedOn: IsoDate,
  fieldValues: z.record(z.string(), z.string()),
  /** Documentos não descartados sem responsável vinculado hoje ao aluno (ou ao par): não serão enviados a ninguém. */
  unreachable: z.number().int(),
  documents: z.array(BatchDocument),
});
export type BatchDetail = z.infer<typeof BatchDetail>;

/** POST /api/admin/v1/document-batches/:id/render */
export const RenderProgress = z.object({ status: BatchStatus, counts: BatchCounts });
export type RenderProgress = z.infer<typeof RenderProgress>;

/** `error.details` de `document_missing_data`. */
export const MissingDataDetails = z.object({
  missing: z.array(z.object({ studentId: Uuid, guardianId: Uuid.nullable(), variables: z.array(z.string()).min(1) })),
});
export type MissingDataDetails = z.infer<typeof MissingDataDetails>;

/** URL assinada de 5 min (absoluta no GCS, relativa `/api/v1/files?t=` no disco local). */
export const DocumentDownloadResponse = z.object({ url: z.string().min(1), expiresAt: IsoDateTime });
export type DocumentDownloadResponse = z.infer<typeof DocumentDownloadResponse>;

/** GET /api/v1/documents */
export const GuardianDocument = z.object({
  id: Uuid,
  title: z.string(),
  category: DocumentCategory,
  studentFirstName: z.string(),
  publishedAt: IsoDateTime,
  viewed: z.boolean(),
});
export type GuardianDocument = z.infer<typeof GuardianDocument>;
export const GuardianDocumentListResponse = z.object({ documents: z.array(GuardianDocument) });
export type GuardianDocumentListResponse = z.infer<typeof GuardianDocumentListResponse>;
