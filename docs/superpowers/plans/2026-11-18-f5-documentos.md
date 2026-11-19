# F5 — Documentos — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A secretaria mantém modelos versionados de declarações, comunicados e autorizações, marca alunos na lista "Alunos e responsáveis", gera um lote de PDFs, revisa, publica e os responsáveis recebem o link pelo WhatsApp e baixam o PDF por URL assinada de 5 min.

**Architecture:** Na API, um módulo `documents` guarda modelos (`document_templates`, nova versão a cada edição), lotes (`document_batches`), documentos (`documents`, um por aluno ou por par aluno–responsável) e aberturas (`document_views`). O corpo do modelo é um Markdown restrito lido por um parser próprio; as variáveis são resolvidas a partir do cadastro (com os novos campos pessoais de `students` e `guardians`) e o PDF é desenhado com `pdfmake` (fontes padrão Helvetica, sem arquivo de fonte). A renderização roda dentro da requisição: a tela do lote chama `POST …/render` em sequência e cada chamada reserva até 10 documentos com `FOR UPDATE SKIP LOCKED` e arrendamento de 2 min, desenha fora da transação, grava no armazenamento (`platform/storage.ts`: GCS em produção, disco local com URL assinada por HMAC no Docker) e registra o `sha256`. Publicar grava um evento `document.published` por responsável na outbox; o n8n pede um magic link de escopo `documents` e envia o WhatsApp. Na web, páginas novas na área admin (alunos, modelos, geração, lote) e a página `/documentos` do responsável.

**Tech Stack:** Fastify 5, Kysely, PostgreSQL 16 (RLS, `UNIQUE NULLS NOT DISTINCT`), zod 4, **pdfmake 0.3** (novo), **@google-cloud/storage 9** (novo), React 19, react-router 8, Vitest + Testcontainers, Vitest + jsdom + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-16-app-lanche-design.md` (seções 4.1, 4.4, 4.5, 6.3, 8 — autoritativa para esta fase —, 9, 10, 13, 14)

## Global Constraints

- CLAUDE.md inteiro vale. Em especial: todo acesso ao banco dentro de `withTenant(schoolId, …)`; `school_id` só da sessão (ou do caminho HMAC nas rotas internas); nenhuma função `SECURITY DEFINER` nova nesta fase; `getDb` não entra em nenhum arquivo novo (a allowlist do ESLint não muda).
- Toda tabela nova: `school_id uuid NOT NULL`, RLS `tenant_isolation` (`school_id = app_school_id()`), `UNIQUE (school_id, id)`, FKs compostas `(school_id, …)`; entra em `TENANT_TABLES` de `apps/api/src/db/rls.test.ts` (ordem de bytes: `document_batches`, `document_templates`, `document_views`, `documents`, logo depois de `devices`) e em `seedTenant`. Sem `DELETE` para `app_user` nas quatro tabelas; `document_views` sem `UPDATE`.
- `routes.ts` valida com o schema de `@app-lanche/contracts`, chama o `service` e devolve; regra em `service.ts`; SQL em `repo.ts`; arquivos puros (`markdown.ts`, `variables.ts`, `pdf.ts`, `examples.ts`) não tocam o banco. `platform/storage.ts` não toca o banco.
- Toda rota declara `config.auth`. Rotas de equipe de documentos e de "Alunos e responsáveis": `{ kind: "staff", roles: ["admin", "secretaria"] }`. Rotas do responsável: `{ kind: "guardian", scope: ["order", "documents"] }` (Task 9 passa a aceitar lista de escopos).
- `Idempotency-Key` (helper `idempotent` + `requestHash` + `idempotencyKeyFrom`) em: criar modelo, copiar exemplo, nova versão, criar lote, publicar. Naturalmente idempotentes (sem chave, como `/kds/devices/:id/revoke`): arquivar modelo, `render`, descartar documento, `download` (equipe e responsável), `preview` (não grava nada) e os `PUT` de aluno e responsável.
- Transições de estado com `UPDATE … WHERE status = '<anterior>'`; zero linhas = já feito, sem erro e sem efeito colateral. Dedup de abertura por `UNIQUE` + `ON CONFLICT DO NOTHING`.
- Efeito externo só pela outbox (`enqueueEvent`) na transação da publicação. Upload e assinatura de URL acontecem fora de transação.
- LGPD: CPF, nome completo, data de nascimento e telefone nunca em log, em `audit_log.detail`, em mensagens de erro ou em `details` de erro (só ids e nomes de variáveis). O evento `document.published` leva só primeiros nomes, nome do modelo, telefone e ids. CPF mascarado (`***.456.789-**`) nas listas; completo só em `GET /api/admin/v1/guardians/:id` e no PDF.
- Arquivos no armazenamento em `schools/<school_id>/documents/<batch_id>/<document_id>.pdf`; objeto nunca é sobrescrito (`putIfAbsent`); acesso só por URL assinada de 5 min emitida depois de checar a sessão.
- Datas de regra vêm do banco: `issued_on` do lote = `(now() AT TIME ZONE schools.timezone)::date`; arrendamento por `now()` do banco.
- O `CamelCasePlugin` converte chaves aninhadas de `jsonb` ao ler. Leia `fields`, `field_values` e `outbox_events.data` como `::text` e faça `JSON.parse`.
- Contratos novos em `packages/contracts/src/documents.ts` e `cpf.ts`; corpos de `/api` em `camelCase`; dados de evento em `snake_case`. Mudou contrato de evento: schema, exemplo da spec e fixture no mesmo commit (regra 23).
- Dependências novas permitidas, e só estas: `pdfmake@^0.3.14`, `@google-cloud/storage@^9.0.0` (dependências de `apps/api`) e `@types/pdfmake@^0.3.3` (devDependency de `apps/api`). O parser de Markdown é escrito à mão.
- Migração aplicada nunca é editada; esta fase cria a `0009_documents.sql`.
- Texto de interface em português do Brasil exatamente como o plano dá; código, nomes e commits em inglês. Mensagens de commit terminam com:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01K86CbkJPwmS7fPKomVgzip
  ```
- O arquivo não rastreado `prompt.txt` na raiz é do usuário: nunca o commite (use caminhos explícitos no `git add`). Nada de `.superpowers/` nem de build.
- Comandos focados: API `pnpm --filter @app-lanche/api exec vitest run <caminho relativo a apps/api>`; contratos `pnpm --filter @app-lanche/contracts test`; web `pnpm --filter @app-lanche/web exec vitest run <caminho relativo a apps/web>`.
- Regenerar os tipos Kysely depois da migração (da raiz; espere o Postgres aceitar conexões; desligue depois):
  `pnpm db:up; DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/app_lanche APP_DB_PASSWORD=app_user pnpm db:migrate; DATABASE_URL=postgres://postgres:postgres@localhost:5432/app_lanche pnpm db:types; docker compose down`
- Nesta máquina WSL os testes de API (Testcontainers) só passam com o compose desligado: `pnpm app:down` / `docker compose down` antes de `pnpm test`.
- Antes de cada commit: `pnpm typecheck && pnpm lint` e os testes do pacote tocado.

## Decisões da fase (o executor não reabre)

1. **Dados pessoais (spec 8.1, confirmados pelo usuário):** `students.birth_date date`, `guardians.full_name text` (1–200) e `guardians.cpf text CHECK (cpf ~ '^[0-9]{11}$')`; dígitos verificadores validados no zod (`Cpf`, `isValidCpf` em `contracts/src/cpf.ts`). CSV ganha colunas opcionais `nome_completo`, `data_nascimento` (`dd/mm/aaaa` ou `aaaa-mm-dd`), `responsavel_nome_completo`, `responsavel_cpf`; valor vazio nunca apaga o que já existe (`coalesce(excluded.x, tabela.x)`).
2. **Modelos versionados:** `template_group_id` + `version`, `CONSTRAINT document_templates_version UNIQUE (school_id, template_group_id, version)`. Editar = `POST /document-templates/:id/versions` a partir da versão `:id`; se `:id` não é a mais recente, ou outra edição ganhou a corrida (violação da constraint), responde 409 `document_template_outdated`. Arquivar marca `archived_at` em todas as versões do grupo. Variável inválida → 422 `document_template_invalid` com `details.variables`.
3. **Erros com detalhes:** `DomainError(code, message?, details?)`; o envelope passa a ser `{ error: { code, message, details? } }` (`ErrorResponse.details` opcional). Só ids e nomes de variáveis em `details`.
4. **Lote:** um documento por aluno; por par aluno–responsável quando o corpo usa alguma variável `responsavel.*` (`per_guardian`). `CONSTRAINT documents_one_per_recipient UNIQUE NULLS NOT DISTINCT (school_id, batch_id, student_id, guardian_id)`. A conferência prévia recusa com 422 `document_missing_data` e `details.missing = [{ studentId, guardianId|null, variables[] }]`; aluno sem responsável num modelo `per_guardian` aparece com `guardianId: null` e as variáveis `responsavel.*` usadas. Os valores das variáveis são lidos do cadastro na hora de renderizar (não há cópia dos dados pessoais no lote); valor que sumiu entre a criação e a renderização conta como falha de renderização.
5. **Renderização:** `POST /api/admin/v1/document-batches/:id/render` (sem chave) marca como `failed` quem está `rendering` com arrendamento vencido e `attempts >= 3`, reserva até 10 documentos (`pending`, ou `rendering` vencido com `attempts < 3`; `attempts + 1`, `lease_until = now() + 2 min`), desenha fora da transação, faz `putIfAbsent`; se o objeto já existe (tentativa anterior que caiu depois do upload), lê os bytes gravados e registra o `sha256` deles — o objeto nunca é sobrescrito e o hash sempre confere com o arquivo. Registro com `UPDATE … WHERE status = 'rendering' AND attempts = <tentativa reservada>`. Falha volta a `pending` ou vira `failed` na 3ª tentativa. Sem pendentes nem em renderização, o lote passa `rendering → ready`. Teste injeta o renderizador e o armazenamento por um parâmetro `deps` do service.
6. **Descartar:** `POST /api/admin/v1/documents/:id/discard` só para documento `failed` de lote não publicado (`discarded_at`); documento em outro estado → 400 `request_rejected`; lote publicado → 409 `document_batch_published`.
7. **Publicar:** `POST /api/admin/v1/document-batches/:id/publish` com `Idempotency-Key`, trava o lote `FOR UPDATE`; já publicado devolve o resumo sem efeito; exige `ready`, nenhum `failed` não descartado e ao menos um `rendered` (senão 409 `document_batch_not_ready`). Evento `document.published` por responsável: `{ guardian_id, phone, first_name, batch_id, template_name, students[] }`.
8. **Armazenamento:** `STORAGE_DRIVER` (`gcs` padrão | `local`); `gcs` exige `DOCUMENTS_BUCKET`; `local` exige `ENABLE_LOCAL_STORAGE=true` (espelho do guarda de `ENABLE_FAKE_PAYMENTS`) e `LOCAL_STORAGE_DIR`. A URL local é `/api/v1/files?t=<token>`: `payload.assinatura` com HMAC-SHA256 sob uma chave derivada de `SESSION_SECRET` por HKDF (`info = "app-lanche/local-storage-url/v1"`), validade de 5 min. Motivo: o driver local é só de desenvolvimento, não pede segredo novo para configurar, e a separação de domínio do HKDF impede que a chave sirva para assinar sessão (mesmo padrão do token de OTP em `auth/otp.ts`). O token vai na query string porque o log de requisição já descarta a query (`LOG_SERIALIZERS`).
9. **Responsável:** `GET /api/v1/documents` e `POST /api/v1/documents/:id/download` com sessão de escopo `order` ou `documents`. Documento por aluno é visível a todo responsável vinculado ao aluno; documento de par só ao responsável do par. Download insere em `document_views` com `ON CONFLICT ON CONSTRAINT document_views_once DO NOTHING`, grava `audit_log` a cada download e devolve `{ url, expiresAt }`.
10. **Web:** páginas novas `/admin/alunos`, `/admin/documentos`, `/admin/documentos/modelos/novo`, `/admin/documentos/modelos/:id`, `/admin/documentos/gerar/:templateId`, `/admin/documentos/lotes/:id` e `/documentos`; a `AdminHome` ganha os links. jsdom não tem `URL.createObjectURL` nem `window.open` úteis: os testes os substituem por `vi.fn`.

---

## Mapa de arquivos

```
db/migrations/0009_documents.sql                                         (Task 1)
packages/contracts/src/{documents.ts,documents.test.ts,errors.ts,errors.test.ts,index.ts}   (Task 1)
apps/api/src/platform/errors.ts, apps/api/src/app.ts (details no envelope)  (Task 1)
apps/api/src/db/{types.ts,rls.test.ts,schema.test.ts}, apps/api/test/helpers.ts            (Task 1)
docs/superpowers/specs/2026-11-16-app-lanche-design.md (MER)              (Task 1)
packages/contracts/src/{cpf.ts,cpf.test.ts,registry.ts}                   (Task 2)
apps/api/src/modules/registry/{csv.ts,csv.test.ts,repo.ts,service.ts,routes.ts,import.test.ts,people.test.ts}  (Task 2)
db/seed-dev.ts                                                            (Task 2)
apps/api/src/modules/documents/{markdown.ts,variables.ts} (+tests)        (Task 3)
apps/api/src/modules/documents/{pdf.ts,examples.ts} (+tests), apps/api/package.json  (Task 4)
apps/api/src/platform/{config.ts,config.test.ts,storage.ts,storage.test.ts}, apps/api/test/setupEnv.ts  (Task 5)
e2e/playwright.config.ts, docker-compose.yml, apps/api/Dockerfile, docs/{local,deploy}.md    (Task 5)
apps/api/src/modules/documents/{repo.ts,service.ts,routes.ts,templates.test.ts}, apps/api/src/app.ts  (Task 6)
apps/api/src/modules/documents/batches.test.ts                            (Task 7)
apps/api/src/modules/documents/render.test.ts                             (Task 8)
apps/api/src/platform/session.ts (+test), contracts/src/events.ts (+test), spec 6.3, documents/{publish,guardian}.test.ts  (Task 9)
n8n/code/events.js, n8n/workflows/events.json, apps/api/test/n8n.test.ts, docs/n8n.md     (Task 10)
apps/web/src/areas/admin/{StudentsAdmin.tsx,studentFilter.ts,useStaffErrors.ts,AdminHome.tsx} (+tests), apps/web/src/ui/{dates.ts,messages.ts}, App.tsx  (Task 11)
apps/web/src/app/api.ts (+test), apps/web/src/areas/admin/{DocumentsAdmin.tsx,TemplateEditor.tsx,documentLabels.ts} (+test)  (Task 12)
apps/web/src/areas/admin/{GenerateBatch.tsx,BatchPage.tsx} (+test)        (Task 13)
apps/web/src/areas/guardian/{DocumentsPage.tsx,OrderHome.tsx} (+test), spec 14       (Task 14)
```

---

### Task 1: Esquema, contratos de documentos e erros com detalhes

**Files:**
- Create: `db/migrations/0009_documents.sql`
- Create: `packages/contracts/src/documents.ts`, `packages/contracts/src/documents.test.ts`
- Modify: `packages/contracts/src/errors.ts`, `packages/contracts/src/errors.test.ts`, `packages/contracts/src/index.ts`
- Modify: `apps/api/src/platform/errors.ts`, `apps/api/src/app.ts` (error handler)
- Regenerate: `apps/api/src/db/types.ts`
- Modify: `apps/api/src/db/rls.test.ts`, `apps/api/src/db/schema.test.ts`, `apps/api/test/helpers.ts`
- Modify: `docs/superpowers/specs/2026-11-16-app-lanche-design.md` (MER, seção 9)

**Interfaces:**
- Produces (banco): colunas `students.birth_date`, `guardians.full_name`, `guardians.cpf`; tabelas `document_templates`, `document_batches`, `documents`, `document_views` (colunas abaixo); constraints `document_templates_version`, `documents_one_per_recipient`, `document_views_once`.
- Produces (contracts): `DocumentCategory`, `TEMPLATE_VARIABLES`, `TemplateVariable`, `TEMPLATE_VARIABLE_LABELS`, `FieldKey`, `DocumentFieldType`, `DocumentField`, `TemplateInput`, `TemplateSummary`, `TemplateListResponse`, `Template`, `TemplateExample`, `TemplateExampleListResponse`, `CopyExampleRequest`, `BatchStatus`, `DocumentStatus`, `CreateBatchRequest`, `BatchCounts`, `BatchSummary`, `BatchListResponse`, `BatchDocument`, `BatchDetail`, `RenderProgress`, `MissingDataDetails`, `DocumentDownloadResponse`, `GuardianDocument`, `GuardianDocumentListResponse` (cada um com `type` homônimo).
- Produces (erros): códigos `document_template_invalid` (422), `document_template_outdated` (409), `document_missing_data` (422), `document_batch_not_ready` (409), `document_batch_published` (409); `new DomainError(code, message?, details?: Record<string, unknown>)`; `ErrorResponse.error.details` opcional.
- Produces (testes): `SeedIds` ganha `documentTemplateId`, `documentBatchId`, `documentId`.

- [ ] **Step 1: Contratos (teste falha)**

`packages/contracts/src/documents.ts`:

```ts
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
```

`index.ts`: `export * from "./documents";` (entre `./common` e `./errors`).

`errors.ts`: acrescente antes de `"internal_error"`:

```ts
  "document_template_invalid",
  "document_template_outdated",
  "document_missing_data",
  "document_batch_not_ready",
  "document_batch_published",
```

e troque `ErrorResponse` por:

```ts
export const ErrorResponse = z.object({
  error: z.object({ code: ErrorCode, message: z.string(), details: z.record(z.string(), z.unknown()).optional() }),
});
```

`packages/contracts/src/documents.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CreateBatchRequest, TEMPLATE_VARIABLE_LABELS, TEMPLATE_VARIABLES, TemplateInput } from "./documents";

const U = (n: number) => `0193a3b0-0000-7000-8000-${String(n).padStart(12, "0")}`;
const base = { name: "Autorização", category: "autorizacao", bodyMd: "# Oi", fields: [] };

describe("document contracts", () => {
  it("labels every template variable", () => {
    expect(Object.keys(TEMPLATE_VARIABLE_LABELS).sort()).toEqual([...TEMPLATE_VARIABLES].sort());
  });

  it("accepts up to 10 fields with snake_case keys and rejects duplicates or bad keys", () => {
    const field = (key: string) => ({ key, label: "Rótulo", type: "texto" });
    expect(TemplateInput.parse({ ...base, fields: [field("data_passeio")] }).fields).toHaveLength(1);
    expect(() => TemplateInput.parse({ ...base, fields: Array.from({ length: 11 }, (_, i) => field(`c${i}`)) })).toThrow();
    expect(() => TemplateInput.parse({ ...base, fields: [field("a"), field("a")] })).toThrow();
    for (const key of ["Data", "1a", "a-b", "a".repeat(31)]) {
      expect(() => TemplateInput.parse({ ...base, fields: [field(key)] })).toThrow();
    }
    expect(() => TemplateInput.parse({ ...base, fields: [{ key: "x", label: "X", type: "numero" }] })).toThrow();
  });

  it("refuses duplicate students and unknown field keys in a batch", () => {
    const ok = { templateId: U(1), studentIds: [U(2), U(3)], fieldValues: { destino: "Zoológico" } };
    expect(CreateBatchRequest.parse(ok)).toEqual(ok);
    expect(() => CreateBatchRequest.parse({ ...ok, studentIds: [U(2), U(2)] })).toThrow();
    expect(() => CreateBatchRequest.parse({ ...ok, fieldValues: { Destino: "x" } })).toThrow();
    expect(() => CreateBatchRequest.parse({ ...ok, fieldValues: { destino: "  " } })).toThrow();
    expect(() => CreateBatchRequest.parse({ ...ok, studentIds: [] })).toThrow();
  });
});
```

`errors.test.ts` — acrescente:

```ts
  it("accepts optional details", () => {
    const parsed = ErrorResponse.parse({ error: { code: "document_missing_data", message: "x", details: { missing: [] } } });
    expect(parsed.error.details).toEqual({ missing: [] });
  });
```

Run: `pnpm --filter @app-lanche/contracts test` → FAIL (módulo `./documents` não existe).

- [ ] **Step 2: Testes de esquema (falham)**

`rls.test.ts`: `TENANT_TABLES` ganha, depois de `"devices"`: `"document_batches"`, `"document_templates"`, `"document_views"`, `"documents"`.

`schema.test.ts` — novo bloco no fim (importe `seedFamily` de `../../test/helpers` se ainda não estiver importado):

```ts
describe("F5 schema", () => {
  it.each(["document_templates", "document_batches", "documents", "document_views"])(
    "%s cannot be deleted by the application",
    async (table) => {
      const { rows } = await sql<{ del: boolean }>`SELECT has_table_privilege('app_user', ${table}, 'DELETE') AS del`.execute(adminDb());
      expect(rows[0]).toEqual({ del: false });
    },
  );

  it("makes document views append-only", async () => {
    const { rows } = await sql<{ upd: boolean; ins: boolean }>`
      SELECT has_table_privilege('app_user', 'document_views', 'UPDATE') AS upd,
             has_table_privilege('app_user', 'document_views', 'INSERT') AS ins`.execute(adminDb());
    expect(rows[0]).toEqual({ upd: false, ins: true });
  });

  it("accepts only 11-digit CPFs", async () => {
    const schoolId = await createSchool();
    const ids = await seedTenant(schoolId);
    const setCpf = (cpf: string) => adminDb().updateTable("guardians").set({ cpf }).where("id", "=", ids.guardianId).execute();
    await setCpf("52998224725");
    await expect(setCpf("529.982.247-25")).rejects.toThrow(/check constraint/);
    await expect(setCpf("123")).rejects.toThrow(/check constraint/);
  });

  it("keeps template versions unique per group", async () => {
    const schoolId = await createSchool();
    const ids = await seedTenant(schoolId);
    const insert = () =>
      adminDb()
        .insertInto("documentTemplates")
        .values({ id: uuidv7(), schoolId, templateGroupId: ids.documentTemplateId, version: 1, name: "X", category: "outro", bodyMd: "x", fields: JSON.stringify([]), createdBy: ids.staffUserId })
        .execute();
    await expect(insert()).rejects.toThrow(/document_templates_version/);
  });

  it("allows one document per student and recipient in a batch, nulls included", async () => {
    const schoolId = await createSchool();
    const ids = await seedTenant(schoolId);
    const doc = (guardianId: string | null) =>
      adminDb().insertInto("documents").values({ id: uuidv7(), schoolId, batchId: ids.documentBatchId, studentId: ids.studentId, guardianId }).execute();
    await expect(doc(null)).rejects.toThrow(/documents_one_per_recipient/);
    await doc(ids.guardianId);
    await expect(doc(ids.guardianId)).rejects.toThrow(/documents_one_per_recipient/);
  });

  it("requires the hash and path of a rendered document and a lease while rendering", async () => {
    const schoolId = await createSchool();
    const ids = await seedTenant(schoolId);
    const fam = await seedFamily(schoolId, ["Caio"]);
    await expect(
      adminDb().insertInto("documents").values({ id: uuidv7(), schoolId, batchId: ids.documentBatchId, studentId: fam.studentIds[0]!, status: "rendered" }).execute(),
    ).rejects.toThrow(/check constraint/);
    await expect(
      adminDb().insertInto("documents").values({ id: uuidv7(), schoolId, batchId: ids.documentBatchId, studentId: fam.studentIds[0]!, status: "rendering" }).execute(),
    ).rejects.toThrow(/check constraint/);
  });

  it("refuses a document for a student of another school", async () => {
    const a = await createSchool();
    const b = await createSchool();
    const seedA = await seedTenant(a);
    const seedB = await seedTenant(b);
    await expect(
      adminDb().insertInto("documents").values({ id: uuidv7(), schoolId: a, batchId: seedA.documentBatchId, studentId: seedB.studentId }).execute(),
    ).rejects.toThrow(/foreign key/i);
  });
});
```

Run: `pnpm --filter @app-lanche/api exec vitest run src/db` → FAIL.

- [ ] **Step 3: Migração**

`db/migrations/0009_documents.sql`:

```sql
-- F5: documentos — dados pessoais confirmados pela escola (spec 8.1), modelos, lotes, documentos e aberturas (spec 8, 9).

ALTER TABLE students ADD COLUMN birth_date date;
ALTER TABLE guardians
  ADD COLUMN full_name text CHECK (length(full_name) BETWEEN 1 AND 200),
  ADD COLUMN cpf text CHECK (cpf ~ '^[0-9]{11}$');

CREATE TABLE document_templates (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  template_group_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  category text NOT NULL CHECK (category IN ('declaracao', 'comunicado', 'autorizacao', 'outro')),
  body_md text NOT NULL CHECK (length(body_md) BETWEEN 1 AND 20000),
  fields jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(fields) = 'array' AND jsonb_array_length(fields) <= 10),
  created_by uuid NOT NULL,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  CONSTRAINT document_templates_version UNIQUE (school_id, template_group_id, version),
  FOREIGN KEY (school_id, created_by) REFERENCES staff_users (school_id, id)
);

CREATE TABLE document_batches (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  template_id uuid NOT NULL,
  field_values jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(field_values) = 'object'),
  issued_on date NOT NULL,
  per_guardian boolean NOT NULL,
  created_by uuid NOT NULL,
  status text NOT NULL DEFAULT 'rendering' CHECK (status IN ('rendering', 'ready', 'published')),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  FOREIGN KEY (school_id, template_id) REFERENCES document_templates (school_id, id),
  FOREIGN KEY (school_id, created_by) REFERENCES staff_users (school_id, id),
  CHECK ((status = 'published') = (published_at IS NOT NULL))
);

CREATE TABLE documents (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  batch_id uuid NOT NULL,
  student_id uuid NOT NULL,
  guardian_id uuid,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'rendering', 'rendered', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  lease_until timestamptz,
  storage_path text,
  sha256 text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  rendered_at timestamptz,
  discarded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  CONSTRAINT documents_one_per_recipient UNIQUE NULLS NOT DISTINCT (school_id, batch_id, student_id, guardian_id),
  FOREIGN KEY (school_id, batch_id) REFERENCES document_batches (school_id, id),
  FOREIGN KEY (school_id, student_id) REFERENCES students (school_id, id),
  FOREIGN KEY (school_id, guardian_id) REFERENCES guardians (school_id, id),
  CHECK ((status = 'rendered') = (storage_path IS NOT NULL AND sha256 IS NOT NULL AND rendered_at IS NOT NULL)),
  CHECK ((status = 'rendering') = (lease_until IS NOT NULL)),
  CHECK (discarded_at IS NULL OR status = 'failed')
);

CREATE INDEX documents_batch_status ON documents (school_id, batch_id, status);

CREATE TABLE document_views (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  document_id uuid NOT NULL,
  guardian_id uuid NOT NULL,
  first_viewed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  CONSTRAINT document_views_once UNIQUE (school_id, document_id, guardian_id),
  FOREIGN KEY (school_id, document_id) REFERENCES documents (school_id, id),
  FOREIGN KEY (school_id, guardian_id) REFERENCES guardians (school_id, id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['document_templates', 'document_batches', 'documents', 'document_views']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (school_id = app_school_id())', t);
  END LOOP;
END $$;

-- Nada é apagado: modelo arquiva, documento falho é descartado, abertura só é registrada.
GRANT SELECT, INSERT, UPDATE ON document_templates, document_batches, documents TO app_user;
GRANT SELECT, INSERT ON document_views TO app_user;
```

- [ ] **Step 4: Tipos, semente e detalhes de erro**

Regenere os tipos (comando em Global Constraints).

`apps/api/test/helpers.ts`: `SeedIds` ganha `documentTemplateId`, `documentBatchId`, `documentId` (gere com `uuidv7()` no literal de `ids`); no fim de `seedTenant`, antes do `return ids`:

```ts
  await db
    .insertInto("documentTemplates")
    .values({ id: ids.documentTemplateId, schoolId, templateGroupId: ids.documentTemplateId, version: 1, name: "Semente", category: "outro", bodyMd: "# Semente", fields: JSON.stringify([]), createdBy: ids.staffUserId })
    .execute();
  await db
    .insertInto("documentBatches")
    .values({ id: ids.documentBatchId, schoolId, templateId: ids.documentTemplateId, fieldValues: JSON.stringify({}), issuedOn: "2099-12-31", perGuardian: false, createdBy: ids.staffUserId, status: "published", publishedAt: new Date() })
    .execute();
  await db
    .insertInto("documents")
    .values({
      id: ids.documentId,
      schoolId,
      batchId: ids.documentBatchId,
      studentId: ids.studentId,
      status: "rendered",
      storagePath: `schools/${schoolId}/documents/${ids.documentBatchId}/${ids.documentId}.pdf`,
      sha256: "0".repeat(64),
      renderedAt: new Date(),
    })
    .execute();
  await db.insertInto("documentViews").values({ id: uuidv7(), schoolId, documentId: ids.documentId, guardianId: ids.guardianId }).execute();
```

(O documento da semente não tem arquivo: testes de download usam famílias de `seedFamily`, nunca o responsável da semente.)

`apps/api/src/platform/errors.ts` — acrescente ao `STATUS`:

```ts
  document_template_invalid: 422,
  document_template_outdated: 409,
  document_missing_data: 422,
  document_batch_not_ready: 409,
  document_batch_published: 409,
```

e troque o construtor:

```ts
export class DomainError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message?: string,
    /** Só ids, contagens e nomes de variáveis: nunca dado pessoal (vai no corpo da resposta). */
    public readonly details?: Record<string, unknown>,
  ) {
    super(message ?? code);
  }
```

`apps/api/src/app.ts`, no `setErrorHandler`:

```ts
    if (err instanceof DomainError) {
      return reply
        .status(err.status)
        .send({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
    }
```

Spec seção 9 (MER): em `students` acrescente `date birth_date`; em `guardians`, `text full_name` e `text cpf`; em `document_templates`, `uuid created_by FK` e `timestamptz created_at`; em `document_batches`, `date issued_on` e `bool per_guardian`; em `documents`, `int attempts`, `timestamptz lease_until`, `timestamptz rendered_at`, `timestamptz discarded_at`. Nas "Unicidades relevantes", acrescente `document_templates (school_id, template_group_id, version)`, `documents (school_id, batch_id, student_id, guardian_id)` com nulos iguais e `document_views (school_id, document_id, guardian_id)`.

- [ ] **Step 5: Rodar e commitar**

Run: `pnpm --filter @app-lanche/contracts test && pnpm --filter @app-lanche/api exec vitest run src/db && pnpm typecheck && pnpm lint` → PASS.

```bash
git add db/migrations/0009_documents.sql packages/contracts/src apps/api/src/db apps/api/src/platform/errors.ts apps/api/src/app.ts apps/api/test/helpers.ts docs/superpowers/specs/2026-11-16-app-lanche-design.md
git commit -m "feat(db): add document templates, batches, documents and views with personal fields"
```

---

### Task 2: CPF, campos pessoais, importação CSV e edição de alunos e responsáveis (API)

**Files:**
- Create: `packages/contracts/src/cpf.ts`, `packages/contracts/src/cpf.test.ts`; Modify: `packages/contracts/src/registry.ts`, `packages/contracts/src/index.ts`
- Modify: `apps/api/src/modules/registry/{csv.ts,csv.test.ts,repo.ts,service.ts,routes.ts,import.test.ts}`
- Create: `apps/api/src/modules/registry/people.test.ts`
- Modify: `db/seed-dev.ts`

**Interfaces:**
- Consumes: colunas da Task 1.
- Produces (contracts): `isValidCpf(digits: string): boolean`, `Cpf` (zod: aceita com ou sem pontuação, devolve 11 dígitos), `maskCpf(digits): string` (`***.456.789-**`), `formatCpf(digits): string` (`123.456.789-09`), `PersonName`; `StudentListResponse` (cada aluno ganha `fullName`, `birthDate`, `classId`; cada responsável ganha `fullName` e `cpfMasked`), `UpdateStudentRequest`, `GuardianDetail`, `UpdateGuardianRequest` (com `type` homônimos).
- Produces (rotas): `PUT /api/admin/v1/students/:id` → 204; `GET /api/admin/v1/guardians/:id` → `GuardianDetail`; `PUT /api/admin/v1/guardians/:id` → 204.
- Produces (csv): `StudentRow` com `fullName`, `birthDate`, `guardianFullName`, `guardianCpf` (`string | null`); `parseBirthDate(raw): string | null`.

- [ ] **Step 1: Contratos de CPF e cadastro (teste falha)**

`packages/contracts/src/cpf.ts`:

```ts
import { z } from "zod";

/** 11 dígitos com os dois verificadores corretos; sequências repetidas (111…) são inválidas. */
export function isValidCpf(digits: string): boolean {
  if (!/^\d{11}$/.test(digits) || /^(\d)\1{10}$/.test(digits)) return false;
  const n = [...digits].map(Number);
  const check = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i += 1) sum += n[i]! * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return check(9) === n[9] && check(10) === n[10];
}

/** Aceita "529.982.247-25" ou "52998224725"; devolve só os dígitos. */
export const Cpf = z
  .string()
  .transform((s) => s.replace(/[.\-\s]/g, ""))
  .pipe(z.string().regex(/^\d{11}$/).refine(isValidCpf, "invalid cpf"));

export function maskCpf(digits: string): string {
  return `***.${digits.slice(3, 6)}.${digits.slice(6, 9)}-**`;
}

export function formatCpf(digits: string): string {
  return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
}
```

`packages/contracts/src/cpf.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Cpf, formatCpf, isValidCpf, maskCpf } from "./cpf";

describe("cpf", () => {
  it.each(["52998224725", "11144477735", "12345678909"])("accepts %s", (cpf) => {
    expect(isValidCpf(cpf)).toBe(true);
  });

  it.each(["52998224724", "12345678900", "11111111111", "1234567890", "abcdefghijk"])("rejects %s", (cpf) => {
    expect(isValidCpf(cpf)).toBe(false);
  });

  it("normalizes punctuation and masks and formats", () => {
    expect(Cpf.parse("529.982.247-25")).toBe("52998224725");
    expect(() => Cpf.parse("529.982.247-24")).toThrow();
    expect(maskCpf("12345678909")).toBe("***.456.789-**");
    expect(formatCpf("12345678909")).toBe("123.456.789-09");
  });
});
```

`index.ts`: `export * from "./cpf";` (entre `./common` e `./documents`).

`packages/contracts/src/registry.ts` — troque `StudentListResponse` e acrescente:

```ts
import { z } from "zod";
import { IsoDate, Uuid } from "./common";
import { Cpf } from "./cpf";

// (ImportStudentsRequest, ImportStudentsResponse e ClassListResponse continuam como estão)

export const PersonName = z.string().trim().min(1).max(200);

export const StudentListResponse = z.object({
  students: z.array(
    z.object({
      id: Uuid,
      externalCode: z.string(),
      firstName: z.string(),
      fullName: z.string().nullable(),
      birthDate: IsoDate.nullable(),
      classId: Uuid,
      className: z.string(),
      guardians: z.array(
        z.object({ id: Uuid, firstName: z.string(), fullName: z.string().nullable(), phone: z.string(), cpfMasked: z.string().nullable() }),
      ),
    }),
  ),
});
export type StudentListResponse = z.infer<typeof StudentListResponse>;

/** PUT /api/admin/v1/students/:id — null apaga o valor. */
export const UpdateStudentRequest = z.object({ fullName: PersonName.nullable(), birthDate: IsoDate.nullable() }).strict();
export type UpdateStudentRequest = z.infer<typeof UpdateStudentRequest>;

/** GET /api/admin/v1/guardians/:id — único lugar com o CPF completo (formulário de edição). */
export const GuardianDetail = z.object({ id: Uuid, firstName: z.string(), fullName: z.string().nullable(), cpf: z.string().nullable() });
export type GuardianDetail = z.infer<typeof GuardianDetail>;

export const UpdateGuardianRequest = z.object({ fullName: PersonName.nullable(), cpf: Cpf.nullable() }).strict();
export type UpdateGuardianRequest = z.infer<typeof UpdateGuardianRequest>;
```

Run: `pnpm --filter @app-lanche/contracts test` → FAIL antes de criar `cpf.ts`, PASS depois.

- [ ] **Step 2: CSV com colunas opcionais (teste falha)**

`csv.test.ts`: o primeiro teste (`parses rows and normalizes phones`) passa a esperar também `fullName: null, birthDate: null, guardianFullName: null, guardianCpf: null`. Acrescente:

```ts
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

  it("keeps working without the optional columns", () => {
    const { rows, errors } = parseStudentsCsv(`${HEADER}\nA001,Léo,Infantil 3A,Ana,11999990001\n`);
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({ fullName: null, guardianCpf: null });
  });
});
```

Run: `pnpm --filter @app-lanche/api exec vitest run src/modules/registry/csv.test.ts` → FAIL.

- [ ] **Step 3: Implementar o CSV**

`csv.ts` — importe `isValidCpf` de `@app-lanche/contracts`; `StudentRow` ganha os quatro campos `string | null`; acrescente:

```ts
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
```

No laço, depois de validar o telefone e antes de montar `row`:

```ts
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
      errors.push({ line, message: "responsavel_cpf inválido" });
      return;
    }
```

`row` recebe `fullName`, `birthDate`, `guardianFullName`, `guardianCpf`. A checagem de aluno repetido passa a comparar também `fullName` e `birthDate` quando os dois lados são não nulos. Depois dela, a mesma checagem para o responsável (declare `const guardianSeen = new Map<string, StudentRow>()` junto de `firstSeen`):

```ts
    const differs = (a: string | null, b: string | null) => a !== null && b !== null && a !== b;
    const g = guardianSeen.get(row.guardianPhone);
    if (!g) {
      guardianSeen.set(row.guardianPhone, row);
    } else if (differs(g.guardianCpf, row.guardianCpf) || differs(g.guardianFullName, row.guardianFullName)) {
      errors.push({ line, message: "responsavel_telefone repetido com dados diferentes" });
      return;
    }
```

Run do Step 2 → PASS.

- [ ] **Step 4: Importação e edição (testes falham)**

`import.test.ts` — acrescente:

```ts
  it("imports the optional personal columns and never erases them on a later import without values", async () => {
    const schoolId = await createSchool();
    const cookies = await staffCookie(schoolId);
    const header = "codigo_aluno,primeiro_nome,turma,responsavel_nome,responsavel_telefone,nome_completo,data_nascimento,responsavel_nome_completo,responsavel_cpf";
    const full = `${header}\nA001,Léo,Infantil 3A,Ana,(11) 99999-0001,Leonardo Souza,15/03/2021,Ana Paula Souza,529.982.247-25`;
    expect((await importCsv(cookies, full)).json()).toMatchObject({ applied: true });
    expect((await importCsv(cookies, CSV)).json()).toMatchObject({ applied: true });
    const student = await adminDb().selectFrom("students").select(["fullName", "birthDate"]).where("schoolId", "=", schoolId).where("externalCode", "=", "A001").executeTakeFirstOrThrow();
    expect(student).toEqual({ fullName: "Leonardo Souza", birthDate: "2021-03-15" });
    const guardian = await adminDb().selectFrom("guardians").select(["fullName", "cpf"]).where("schoolId", "=", schoolId).where("phoneE164", "=", "+5511999990001").executeTakeFirstOrThrow();
    expect(guardian).toEqual({ fullName: "Ana Paula Souza", cpf: "52998224725" });
  });
```

`apps/api/src/modules/registry/people.test.ts`:

```ts
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { adminDb, createSchool, seedFamily, staffCookie } from "../../../test/helpers";
import { buildApp } from "../../app";

async function family() {
  const schoolId = await createSchool();
  const fam = await seedFamily(schoolId, ["Léo"]);
  await adminDb().updateTable("guardians").set({ fullName: "Ana Paula Souza", cpf: "12345678909" }).where("id", "=", fam.guardianId).execute();
  const { cookies } = await staffCookie(schoolId, "secretaria");
  return { schoolId, ...fam, studentId: fam.studentIds[0]!, cookies };
}

describe("students and guardians (staff)", () => {
  it("lists personal fields with the CPF masked and never in full", async () => {
    const f = await family();
    await adminDb().updateTable("students").set({ fullName: "Leonardo Souza", birthDate: "2021-03-15" }).where("id", "=", f.studentId).execute();
    const res = await buildApp().inject({ method: "GET", url: "/api/admin/v1/students", cookies: f.cookies });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("12345678909");
    expect(res.json().students[0]).toMatchObject({
      fullName: "Leonardo Souza",
      birthDate: "2021-03-15",
      guardians: [{ id: f.guardianId, fullName: "Ana Paula Souza", cpfMasked: "***.456.789-**" }],
    });
  });

  it("updates a student and audits without values", async () => {
    const f = await family();
    const app = buildApp();
    const res = await app.inject({ method: "PUT", url: `/api/admin/v1/students/${f.studentId}`, cookies: f.cookies, payload: { fullName: " Leonardo Souza ", birthDate: "2021-03-15" } });
    expect(res.statusCode).toBe(204);
    const row = await adminDb().selectFrom("students").select(["fullName", "birthDate"]).where("id", "=", f.studentId).executeTakeFirstOrThrow();
    expect(row).toEqual({ fullName: "Leonardo Souza", birthDate: "2021-03-15" });
    const audit = await adminDb().selectFrom("auditLog").select(["action", sql<string>`detail::text`.as("detail")]).where("schoolId", "=", f.schoolId).where("action", "=", "student.updated").executeTakeFirstOrThrow();
    expect(audit.detail).not.toContain("Leonardo");
    const clear = await app.inject({ method: "PUT", url: `/api/admin/v1/students/${f.studentId}`, cookies: f.cookies, payload: { fullName: null, birthDate: null } });
    expect(clear.statusCode).toBe(204);
  });

  it("shows the full CPF only in the guardian detail and stores digits only", async () => {
    const f = await family();
    const app = buildApp();
    const detail = await app.inject({ method: "GET", url: `/api/admin/v1/guardians/${f.guardianId}`, cookies: f.cookies });
    expect(detail.json()).toEqual({ id: f.guardianId, firstName: "Ana", fullName: "Ana Paula Souza", cpf: "12345678909" });
    const put = await app.inject({ method: "PUT", url: `/api/admin/v1/guardians/${f.guardianId}`, cookies: f.cookies, payload: { fullName: "Ana P. Souza", cpf: "529.982.247-25" } });
    expect(put.statusCode).toBe(204);
    const row = await adminDb().selectFrom("guardians").select(["fullName", "cpf"]).where("id", "=", f.guardianId).executeTakeFirstOrThrow();
    expect(row).toEqual({ fullName: "Ana P. Souza", cpf: "52998224725" });
    const bad = await app.inject({ method: "PUT", url: `/api/admin/v1/guardians/${f.guardianId}`, cookies: f.cookies, payload: { fullName: null, cpf: "529.982.247-24" } });
    expect(bad.statusCode).toBe(400);
  });

  it("answers 404 for another school's records and 403 for the kitchen role", async () => {
    const f = await family();
    const other = await family();
    const app = buildApp();
    const res = await app.inject({ method: "PUT", url: `/api/admin/v1/students/${other.studentId}`, cookies: f.cookies, payload: { fullName: "X", birthDate: null } });
    expect(res.statusCode).toBe(404);
    const g = await app.inject({ method: "GET", url: `/api/admin/v1/guardians/${other.guardianId}`, cookies: f.cookies });
    expect(g.statusCode).toBe(404);
    const { cookies } = await staffCookie(f.schoolId, "cozinha");
    const k = await app.inject({ method: "GET", url: `/api/admin/v1/guardians/${f.guardianId}`, cookies });
    expect(k.statusCode).toBe(403);
  });
});
```

Run: `pnpm --filter @app-lanche/api exec vitest run src/modules/registry` → FAIL.

- [ ] **Step 5: Repo, service e rotas**

`registry/repo.ts`:
- `upsertStudent` recebe também `fullName: string | null; birthDate: string | null`; o `doUpdateSet` passa a ser
  ```ts
  .onConflict((oc) =>
    oc.columns(["schoolId", "externalCode"]).doUpdateSet({
      firstName: row.firstName,
      classId: row.classId,
      fullName: sql<string | null>`coalesce(excluded.full_name, students.full_name)`,
      birthDate: sql<string | null>`coalesce(excluded.birth_date, students.birth_date)`,
    }),
  )
  ```
- `upsertGuardian` recebe `fullName` e `cpf` e faz o mesmo com `coalesce(excluded.full_name, guardians.full_name)` e `coalesce(excluded.cpf, guardians.cpf)`.
- `listStudents` seleciona também `"students.fullName"`, `"students.birthDate"`, `"students.classId"`; `listGuardianLinks` também `"guardians.fullName"`, `"guardians.cpf"`.
- Novas:

```ts
export async function updateStudent(trx: Trx, id: string, values: { fullName: string | null; birthDate: string | null }): Promise<boolean> {
  const res = await trx.updateTable("students").set(values).where("id", "=", id).executeTakeFirst();
  return res.numUpdatedRows > 0n;
}

export async function findGuardian(trx: Trx, id: string) {
  return trx.selectFrom("guardians").select(["id", "firstName", "fullName", "cpf"]).where("id", "=", id).executeTakeFirst();
}

export async function updateGuardian(trx: Trx, id: string, values: { fullName: string | null; cpf: string | null }): Promise<boolean> {
  const res = await trx.updateTable("guardians").set(values).where("id", "=", id).executeTakeFirst();
  return res.numUpdatedRows > 0n;
}
```

`registry/service.ts`:
- `importStudents` chama `upsertStudent` e `upsertGuardian` **em toda linha** (não só na primeira de cada código/telefone), passando os campos novos; os `Map` continuam guardando o id e as contagens continuam sendo `map.size`. Assim um valor que só aparece numa linha posterior do mesmo responsável é gravado, e o `coalesce` nunca apaga.
- `listStudents` monta cada responsável explicitamente (nunca espalhe a linha, que traz o CPF):
  ```ts
  .map((l) => ({ id: l.id, firstName: l.firstName, fullName: l.fullName, phone: l.phone, cpfMasked: l.cpf ? maskCpf(l.cpf) : null }))
  ```
- Novas (importe `DomainError`, `maskCpf`, `UpdateStudentRequest`, `UpdateGuardianRequest`, `GuardianDetail`):

```ts
export async function updateStudent(session: SessionClaims, studentId: string, body: UpdateStudentRequest): Promise<void> {
  await withTenant(session.schoolId, async (trx) => {
    if (!(await repo.updateStudent(trx, studentId, body))) throw new DomainError("not_found");
    await audit(trx, { schoolId: session.schoolId, actorKind: "staff", actorId: session.sub, action: "student.updated", detail: { student_id: studentId, fields: ["full_name", "birth_date"] } });
  });
}

export async function getGuardian(session: SessionClaims, guardianId: string): Promise<GuardianDetail> {
  const row = await withTenant(session.schoolId, (trx) => repo.findGuardian(trx, guardianId));
  if (!row) throw new DomainError("not_found");
  return row;
}

export async function updateGuardian(session: SessionClaims, guardianId: string, body: UpdateGuardianRequest): Promise<void> {
  await withTenant(session.schoolId, async (trx) => {
    if (!(await repo.updateGuardian(trx, guardianId, body))) throw new DomainError("not_found");
    await audit(trx, { schoolId: session.schoolId, actorKind: "staff", actorId: session.sub, action: "guardian.updated", detail: { guardian_id: guardianId, fields: ["full_name", "cpf"] } });
  });
}
```

`registry/routes.ts` (importe `Uuid`, `UpdateStudentRequest`, `UpdateGuardianRequest`, `z`):

```ts
const IdParams = z.object({ id: Uuid });

  // PUT é idempotente por natureza: repetir grava os mesmos valores (sem Idempotency-Key).
  app.put("/api/admin/v1/students/:id", { config: { auth: OFFICE } }, async (req, reply) => {
    await service.updateStudent(req.session!, IdParams.parse(req.params).id, UpdateStudentRequest.parse(req.body));
    return reply.status(204).send();
  });

  app.get("/api/admin/v1/guardians/:id", { config: { auth: OFFICE } }, async (req) =>
    service.getGuardian(req.session!, IdParams.parse(req.params).id),
  );

  app.put("/api/admin/v1/guardians/:id", { config: { auth: OFFICE } }, async (req, reply) => {
    await service.updateGuardian(req.session!, IdParams.parse(req.params).id, UpdateGuardianRequest.parse(req.body));
    return reply.status(204).send();
  });
```

Run: `pnpm --filter @app-lanche/api exec vitest run src/modules/registry` → PASS.

- [ ] **Step 6: Semente de demonstração**

`db/seed-dev.ts`: `guardians` ganham `full` e `cpf` fictícios (`Ana Paula Souza`/`52998224725`, `Bruno Lima`/`11144477735`, `Carla Alves`/`12345678909`); `students` ganham `birth` (`2021-03-15`, `2022-07-02`, `2021-11-20`, `2020-05-08`). Os inserts passam a atualizar quem já existe no volume:

```ts
    await db.query(
      `INSERT INTO guardians (id, school_id, phone_e164, first_name, full_name, cpf) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, cpf = EXCLUDED.cpf`,
      [g.id, SCHOOL, g.phone, g.first, g.full, g.cpf],
    );
```

```ts
    await db.query(
      `INSERT INTO students (id, school_id, class_id, external_code, first_name, full_name, birth_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, birth_date = EXCLUDED.birth_date`,
      [s.id, SCHOOL, classes[s.cls]!.id, s.code, s.first, s.full, s.birth],
    );
```

Comentário no topo: `// CPFs are well-known fictitious test numbers with valid check digits.`

- [ ] **Step 7: Rodar e commitar**

Run: `pnpm --filter @app-lanche/contracts test && pnpm --filter @app-lanche/api exec vitest run src/modules/registry && pnpm typecheck && pnpm lint` → PASS.

```bash
git add packages/contracts/src apps/api/src/modules/registry db/seed-dev.ts
git commit -m "feat(registry): store full names, birth dates and CPFs from CSV and the staff edit routes"
```

---
### Task 3: Markdown restrito e variáveis (módulos puros)

**Files:**
- Create: `apps/api/src/modules/documents/markdown.ts`, `apps/api/src/modules/documents/markdown.test.ts`
- Create: `apps/api/src/modules/documents/variables.ts`, `apps/api/src/modules/documents/variables.test.ts`

**Interfaces:**
- Consumes: `TEMPLATE_VARIABLES`, `DocumentField` (Task 1); `formatCpf` (Task 2).
- Produces (`markdown.ts`): `type Inline = { text: string; bold: boolean }`; `type Block = { type: "heading"; level: 1 | 2; content: Inline[] } | { type: "paragraph"; content: Inline[] } | { type: "list"; ordered: boolean; items: Inline[][] } | { type: "table"; header: Inline[][]; rows: Inline[][][] }`; `parseInline(text): Inline[]`; `parseMarkdown(md): Block[]`.
- Produces (`variables.ts`): `type VariableContext = { schoolName: string; student: { firstName: string; fullName: string | null; birthDate: string | null; className: string }; guardian: { firstName: string; fullName: string | null; cpf: string | null } | null; issuedOn: string; fields: DocumentField[]; fieldValues: Record<string, string> }`; `placeholdersIn(text): string[]`; `templateProblems(bodyMd, fields): string[]`; `usesGuardian(bodyMd): boolean`; `variableValue(name, ctx): string | null`; `missingVariables(bodyMd, ctx): string[]`; `fillText(text, ctx): string`; `fillBlocks(blocks, ctx): Block[]`; `formatDateBR(iso): string`; `formatLongDateBR(iso): string`.

- [ ] **Step 1: Testes do parser (falham)**

`apps/api/src/modules/documents/markdown.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "./markdown";

const t = (text: string, bold = false) => ({ text, bold });

describe("parseInline", () => {
  it("toggles bold on paired markers and keeps an unpaired one as text", () => {
    expect(parseInline("a **b** c")).toEqual([t("a "), t("b", true), t(" c")]);
    expect(parseInline("a **b** c **d")).toEqual([t("a "), t("b", true), t(" c **d")]);
    expect(parseInline("")).toEqual([]);
  });
});

describe("parseMarkdown", () => {
  it("parses headings and joins paragraph lines", () => {
    expect(parseMarkdown("# Título\r\n\r\nOlá **mundo**\ncontinua.\n\n## Seção\n### não é título")).toEqual([
      { type: "heading", level: 1, content: [t("Título")] },
      { type: "paragraph", content: [t("Olá "), t("mundo", true), t(" continua.")] },
      { type: "heading", level: 2, content: [t("Seção")] },
      { type: "paragraph", content: [t("### não é título")] },
    ]);
  });

  it("parses bullet and numbered lists", () => {
    expect(parseMarkdown("- a\n- **b**\n\n1. um\n2. dois")).toEqual([
      { type: "list", ordered: false, items: [[t("a")], [t("b", true)]] },
      { type: "list", ordered: true, items: [[t("um")], [t("dois")]] },
    ]);
  });

  it("parses a simple table and pads short rows", () => {
    expect(parseMarkdown("| Item | Detalhe |\n| --- | :---: |\n| Data | {{campo.data}} |\n| Só |")).toEqual([
      {
        type: "table",
        header: [[t("Item")], [t("Detalhe")]],
        rows: [
          [[t("Data")], [t("{{campo.data}}")]],
          [[t("Só")], []],
        ],
      },
    ]);
  });

  it("treats pipes without a separator line as a paragraph", () => {
    expect(parseMarkdown("| a | b |")).toEqual([{ type: "paragraph", content: [t("| a | b |")] }]);
  });

  it("starts a new block when a list follows a paragraph line", () => {
    expect(parseMarkdown("Leve:\n- água")).toEqual([
      { type: "paragraph", content: [t("Leve:")] },
      { type: "list", ordered: false, items: [[t("água")]] },
    ]);
  });
});
```

Run: `pnpm --filter @app-lanche/api exec vitest run src/modules/documents/markdown.test.ts` → FAIL.

- [ ] **Step 2: Parser**

`apps/api/src/modules/documents/markdown.ts`:

```ts
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
```

Run do Step 1 → PASS.

- [ ] **Step 3: Testes das variáveis (falham)**

`apps/api/src/modules/documents/variables.test.ts`:

```ts
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
```

Run: `pnpm --filter @app-lanche/api exec vitest run src/modules/documents/variables.test.ts` → FAIL.

- [ ] **Step 4: Variáveis**

`apps/api/src/modules/documents/variables.ts`:

```ts
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
```

Run do Step 3 → PASS.

- [ ] **Step 5: Rodar e commitar**

Run: `pnpm --filter @app-lanche/api exec vitest run src/modules/documents && pnpm typecheck && pnpm lint` → PASS.

```bash
git add apps/api/src/modules/documents/markdown.ts apps/api/src/modules/documents/markdown.test.ts apps/api/src/modules/documents/variables.ts apps/api/src/modules/documents/variables.test.ts
git commit -m "feat(documents): parse restricted Markdown and resolve template variables"
```

---

### Task 4: PDF com pdfmake e os quatro exemplos prontos

**Files:**
- Modify: `apps/api/package.json`, `pnpm-lock.yaml` (`pdfmake`, `@types/pdfmake`)
- Create: `apps/api/src/modules/documents/pdf.ts`, `apps/api/src/modules/documents/pdf.test.ts`
- Create: `apps/api/src/modules/documents/examples.ts`, `apps/api/src/modules/documents/examples.test.ts`

**Interfaces:**
- Consumes: `parseMarkdown`, `Block` (Task 3); `fillBlocks`, `VariableContext`, `templateProblems`, `missingVariables` (Task 3).
- Produces: `renderPdf(title: string, blocks: Block[]): Promise<Buffer>`; `renderDocument(title: string, bodyMd: string, ctx: VariableContext): Promise<Buffer>`; `type TemplateExampleDef = { key: string; name: string; category: DocumentCategory; bodyMd: string; fields: DocumentField[] }`; `TEMPLATE_EXAMPLES: TemplateExampleDef[]` (chaves `declaracao-matricula`, `declaracao-frequencia`, `comunicado-geral`, `autorizacao-passeio`); `sampleContext(schoolName: string, today: string, fields: DocumentField[]): VariableContext`.

- [ ] **Step 1: Dependência**

```bash
pnpm --filter @app-lanche/api add pdfmake@^0.3.14
pnpm --filter @app-lanche/api add -D @types/pdfmake@^0.3.3
```

(`tsup` mantém as dependências externas; `pdfkit`, dependência do `pdfmake`, lê os arquivos AFM das fontes padrão do próprio `node_modules`, que o `pnpm deploy` do Dockerfile copia.)

- [ ] **Step 2: Testes (falham)**

`apps/api/src/modules/documents/pdf.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseMarkdown } from "./markdown";
import { renderDocument, renderPdf } from "./pdf";
import { sampleContext } from "./examples";

const isPdf = (b: Buffer) => b.subarray(0, 5).toString("latin1") === "%PDF-";

describe("pdf", () => {
  it("renders every block type with accents to a PDF", async () => {
    const blocks = parseMarkdown("# Declaração\n\nAção **ênfase** çã.\n\n- um\n- dois\n\n1. três\n\n| A | B |\n|---|---|\n| 1 | 2 |");
    const bytes = await renderPdf("Declaração", blocks);
    expect(isPdf(bytes)).toBe(true);
    expect(bytes.length).toBeGreaterThan(500);
  });

  it("fills variables before drawing", async () => {
    const ctx = sampleContext("Escola Sol", "2026-11-18", []);
    expect(isPdf(await renderDocument("Teste", "Olá {{aluno.nome_completo}}", ctx))).toBe(true);
  });
});
```

`apps/api/src/modules/documents/examples.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { TemplateInput } from "@app-lanche/contracts";
import { renderDocument } from "./pdf";
import { TEMPLATE_EXAMPLES, sampleContext } from "./examples";
import { missingVariables, templateProblems } from "./variables";

describe("built-in examples", () => {
  it("ships the four examples of spec 8.2", () => {
    expect(TEMPLATE_EXAMPLES.map((e) => e.key)).toEqual(["declaracao-matricula", "declaracao-frequencia", "comunicado-geral", "autorizacao-passeio"]);
  });

  it.each(TEMPLATE_EXAMPLES)("$key is a valid template that renders with sample data", async (example) => {
    expect(TemplateInput.parse({ name: example.name, category: example.category, bodyMd: example.bodyMd, fields: example.fields })).toBeTruthy();
    expect(templateProblems(example.bodyMd, example.fields)).toEqual([]);
    const ctx = sampleContext("Escola Sol", "2026-11-18", example.fields);
    expect(missingVariables(example.bodyMd, ctx)).toEqual([]);
    const bytes = await renderDocument(example.name, example.bodyMd, ctx);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});
```

Run: `pnpm --filter @app-lanche/api exec vitest run src/modules/documents/pdf.test.ts src/modules/documents/examples.test.ts` → FAIL.

- [ ] **Step 3: Renderizador**

`apps/api/src/modules/documents/pdf.ts`:

```ts
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
```

(Se a tipagem de `@types/pdfmake` recusar alguma forma de `Content`, ajuste só o tipo — o desenho fica igual — e registre no relatório.)

- [ ] **Step 4: Exemplos e dados de exemplo**

`apps/api/src/modules/documents/examples.ts`:

```ts
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
```

Run do Step 2 → PASS.

- [ ] **Step 5: Rodar e commitar**

Run: `pnpm --filter @app-lanche/api exec vitest run src/modules/documents && pnpm typecheck && pnpm lint` → PASS.

```bash
git add apps/api/package.json pnpm-lock.yaml apps/api/src/modules/documents/pdf.ts apps/api/src/modules/documents/pdf.test.ts apps/api/src/modules/documents/examples.ts apps/api/src/modules/documents/examples.test.ts
git commit -m "feat(documents): render PDFs with pdfmake and ship four example templates"
```

---

### Task 5: Armazenamento (GCS e disco local) e configuração

**Files:**
- Modify: `apps/api/package.json`, `pnpm-lock.yaml` (`@google-cloud/storage`)
- Modify: `apps/api/src/platform/config.ts`, `apps/api/src/platform/config.test.ts`
- Create: `apps/api/src/platform/storage.ts`, `apps/api/src/platform/storage.test.ts`
- Modify: `apps/api/test/setupEnv.ts`, `e2e/playwright.config.ts`
- Modify: `docker-compose.yml`, `apps/api/Dockerfile`, `docs/local.md`, `docs/deploy.md`

**Interfaces:**
- Produces (config): `Config.storage: { driver: "gcs"; bucket: string } | { driver: "local"; dir: string }`; envs `STORAGE_DRIVER`, `DOCUMENTS_BUCKET`, `ENABLE_LOCAL_STORAGE`, `LOCAL_STORAGE_DIR`.
- Produces (`platform/storage.ts`): `SIGNED_URL_TTL_SECONDS = 300`; `LOCAL_FILES_ROUTE = "/api/v1/files"`; `interface ObjectStorage { putIfAbsent(path: string, bytes: Buffer, contentType: string): Promise<"created" | "exists">; read(path: string): Promise<Buffer>; signedUrl(path: string): Promise<{ url: string; expiresAt: Date }> }`; `documentPath(schoolId, batchId, documentId): string`; `storage(): ObjectStorage`; `resetStorageForTests(): void`; `signLocalToken(path: string, expiresAtMs: number): string`; `verifyLocalToken(token: string, nowMs?: number): string | null`.

- [ ] **Step 1: Testes de configuração (falham)**

`config.test.ts`: `valid` ganha `STORAGE_DRIVER: "gcs"` e `DOCUMENTS_BUCKET: "app-lanche-docs-test"`; o `toEqual` de "parses a valid environment" ganha `storage: { driver: "gcs", bucket: "app-lanche-docs-test" }`. Acrescente:

```ts
  it("requires a bucket for the gcs driver", () => {
    setEnv({ DOCUMENTS_BUCKET: undefined });
    expect(() => config()).toThrow("invalid environment: DOCUMENTS_BUCKET");
  });

  it("refuses the local storage driver unless explicitly enabled", () => {
    setEnv({ STORAGE_DRIVER: "local", ENABLE_LOCAL_STORAGE: undefined, LOCAL_STORAGE_DIR: "/tmp/docs" });
    expect(() => config()).toThrow("invalid environment: STORAGE_DRIVER");
    resetConfigForTests();
    setEnv({ STORAGE_DRIVER: "local", ENABLE_LOCAL_STORAGE: "true", LOCAL_STORAGE_DIR: undefined });
    expect(() => config()).toThrow("invalid environment: LOCAL_STORAGE_DIR");
    resetConfigForTests();
    setEnv({ STORAGE_DRIVER: "local", ENABLE_LOCAL_STORAGE: "true", LOCAL_STORAGE_DIR: "/tmp/docs" });
    expect(config().storage).toEqual({ driver: "local", dir: "/tmp/docs" });
  });
```

Run: `pnpm --filter @app-lanche/api exec vitest run src/platform/config.test.ts` → FAIL.

- [ ] **Step 2: Configuração**

`config.ts` — no `Env`:

```ts
  STORAGE_DRIVER: z.enum(["gcs", "local"]).default("gcs"),
  DOCUMENTS_BUCKET: z.string().min(3).optional(),
  ENABLE_LOCAL_STORAGE: z.enum(["true", "false"]).default("false"),
  LOCAL_STORAGE_DIR: z.string().min(1).optional(),
```

`Config` ganha `storage: { driver: "gcs"; bucket: string } | { driver: "local"; dir: string };`. Depois das checagens de n8n:

```ts
  // Disco local só em desenvolvimento, como o provedor fake de pagamento.
  if (env.STORAGE_DRIVER === "local" && env.ENABLE_LOCAL_STORAGE !== "true") throw new Error("invalid environment: STORAGE_DRIVER");
  if (env.STORAGE_DRIVER === "local" && !env.LOCAL_STORAGE_DIR) throw new Error("invalid environment: LOCAL_STORAGE_DIR");
  if (env.STORAGE_DRIVER === "gcs" && !env.DOCUMENTS_BUCKET) throw new Error("invalid environment: DOCUMENTS_BUCKET");
  const storage: Config["storage"] =
    env.STORAGE_DRIVER === "local" ? { driver: "local", dir: env.LOCAL_STORAGE_DIR! } : { driver: "gcs", bucket: env.DOCUMENTS_BUCKET! };
```

e `storage` no objeto `cached`.

`apps/api/test/setupEnv.ts` (antes de qualquer `config()`):

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// …
process.env.STORAGE_DRIVER = "local";
process.env.ENABLE_LOCAL_STORAGE = "true";
process.env.LOCAL_STORAGE_DIR = mkdtempSync(join(tmpdir(), "app-lanche-docs-"));
```

`e2e/playwright.config.ts`: no `env` do `webServer` da API, `STORAGE_DRIVER: "local"`, `ENABLE_LOCAL_STORAGE: "true"`, `LOCAL_STORAGE_DIR: join(tmpdir(), "app-lanche-e2e-docs")` (importe `join` e `tmpdir`). Sem isso a API do e2e não sobe.

Run do Step 1 → PASS.

- [ ] **Step 3: Testes do armazenamento (falham)**

`apps/api/src/platform/storage.test.ts`:

```ts
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { documentPath, signLocalToken, storage, verifyLocalToken } from "./storage";

const id = () => crypto.randomUUID();

describe("local storage", () => {
  it("writes once and never overwrites", async () => {
    const path = documentPath(id(), id(), id());
    expect(path).toMatch(/^schools\/[0-9a-f-]+\/documents\/[0-9a-f-]+\/[0-9a-f-]+\.pdf$/);
    expect(await storage().putIfAbsent(path, Buffer.from("first"), "application/pdf")).toBe("created");
    expect(await storage().putIfAbsent(path, Buffer.from("second"), "application/pdf")).toBe("exists");
    expect((await storage().read(path)).toString()).toBe("first");
  });

  it("refuses a path outside the storage root", async () => {
    await expect(storage().putIfAbsent("../escape.pdf", Buffer.from("x"), "application/pdf")).rejects.toThrow(/outside/);
  });

  it("signs a 5-minute URL whose token verifies only intact and unexpired", async () => {
    const path = documentPath(id(), id(), id());
    const { url, expiresAt } = await storage().signedUrl(path);
    expect(url).toMatch(/^\/api\/v1\/files\?t=/);
    const minutes = (expiresAt.getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(4.9);
    expect(minutes).toBeLessThanOrEqual(5);
    const token = new URL(url, "https://x").searchParams.get("t")!;
    expect(verifyLocalToken(token)).toBe(path);
    expect(verifyLocalToken(token, Date.now() + 6 * 60_000)).toBeNull();
    const [payload, sig] = token.split(".");
    const other = Buffer.from(JSON.stringify({ p: "schools/x/documents/y/z.pdf", e: 9_999_999_999 })).toString("base64url");
    expect(verifyLocalToken(`${other}.${sig}`)).toBeNull();
    expect(verifyLocalToken(`${payload}.${createHash("sha256").update("x").digest("base64url")}`)).toBeNull();
    expect(verifyLocalToken("garbage")).toBeNull();
    expect(verifyLocalToken(signLocalToken(path, Date.now() - 1))).toBeNull();
  });
});
```

Run: `pnpm --filter @app-lanche/api exec vitest run src/platform/storage.test.ts` → FAIL.

- [ ] **Step 4: Implementar**

`pnpm --filter @app-lanche/api add @google-cloud/storage@^9.0.0`

`apps/api/src/platform/storage.ts`:

```ts
import { createHmac, hkdfSync, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { Storage } from "@google-cloud/storage";
import { config } from "./config";
import { safeEqual } from "./hmac";

export const SIGNED_URL_TTL_SECONDS = 5 * 60;
export const LOCAL_FILES_ROUTE = "/api/v1/files";

/** PDFs são imutáveis: nunca sobrescreva um objeto. Sem acesso ao banco. */
export interface ObjectStorage {
  putIfAbsent(path: string, bytes: Buffer, contentType: string): Promise<"created" | "exists">;
  read(path: string): Promise<Buffer>;
  signedUrl(path: string): Promise<{ url: string; expiresAt: Date }>;
}

export function documentPath(schoolId: string, batchId: string, documentId: string): string {
  return `schools/${schoolId}/documents/${batchId}/${documentId}.pdf`;
}

function expiry(): Date {
  return new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000);
}

function gcsStorage(bucketName: string): ObjectStorage {
  const bucket = new Storage().bucket(bucketName);
  return {
    async putIfAbsent(path, bytes, contentType) {
      try {
        await bucket.file(path).save(bytes, { contentType, resumable: false, preconditionOpts: { ifGenerationMatch: 0 } });
        return "created";
      } catch (err) {
        if ((err as { code?: unknown }).code === 412) return "exists";
        throw err;
      }
    },
    async read(path) {
      const [bytes] = await bucket.file(path).download();
      return bytes;
    },
    async signedUrl(path) {
      // No Cloud Run a assinatura V4 usa a IAM signBlob da própria conta de serviço (docs/deploy.md).
      const expiresAt = expiry();
      const [url] = await bucket.file(path).getSignedUrl({ version: "v4", action: "read", expires: expiresAt, responseType: "application/pdf" });
      return { url, expiresAt };
    },
  };
}

// Disco local (desenvolvimento): URL servida pela própria API, assinada com uma chave derivada de SESSION_SECRET.
function urlKey(): Buffer {
  return Buffer.from(hkdfSync("sha256", config().sessionSecret, "", "app-lanche/local-storage-url/v1", 32));
}

function mac(payload: string): string {
  return createHmac("sha256", urlKey()).update(payload).digest("base64url");
}

export function signLocalToken(path: string, expiresAtMs: number): string {
  const payload = Buffer.from(JSON.stringify({ p: path, e: Math.floor(expiresAtMs / 1000) })).toString("base64url");
  return `${payload}.${mac(payload)}`;
}

/** Caminho do objeto, ou null se o token foi alterado ou venceu. */
export function verifyLocalToken(token: string, nowMs = Date.now()): string | null {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined || !safeEqual(signature, mac(payload))) return null;
  try {
    const { p, e } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { p?: unknown; e?: unknown };
    if (typeof p !== "string" || typeof e !== "number" || e * 1000 < nowMs) return null;
    return p;
  } catch {
    return null;
  }
}

function diskStorage(root: string): ObjectStorage {
  const base = resolve(root);
  const full = (path: string) => {
    const target = resolve(base, path);
    if (!target.startsWith(base + sep)) throw new Error("path outside storage root");
    return target;
  };
  return {
    async putIfAbsent(path, bytes) {
      const target = full(path);
      await mkdir(dirname(target), { recursive: true });
      const tmp = `${target}.${randomUUID()}.tmp`;
      await writeFile(tmp, bytes);
      try {
        // link() falha com EEXIST se o destino existe: criação atômica sem sobrescrever.
        await link(tmp, target);
        return "created";
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") return "exists";
        throw err;
      } finally {
        await rm(tmp, { force: true });
      }
    },
    read: (path) => readFile(full(path)),
    async signedUrl(path) {
      const expiresAt = expiry();
      return { url: `${LOCAL_FILES_ROUTE}?t=${signLocalToken(path, expiresAt.getTime())}`, expiresAt };
    },
  };
}

let cached: ObjectStorage | undefined;

export function storage(): ObjectStorage {
  if (!cached) {
    const c = config().storage;
    cached = c.driver === "gcs" ? gcsStorage(c.bucket) : diskStorage(c.dir);
  }
  return cached;
}

/** Apenas para testes. */
export function resetStorageForTests(): void {
  cached = undefined;
}
```

(O driver GCS não tem teste automatizado: depende da rede e de credenciais; é coberto pelo item de homologação em `docs/deploy.md`.)

Run do Step 3 → PASS.

- [ ] **Step 5: Docker e documentação**

`docker-compose.yml`, serviço `api`: acrescente ao `environment`

```yaml
      STORAGE_DRIVER: local
      ENABLE_LOCAL_STORAGE: "true"
      LOCAL_STORAGE_DIR: /data/documents
```

e

```yaml
    volumes:
      - documents:/data/documents
```

e, em `volumes:` no fim do arquivo, `documents:`.

`apps/api/Dockerfile`, no estágio final, antes de `USER node`:

```dockerfile
# Diretório do armazenamento local (só com STORAGE_DRIVER=local); o volume herda o dono.
RUN mkdir -p /data/documents && chown node:node /data/documents
```

`docs/local.md`, nova seção "Documentos (PDF)": os PDFs ficam no volume `documents` (`STORAGE_DRIVER=local`, só aceito com `ENABLE_LOCAL_STORAGE=true`); o link de download é servido pela própria API em `/api/v1/files?t=…`, assinado e válido por 5 min; `pnpm app:down` mantém o volume; `docker compose --profile app down -v` apaga PDFs e banco.

`docs/deploy.md`, nova seção "Documentos (Cloud Storage)":

```bash
DOCUMENTS_BUCKET=<projeto>-app-lanche-documentos
RUN_SA=<conta de serviço do Cloud Run>
gcloud storage buckets create "gs://$DOCUMENTS_BUCKET" --project "$GCP_PROJECT" \
  --location southamerica-east1 --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets add-iam-policy-binding "gs://$DOCUMENTS_BUCKET" \
  --member "serviceAccount:$RUN_SA" --role roles/storage.objectCreator
gcloud storage buckets add-iam-policy-binding "gs://$DOCUMENTS_BUCKET" \
  --member "serviceAccount:$RUN_SA" --role roles/storage.objectViewer
# URL assinada V4 sem chave privada: a biblioteca usa a IAM signBlob da própria conta.
gcloud services enable iamcredentials.googleapis.com --project "$GCP_PROJECT"
gcloud iam service-accounts add-iam-policy-binding "$RUN_SA" \
  --member "serviceAccount:$RUN_SA" --role roles/iam.serviceAccountTokenCreator
```

Texto: o bucket é privado; o objeto nunca é sobrescrito (`ifGenerationMatch=0`), por isso a conta não precisa de `objectAdmin`; o `gcloud run deploy` passa a incluir `STORAGE_DRIVER=gcs,DOCUMENTS_BUCKET=$DOCUMENTS_BUCKET` em `--set-env-vars` (atualize o comando da seção "API"); `STORAGE_DRIVER=local` é recusado sem `ENABLE_LOCAL_STORAGE=true` e não deve ser usado em produção. Em "Permissões da conta de serviço", acrescente os três papéis acima. Item de homologação: gerar um lote real e abrir o PDF pela URL assinada.

- [ ] **Step 6: Rodar e commitar**

Run: `pnpm --filter @app-lanche/api exec vitest run src/platform && pnpm typecheck && pnpm lint` → PASS.

```bash
git add apps/api/package.json pnpm-lock.yaml apps/api/src/platform/config.ts apps/api/src/platform/config.test.ts apps/api/src/platform/storage.ts apps/api/src/platform/storage.test.ts apps/api/test/setupEnv.ts e2e/playwright.config.ts docker-compose.yml apps/api/Dockerfile docs/local.md docs/deploy.md
git commit -m "feat(platform): store documents in Cloud Storage or a signed local directory"
```

---
### Task 6: Modelos — rotas de equipe, versões, arquivamento, exemplos e prévia

**Files:**
- Create: `apps/api/src/modules/documents/repo.ts`, `apps/api/src/modules/documents/service.ts`, `apps/api/src/modules/documents/routes.ts`
- Create: `apps/api/src/modules/documents/templates.test.ts`
- Modify: `apps/api/src/app.ts` (registrar `documentRoutes`)

**Interfaces:**
- Consumes: contratos da Task 1; `templateProblems` (Task 3); `renderDocument`, `TEMPLATE_EXAMPLES`, `sampleContext` (Task 4); `idempotent`, `requestHash`, `idempotencyKeyFrom`, `audit`, `DomainError`, `isUniqueViolation`.
- Produces (repo): `type TemplateRow = { id; templateGroupId; version: number; name; category: string; bodyMd; fields: DocumentField[]; archivedAt: Date | null; createdAt: Date; latest: boolean }`; `insertTemplate(trx, row)`, `listLatestTemplates(trx): Promise<TemplateRow[]>`, `findTemplate(trx, id): Promise<TemplateRow | undefined>`, `archiveGroup(trx, groupId): Promise<number>`, `schoolInfo(trx): Promise<{ name: string; today: string }>`.
- Produces (service): `listTemplates(session)`, `getTemplate(session, id)`, `listExamples()`, `createTemplate(session, key, input)`, `copyExample(session, key, exampleKey)`, `createVersion(session, key, baseId, input)`, `archiveTemplate(session, id)`, `previewTemplate(session, input): Promise<Buffer>`.
- Produces (rotas, todas `OFFICE`): `GET /api/admin/v1/document-templates`, `GET …/document-templates/examples`, `GET …/document-templates/:id`, `POST …/document-templates` (chave), `POST …/document-templates/from-example` (chave), `POST …/document-templates/:id/versions` (chave), `POST …/document-templates/:id/archive` (204), `POST …/document-templates/preview` (`application/pdf`).
- Produces (routes.ts): `export const OFFICE: RouteAuth`, `export async function documentRoutes(app)`.

- [ ] **Step 1: Testes (falham)**

`apps/api/src/modules/documents/templates.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { adminDb, createSchool, staffCookie } from "../../../test/helpers";
import { buildApp } from "../../app";

const BASE = "/api/admin/v1/document-templates";
const TEMPLATE = {
  name: "Autorização de passeio",
  category: "autorizacao",
  bodyMd: "# Autorização\n\nAutorizo **{{aluno.nome_completo}}** a ir a {{campo.destino}}.",
  fields: [{ key: "destino", label: "Destino", type: "texto" }],
};

async function setup(role: "admin" | "secretaria" = "secretaria") {
  const schoolId = await createSchool();
  const { cookies, staffUserId } = await staffCookie(schoolId, role);
  const app = buildApp();
  const post = (url: string, payload?: unknown, key: string | null = crypto.randomUUID()) =>
    app.inject({ method: "POST", url, cookies, payload: payload as object, headers: key ? { "idempotency-key": key } : {} });
  const get = (url: string) => app.inject({ method: "GET", url, cookies });
  return { schoolId, staffUserId, cookies, app, post, get };
}

describe("document templates", () => {
  it("creates, lists, versions and keeps the old version readable", async () => {
    const s = await setup();
    const created = await s.post(BASE, TEMPLATE);
    expect(created.statusCode).toBe(200);
    const v1 = created.json();
    expect(v1).toMatchObject({ groupId: v1.id, version: 1, name: "Autorização de passeio", latest: true, archived: false, fields: TEMPLATE.fields });

    const v2res = await s.post(`${BASE}/${v1.id}/versions`, { ...TEMPLATE, name: "Autorização de passeio (zoo)" });
    expect(v2res.statusCode).toBe(200);
    const v2 = v2res.json();
    expect(v2).toMatchObject({ groupId: v1.id, version: 2, latest: true });
    expect(v2.id).not.toBe(v1.id);

    const list = await s.get(BASE);
    expect(list.json().templates).toEqual([expect.objectContaining({ id: v2.id, version: 2, name: "Autorização de passeio (zoo)" })]);
    expect((await s.get(`${BASE}/${v1.id}`)).json()).toMatchObject({ version: 1, latest: false });

    const audit = await adminDb().selectFrom("auditLog").select("action").where("schoolId", "=", s.schoolId).where("action", "like", "document_template.%").orderBy("createdAt").execute();
    expect(audit.map((a) => a.action)).toEqual(["document_template.created", "document_template.versioned"]);
  });

  it("refuses a new version from a stale base", async () => {
    const s = await setup();
    const v1 = (await s.post(BASE, TEMPLATE)).json();
    await s.post(`${BASE}/${v1.id}/versions`, TEMPLATE);
    const stale = await s.post(`${BASE}/${v1.id}/versions`, TEMPLATE);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("document_template_outdated");
  });

  it("rejects unknown variables and undeclared fields with their names", async () => {
    const s = await setup();
    const res = await s.post(BASE, { ...TEMPLATE, bodyMd: "{{aluno.apelido}} {{campo.hora}} {{campo.destino}}" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({ code: "document_template_invalid", details: { variables: ["{{aluno.apelido}}", "{{campo.hora}}"] } });
    expect(await adminDb().selectFrom("documentTemplates").select("id").where("schoolId", "=", s.schoolId).execute()).toEqual([]);
  });

  it("archives a whole group: hidden from the list and closed to new versions", async () => {
    const s = await setup();
    const v1 = (await s.post(BASE, TEMPLATE)).json();
    const archived = await s.post(`${BASE}/${v1.id}/archive`, undefined, null);
    expect(archived.statusCode).toBe(204);
    expect((await s.get(BASE)).json().templates).toEqual([]);
    expect((await s.post(`${BASE}/${v1.id}/versions`, TEMPLATE)).statusCode).toBe(404);
    expect((await s.post(`${BASE}/${v1.id}/archive`, undefined, null)).statusCode).toBe(204);
  });

  it("copies a built-in example into a new template", async () => {
    const s = await setup();
    const examples = (await s.get(`${BASE}/examples`)).json().examples;
    expect(examples.map((e: { key: string }) => e.key)).toContain("autorizacao-passeio");
    const copy = await s.post(`${BASE}/from-example`, { exampleKey: "autorizacao-passeio" });
    expect(copy.statusCode).toBe(200);
    expect(copy.json()).toMatchObject({ name: "Autorização de passeio", category: "autorizacao", version: 1 });
    expect(copy.json().bodyMd).toContain("{{responsavel.cpf}}");
    expect((await s.post(`${BASE}/from-example`, { exampleKey: "nao-existe" })).statusCode).toBe(404);
  });

  it("replays a create with the same idempotency key", async () => {
    const s = await setup();
    const key = crypto.randomUUID();
    const a = await s.post(BASE, TEMPLATE, key);
    const b = await s.post(BASE, TEMPLATE, key);
    expect(b.json().id).toBe(a.json().id);
    expect((await s.post(BASE, TEMPLATE, null)).json().error.code).toBe("idempotency_key_required");
  });

  it("previews a PDF with sample data and writes nothing", async () => {
    const s = await setup();
    const res = await s.post(`${BASE}/preview`, TEMPLATE, null);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.rawPayload.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(await adminDb().selectFrom("documentTemplates").select("id").where("schoolId", "=", s.schoolId).execute()).toEqual([]);
    expect((await s.post(`${BASE}/preview`, { ...TEMPLATE, bodyMd: "{{x.y}}" }, null)).statusCode).toBe(422);
  });

  it("keeps templates per school and away from the kitchen role", async () => {
    const a = await setup();
    const b = await setup();
    const v1 = (await a.post(BASE, TEMPLATE)).json();
    expect((await b.get(`${BASE}/${v1.id}`)).statusCode).toBe(404);
    expect((await b.get(BASE)).json().templates).toEqual([]);
    const { cookies } = await staffCookie(a.schoolId, "cozinha");
    expect((await a.app.inject({ method: "GET", url: BASE, cookies })).statusCode).toBe(403);
  });
});
```

Run: `pnpm --filter @app-lanche/api exec vitest run src/modules/documents/templates.test.ts` → FAIL.

- [ ] **Step 2: Repo**

`apps/api/src/modules/documents/repo.ts`:

```ts
import type { DocumentField } from "@app-lanche/contracts";
import { sql } from "kysely";
import type { Trx } from "../../db/index";

// fields e field_values são lidos como texto: o CamelCasePlugin mudaria as chaves (data_passeio → dataPasseio).

export type TemplateRow = {
  id: string;
  templateGroupId: string;
  version: number;
  name: string;
  category: string;
  bodyMd: string;
  fields: DocumentField[];
  archivedAt: Date | null;
  createdAt: Date;
  latest: boolean;
};
type RawTemplate = Omit<TemplateRow, "fields"> & { fieldsText: string };

const TEMPLATE_COLUMNS = sql`t.id, t.template_group_id, t.version, t.name, t.category, t.body_md, t.fields::text AS fields_text, t.archived_at, t.created_at`;

function toTemplate({ fieldsText, ...rest }: RawTemplate): TemplateRow {
  return { ...rest, fields: JSON.parse(fieldsText) as DocumentField[] };
}

export async function insertTemplate(
  trx: Trx,
  row: { id: string; schoolId: string; templateGroupId: string; version: number; name: string; category: string; bodyMd: string; fields: DocumentField[]; createdBy: string },
): Promise<void> {
  await trx.insertInto("documentTemplates").values({ ...row, fields: JSON.stringify(row.fields) }).execute();
}

/** Última versão de cada grupo não arquivado, por nome. */
export async function listLatestTemplates(trx: Trx): Promise<TemplateRow[]> {
  const { rows } = await sql<RawTemplate>`
    SELECT DISTINCT ON (t.template_group_id) ${TEMPLATE_COLUMNS}, true AS latest
    FROM document_templates t
    WHERE t.archived_at IS NULL
    ORDER BY t.template_group_id, t.version DESC`.execute(trx);
  return rows.map(toTemplate).sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

export async function findTemplate(trx: Trx, id: string): Promise<TemplateRow | undefined> {
  const { rows } = await sql<RawTemplate>`
    SELECT ${TEMPLATE_COLUMNS},
      t.version = (SELECT max(o.version) FROM document_templates o WHERE o.template_group_id = t.template_group_id) AS latest
    FROM document_templates t
    WHERE t.id = ${id}`.execute(trx);
  return rows[0] && toTemplate(rows[0]);
}

export async function archiveGroup(trx: Trx, groupId: string): Promise<number> {
  const res = await trx
    .updateTable("documentTemplates")
    .set({ archivedAt: sql`now()` })
    .where("templateGroupId", "=", groupId)
    .where("archivedAt", "is", null)
    .executeTakeFirst();
  return Number(res.numUpdatedRows);
}

/** Nome da escola e a data de hoje no fuso dela, pelo relógio do banco. */
export async function schoolInfo(trx: Trx): Promise<{ name: string; today: string }> {
  const { rows } = await sql<{ name: string; today: string }>`
    SELECT s.name, (now() AT TIME ZONE s.timezone)::date::text AS today FROM schools s`.execute(trx);
  return rows[0]!;
}
```

- [ ] **Step 3: Service**

`apps/api/src/modules/documents/service.ts`:

```ts
import type { DocumentCategory, Template, TemplateExampleListResponse, TemplateInput, TemplateListResponse } from "@app-lanche/contracts";
import { uuidv7 } from "uuidv7";
import { withTenant, type Trx } from "../../db/index";
import { audit } from "../../platform/audit";
import { DomainError, isUniqueViolation } from "../../platform/errors";
import { idempotent, requestHash } from "../../platform/idempotency";
import type { SessionClaims } from "../../platform/session";
import { TEMPLATE_EXAMPLES, sampleContext } from "./examples";
import { renderDocument } from "./pdf";
import * as repo from "./repo";
import { templateProblems } from "./variables";

function toTemplate(r: repo.TemplateRow): Template {
  return {
    id: r.id,
    groupId: r.templateGroupId,
    version: r.version,
    name: r.name,
    category: r.category as DocumentCategory,
    updatedAt: r.createdAt.toISOString(),
    bodyMd: r.bodyMd,
    fields: r.fields,
    archived: r.archivedAt !== null,
    latest: r.latest,
  };
}

function assertValidTemplate(input: TemplateInput): void {
  const variables = templateProblems(input.bodyMd, input.fields);
  if (variables.length > 0) throw new DomainError("document_template_invalid", "template has invalid variables", { variables });
}

async function insertVersion(trx: Trx, session: SessionClaims, input: TemplateInput, group: { id: string; version: number }): Promise<Template> {
  const id = uuidv7();
  try {
    await repo.insertTemplate(trx, { id, schoolId: session.schoolId, templateGroupId: group.id, version: group.version, ...input, createdBy: session.sub });
  } catch (err) {
    // Outra edição gravou esta versão antes: a transação já falhou, então só sinaliza.
    if (isUniqueViolation(err, "document_templates_version")) throw new DomainError("document_template_outdated");
    throw err;
  }
  await audit(trx, {
    schoolId: session.schoolId,
    actorKind: "staff",
    actorId: session.sub,
    action: group.version === 1 ? "document_template.created" : "document_template.versioned",
    detail: { template_id: id, group_id: group.id, version: group.version },
  });
  return toTemplate((await repo.findTemplate(trx, id))!);
}

export async function listTemplates(session: SessionClaims): Promise<TemplateListResponse> {
  const rows = await withTenant(session.schoolId, (trx) => repo.listLatestTemplates(trx));
  return {
    templates: rows.map((r) => ({
      id: r.id,
      groupId: r.templateGroupId,
      version: r.version,
      name: r.name,
      category: r.category as DocumentCategory,
      updatedAt: r.createdAt.toISOString(),
    })),
  };
}

export async function getTemplate(session: SessionClaims, id: string): Promise<Template> {
  const row = await withTenant(session.schoolId, (trx) => repo.findTemplate(trx, id));
  if (!row) throw new DomainError("not_found");
  return toTemplate(row);
}

export function listExamples(): TemplateExampleListResponse {
  return { examples: TEMPLATE_EXAMPLES.map(({ key, name, category }) => ({ key, name, category })) };
}

export async function createTemplate(session: SessionClaims, key: string, input: TemplateInput): Promise<Template> {
  assertValidTemplate(input);
  const hash = requestHash({ route: "POST /api/admin/v1/document-templates", actorId: session.sub, body: input });
  return withTenant(session.schoolId, async (trx) => {
    const { response } = await idempotent(trx, { schoolId: session.schoolId, key, requestHash: hash }, async () => {
      const groupId = uuidv7();
      return insertVersion(trx, session, input, { id: groupId, version: 1 });
    });
    return response;
  });
}

export async function copyExample(session: SessionClaims, key: string, exampleKey: string): Promise<Template> {
  const example = TEMPLATE_EXAMPLES.find((e) => e.key === exampleKey);
  if (!example) throw new DomainError("not_found");
  const { name, category, bodyMd, fields } = example;
  return createTemplate(session, key, { name, category, bodyMd, fields });
}

/** Nova versão a partir da versão `baseId`, que precisa ser a mais recente do grupo. */
export async function createVersion(session: SessionClaims, key: string, baseId: string, input: TemplateInput): Promise<Template> {
  assertValidTemplate(input);
  const hash = requestHash({ route: `POST /api/admin/v1/document-templates/${baseId}/versions`, actorId: session.sub, body: input });
  return withTenant(session.schoolId, async (trx) => {
    const { response } = await idempotent(trx, { schoolId: session.schoolId, key, requestHash: hash }, async () => {
      const base = await repo.findTemplate(trx, baseId);
      if (!base || base.archivedAt !== null) throw new DomainError("not_found");
      if (!base.latest) throw new DomainError("document_template_outdated");
      return insertVersion(trx, session, input, { id: base.templateGroupId, version: base.version + 1 });
    });
    return response;
  });
}

export async function archiveTemplate(session: SessionClaims, id: string): Promise<void> {
  await withTenant(session.schoolId, async (trx) => {
    const t = await repo.findTemplate(trx, id);
    if (!t) throw new DomainError("not_found");
    if ((await repo.archiveGroup(trx, t.templateGroupId)) > 0) {
      await audit(trx, { schoolId: session.schoolId, actorKind: "staff", actorId: session.sub, action: "document_template.archived", detail: { group_id: t.templateGroupId } });
    }
  });
}

/** PDF com dados fictícios; não grava nada. */
export async function previewTemplate(session: SessionClaims, input: TemplateInput): Promise<Buffer> {
  assertValidTemplate(input);
  const school = await withTenant(session.schoolId, (trx) => repo.schoolInfo(trx));
  return renderDocument(input.name, input.bodyMd, sampleContext(school.name, school.today, input.fields));
}
```

- [ ] **Step 4: Rotas**

`apps/api/src/modules/documents/routes.ts`:

```ts
import { CopyExampleRequest, TemplateInput, Uuid } from "@app-lanche/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RouteAuth } from "../../app";
import { idempotencyKeyFrom } from "../../platform/idempotency";
import * as service from "./service";

export const OFFICE: RouteAuth = { kind: "staff", roles: ["admin", "secretaria"] };
const IdParams = z.object({ id: Uuid });

export async function documentRoutes(app: FastifyInstance): Promise<void> {
  const T = "/api/admin/v1/document-templates";

  app.get(T, { config: { auth: OFFICE } }, async (req) => service.listTemplates(req.session!));
  app.get(`${T}/examples`, { config: { auth: OFFICE } }, async () => service.listExamples());
  app.get(`${T}/:id`, { config: { auth: OFFICE } }, async (req) => service.getTemplate(req.session!, IdParams.parse(req.params).id));

  app.post(T, { config: { auth: OFFICE } }, async (req) =>
    service.createTemplate(req.session!, idempotencyKeyFrom(req), TemplateInput.parse(req.body)),
  );
  app.post(`${T}/from-example`, { config: { auth: OFFICE } }, async (req) =>
    service.copyExample(req.session!, idempotencyKeyFrom(req), CopyExampleRequest.parse(req.body).exampleKey),
  );
  app.post(`${T}/:id/versions`, { config: { auth: OFFICE } }, async (req) =>
    service.createVersion(req.session!, idempotencyKeyFrom(req), IdParams.parse(req.params).id, TemplateInput.parse(req.body)),
  );
  // Arquivar de novo não muda nada: idempotente por natureza.
  app.post(`${T}/:id/archive`, { config: { auth: OFFICE } }, async (req, reply) => {
    await service.archiveTemplate(req.session!, IdParams.parse(req.params).id);
    return reply.status(204).send();
  });
  // Prévia não grava estado.
  app.post(`${T}/preview`, { config: { auth: OFFICE } }, async (req, reply) => {
    const pdf = await service.previewTemplate(req.session!, TemplateInput.parse(req.body));
    return reply.type("application/pdf").send(pdf);
  });
}
```

`app.ts`: `import { documentRoutes } from "./modules/documents/routes";` e `app.register(documentRoutes);` depois de `kdsRoutes`.

Run do Step 1 → PASS.

- [ ] **Step 5: Rodar e commitar**

Run: `pnpm --filter @app-lanche/api exec vitest run src/modules/documents && pnpm typecheck && pnpm lint` → PASS.

```bash
git add apps/api/src/modules/documents apps/api/src/app.ts
git commit -m "feat(documents): versioned templates with archive, built-in examples and PDF preview"
```

---

### Task 7: Lotes — criação com conferência de dados, lista e detalhe

**Files:**
- Modify: `apps/api/src/modules/documents/{repo.ts,service.ts,routes.ts}`
- Create: `apps/api/src/modules/documents/batches.test.ts`, `apps/api/test/documents.ts`

**Interfaces:**
- Produces (testes): `documentsSetup()` em `apps/api/test/documents.ts` → `{ schoolId, staffUserId, cookies, app, post(url, payload?, key?: string | null), get(url), template(bodyMd, fields?), guardianId, leo, bia }`.
- Consumes: `usesGuardian`, `missingVariables`, `placeholdersIn`, `VariableContext` (Task 3); `TemplateRow`, `findTemplate`, `schoolInfo` (Task 6).
- Produces (repo): `studentsForBatch(trx, ids)`, `guardiansOfStudents(trx, ids)`, `insertBatch(trx, row)`, `insertDocuments(trx, rows)`, `type SummaryRow`, `batchSummaries(trx, batchId?: string): Promise<SummaryRow[]>`, `batchDocuments(trx, batchId)`, `type BatchInfo = { id; status: string; templateName; bodyMd; fields: DocumentField[]; fieldValues: Record<string, string>; issuedOn: string; perGuardian: boolean }`, `batchInfo(trx, batchId): Promise<BatchInfo | undefined>`.
- Produces (service): `createBatch(session, key, body): Promise<BatchSummary>`, `listBatches(session): Promise<BatchListResponse>`, `getBatch(session, id): Promise<BatchDetail>`, `toSummary(row: SummaryRow): BatchSummary`, `countsOf(row: SummaryRow): BatchCounts`.
- Produces (rotas, `OFFICE`): `POST /api/admin/v1/document-batches` (chave), `GET /api/admin/v1/document-batches`, `GET /api/admin/v1/document-batches/:id`.

- [ ] **Step 1: Testes (falham)**

`apps/api/test/documents.ts` (ajudante compartilhado pelos testes de documentos; fica fora dos arquivos `*.test.ts` para que importar não registre testes de novo):

```ts
import { buildApp } from "../src/app";
import { adminDb, createSchool, seedFamily, staffCookie } from "./helpers";

/** Escola com secretaria, um responsável (nome completo e CPF) e dois filhos (Léo e Bia) com nome completo e nascimento. */
export async function documentsSetup() {
  const schoolId = await createSchool();
  const { cookies, staffUserId } = await staffCookie(schoolId, "secretaria");
  const fam = await seedFamily(schoolId, ["Léo", "Bia"]);
  const [leo, bia] = fam.studentIds as [string, string];
  await adminDb().updateTable("students").set({ fullName: "Leonardo Souza", birthDate: "2021-03-15" }).where("id", "=", leo).execute();
  await adminDb().updateTable("students").set({ fullName: "Beatriz Souza", birthDate: "2022-07-02" }).where("id", "=", bia).execute();
  await adminDb().updateTable("guardians").set({ fullName: "Ana Paula Souza", cpf: "52998224725" }).where("id", "=", fam.guardianId).execute();
  const app = buildApp();
  const post = (url: string, payload?: unknown, key: string | null = crypto.randomUUID()) =>
    app.inject({ method: "POST", url, cookies, payload: payload as object, headers: key ? { "idempotency-key": key } : {} });
  const get = (url: string) => app.inject({ method: "GET", url, cookies });
  const template = async (bodyMd: string, fields: unknown[] = []) =>
    (await post("/api/admin/v1/document-templates", { name: "Modelo", category: "outro", bodyMd, fields })).json().id as string;
  return { schoolId, staffUserId, cookies, app, post, get, template, guardianId: fam.guardianId, leo, bia };
}
```

`apps/api/src/modules/documents/batches.test.ts`:

```ts
import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { describe, expect, it } from "vitest";
import { documentsSetup } from "../../../test/documents";
import { adminDb, seedFamily } from "../../../test/helpers";

const STUDENT_BODY = "# Declaração\n\n{{aluno.nome_completo}}, nascido(a) em {{aluno.data_nascimento}}, turma {{turma.nome}}. Passeio: {{campo.destino}} em {{campo.data_passeio}}.";
const GUARDIAN_BODY = "# Autorização\n\nEu, {{responsavel.nome_completo}}, CPF {{responsavel.cpf}}, autorizo {{aluno.primeiro_nome}}.";
const FIELDS = [
  { key: "destino", label: "Destino", type: "texto" },
  { key: "data_passeio", label: "Data", type: "data" },
];

describe("document batches", () => {
  it("creates one pending document per student with the field values and the school's date", async () => {
    const s = await documentsSetup();
    const templateId = await s.template(STUDENT_BODY, FIELDS);
    const res = await s.post("/api/admin/v1/document-batches", { templateId, studentIds: [s.leo, s.bia], fieldValues: { destino: "Zoológico", data_passeio: "2026-12-05" } });
    expect(res.statusCode).toBe(200);
    const batch = res.json();
    expect(batch).toMatchObject({ templateId, templateVersion: 1, status: "rendering", publishedAt: null, counts: { total: 2, pending: 2, rendering: 0, rendered: 0, failed: 0, discarded: 0 }, recipients: 1, viewers: 0 });
    const docs = await adminDb().selectFrom("documents").select(["studentId", "guardianId", "status"]).where("batchId", "=", batch.id).execute();
    expect(docs).toHaveLength(2);
    expect(docs.every((d) => d.guardianId === null && d.status === "pending")).toBe(true);
    const row = await adminDb().selectFrom("documentBatches").select([sql<string>`field_values::text`.as("values"), "issuedOn", "perGuardian", "createdBy"]).where("id", "=", batch.id).executeTakeFirstOrThrow();
    expect(JSON.parse(row.values)).toEqual({ destino: "Zoológico", data_passeio: "2026-12-05" });
    expect(row.perGuardian).toBe(false);
    expect(row.createdBy).toBe(s.staffUserId);
    const { rows } = await sql<{ today: string }>`SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date::text AS today`.execute(adminDb());
    expect(row.issuedOn).toBe(rows[0]!.today);
  });

  it("creates one document per student and guardian when the template addresses guardians", async () => {
    const s = await documentsSetup();
    const second = uuidv7();
    await adminDb().insertInto("guardians").values({ id: second, schoolId: s.schoolId, phoneE164: "+5511977770001", firstName: "Rui", fullName: "Rui Souza", cpf: "11144477735" }).execute();
    await adminDb().insertInto("guardianStudents").values({ schoolId: s.schoolId, guardianId: second, studentId: s.leo }).execute();
    const templateId = await s.template(GUARDIAN_BODY);
    const res = await s.post("/api/admin/v1/document-batches", { templateId, studentIds: [s.leo, s.bia], fieldValues: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ counts: { total: 3 }, recipients: 2 });
    const docs = await adminDb().selectFrom("documents").select(["studentId", "guardianId"]).where("batchId", "=", res.json().id).execute();
    expect(docs.map((d) => `${d.studentId}:${d.guardianId}`).sort()).toEqual([`${s.leo}:${s.guardianId}`, `${s.leo}:${second}`, `${s.bia}:${s.guardianId}`].sort());
  });

  it("refuses a batch with missing data and lists who to fix, by id only", async () => {
    const s = await documentsSetup();
    await adminDb().updateTable("students").set({ birthDate: null }).where("id", "=", s.bia).execute();
    const templateId = await s.template(STUDENT_BODY, FIELDS);
    const res = await s.post("/api/admin/v1/document-batches", { templateId, studentIds: [s.leo, s.bia], fieldValues: { destino: "Zoo", data_passeio: "2026-12-05" } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toEqual({
      code: "document_missing_data",
      message: expect.any(String),
      details: { missing: [{ studentId: s.bia, guardianId: null, variables: ["aluno.data_nascimento"] }] },
    });
    expect(await adminDb().selectFrom("documentBatches").select("id").where("schoolId", "=", s.schoolId).execute()).toEqual([]);

    await adminDb().updateTable("guardians").set({ cpf: null }).where("id", "=", s.guardianId).execute();
    const lonely = (await seedFamily(s.schoolId, ["Caio"])).studentIds[0]!;
    await adminDb().deleteFrom("guardianStudents").where("studentId", "=", lonely).execute();
    const g = await s.template(GUARDIAN_BODY);
    const res2 = await s.post("/api/admin/v1/document-batches", { templateId: g, studentIds: [s.leo, lonely], fieldValues: {} });
    expect(res2.json().error.details.missing).toEqual([
      { studentId: s.leo, guardianId: s.guardianId, variables: ["responsavel.cpf"] },
      { studentId: lonely, guardianId: null, variables: ["responsavel.nome_completo", "responsavel.cpf"] },
    ]);
  });

  it("validates the field values against the template", async () => {
    const s = await documentsSetup();
    const templateId = await s.template(STUDENT_BODY, FIELDS);
    const create = (fieldValues: Record<string, string>) => s.post("/api/admin/v1/document-batches", { templateId, studentIds: [s.leo], fieldValues });
    expect((await create({ destino: "Zoo" })).statusCode).toBe(400);
    expect((await create({ destino: "Zoo", data_passeio: "05/12/2026" })).statusCode).toBe(400);
    expect((await create({ destino: "Zoo", data_passeio: "2026-12-05", extra: "x" })).statusCode).toBe(400);
  });

  it("answers 404 for unknown or foreign students and archived templates", async () => {
    const s = await documentsSetup();
    const other = await documentsSetup();
    const templateId = await s.template(STUDENT_BODY, FIELDS);
    const values = { destino: "Zoo", data_passeio: "2026-12-05" };
    expect((await s.post("/api/admin/v1/document-batches", { templateId, studentIds: [other.leo], fieldValues: values })).statusCode).toBe(404);
    await s.post(`/api/admin/v1/document-templates/${templateId}/archive`, undefined, null);
    expect((await s.post("/api/admin/v1/document-batches", { templateId, studentIds: [s.leo], fieldValues: values })).statusCode).toBe(404);
  });

  it("lists batches and shows the detail with documents and an audit entry", async () => {
    const s = await documentsSetup();
    const templateId = await s.template(STUDENT_BODY, FIELDS);
    const key = crypto.randomUUID();
    const body = { templateId, studentIds: [s.leo, s.bia], fieldValues: { destino: "Zoo", data_passeio: "2026-12-05" } };
    const batch = (await s.post("/api/admin/v1/document-batches", body, key)).json();
    expect((await s.post("/api/admin/v1/document-batches", body, key)).json().id).toBe(batch.id);
    expect((await s.get("/api/admin/v1/document-batches")).json().batches.map((b: { id: string }) => b.id)).toEqual([batch.id]);
    const detail = (await s.get(`/api/admin/v1/document-batches/${batch.id}`)).json();
    expect(detail).toMatchObject({ id: batch.id, fieldValues: { destino: "Zoo", data_passeio: "2026-12-05" } });
    expect(detail.documents.map((d: { studentFirstName: string }) => d.studentFirstName).sort()).toEqual(["Bia", "Léo"]);
    expect(detail.documents[0]).toMatchObject({ className: "Infantil 3A", guardianId: null, status: "pending", discarded: false, viewed: false });
    const audit = await adminDb().selectFrom("auditLog").select([sql<string>`detail::text`.as("detail")]).where("schoolId", "=", s.schoolId).where("action", "=", "document_batch.created").execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.detail).not.toContain("Zoo");
  });
});
```

Run: `pnpm --filter @app-lanche/api exec vitest run src/modules/documents/batches.test.ts` → FAIL.

- [ ] **Step 2: Repo**

Acrescente a `repo.ts`:

```ts
export async function studentsForBatch(trx: Trx, ids: string[]) {
  return trx
    .selectFrom("students")
    .innerJoin("classes", "classes.id", "students.classId")
    .select(["students.id", "students.firstName", "students.fullName", "students.birthDate", "classes.name as className"])
    .where("students.id", "in", ids)
    .where("students.active", "=", true)
    .execute();
}

export async function guardiansOfStudents(trx: Trx, studentIds: string[]) {
  return trx
    .selectFrom("guardianStudents")
    .innerJoin("guardians", "guardians.id", "guardianStudents.guardianId")
    .select(["guardianStudents.studentId", "guardians.id", "guardians.firstName", "guardians.fullName", "guardians.cpf"])
    .where("guardianStudents.studentId", "in", studentIds)
    .orderBy("guardians.firstName")
    .orderBy("guardians.id")
    .execute();
}

export async function insertBatch(
  trx: Trx,
  row: { id: string; schoolId: string; templateId: string; fieldValues: Record<string, string>; issuedOn: string; perGuardian: boolean; createdBy: string },
): Promise<void> {
  await trx.insertInto("documentBatches").values({ ...row, fieldValues: JSON.stringify(row.fieldValues) }).execute();
}

export async function insertDocuments(trx: Trx, rows: { id: string; schoolId: string; batchId: string; studentId: string; guardianId: string | null }[]): Promise<void> {
  if (rows.length > 0) await trx.insertInto("documents").values(rows).execute();
}

export type SummaryRow = {
  id: string;
  templateId: string;
  templateName: string;
  templateVersion: number;
  status: string;
  createdAt: Date;
  publishedAt: Date | null;
  total: number;
  pending: number;
  rendering: number;
  rendered: number;
  failed: number;
  discarded: number;
  recipients: number;
  viewers: number;
};

/** Um lote (batchId) ou todos, mais recentes primeiro. Destinatário = responsável do par, ou todo responsável do aluno. */
export async function batchSummaries(trx: Trx, batchId?: string): Promise<SummaryRow[]> {
  const id = batchId ?? null;
  const { rows } = await sql<SummaryRow>`
    SELECT b.id, b.template_id, t.name AS template_name, t.version AS template_version, b.status, b.created_at, b.published_at,
      count(d.id) AS total,
      count(d.id) FILTER (WHERE d.status = 'pending') AS pending,
      count(d.id) FILTER (WHERE d.status = 'rendering') AS rendering,
      count(d.id) FILTER (WHERE d.status = 'rendered') AS rendered,
      count(d.id) FILTER (WHERE d.status = 'failed' AND d.discarded_at IS NULL) AS failed,
      count(d.id) FILTER (WHERE d.discarded_at IS NOT NULL) AS discarded,
      (SELECT count(DISTINCT coalesce(r.guardian_id, gs.guardian_id))
         FROM documents r
         LEFT JOIN guardian_students gs ON r.guardian_id IS NULL AND gs.student_id = r.student_id
         WHERE r.batch_id = b.id AND r.discarded_at IS NULL) AS recipients,
      (SELECT count(DISTINCT v.guardian_id)
         FROM document_views v JOIN documents vd ON vd.id = v.document_id
         WHERE vd.batch_id = b.id) AS viewers
    FROM document_batches b
    JOIN document_templates t ON t.id = b.template_id
    LEFT JOIN documents d ON d.batch_id = b.id
    WHERE (${id}::uuid IS NULL OR b.id = ${id}::uuid)
    GROUP BY b.id, t.name, t.version
    ORDER BY b.created_at DESC, b.id DESC`.execute(trx);
  return rows;
}

export async function batchDocuments(trx: Trx, batchId: string) {
  return trx
    .selectFrom("documents")
    .innerJoin("students", "students.id", "documents.studentId")
    .innerJoin("classes", "classes.id", "students.classId")
    .leftJoin("guardians", "guardians.id", "documents.guardianId")
    .select([
      "documents.id",
      "documents.studentId",
      "students.firstName as studentFirstName",
      "classes.name as className",
      "documents.guardianId",
      "guardians.firstName as guardianFirstName",
      "documents.status",
      "documents.discardedAt",
      sql<boolean>`EXISTS (SELECT 1 FROM document_views v WHERE v.document_id = documents.id)`.as("viewed"),
    ])
    .where("documents.batchId", "=", batchId)
    .orderBy("classes.name")
    .orderBy("students.firstName")
    .orderBy("guardians.firstName")
    .execute();
}

export type BatchInfo = {
  id: string;
  status: string;
  templateName: string;
  bodyMd: string;
  fields: DocumentField[];
  fieldValues: Record<string, string>;
  issuedOn: string;
  perGuardian: boolean;
};

export async function batchInfo(trx: Trx, batchId: string, lock: "share" | "update" | null = null): Promise<BatchInfo | undefined> {
  const forLock = lock === "update" ? sql`FOR UPDATE OF b` : lock === "share" ? sql`FOR SHARE OF b` : sql``;
  const { rows } = await sql<Omit<BatchInfo, "fields" | "fieldValues"> & { fieldsText: string; valuesText: string }>`
    SELECT b.id, b.status, t.name AS template_name, t.body_md, t.fields::text AS fields_text,
      b.field_values::text AS values_text, b.issued_on::text AS issued_on, b.per_guardian
    FROM document_batches b JOIN document_templates t ON t.id = b.template_id
    WHERE b.id = ${batchId} ${forLock}`.execute(trx);
  const r = rows[0];
  if (!r) return undefined;
  const { fieldsText, valuesText, ...rest } = r;
  return { ...rest, fields: JSON.parse(fieldsText) as DocumentField[], fieldValues: JSON.parse(valuesText) as Record<string, string> };
}
```

- [ ] **Step 3: Service**

Acrescente a `service.ts` (importe `IsoDate`, `BatchCounts`, `BatchDetail`, `BatchListResponse`, `BatchStatus`, `BatchSummary`, `CreateBatchRequest`, `DocumentStatus`, `MissingDataDetails` de `@app-lanche/contracts`; `missingVariables`, `placeholdersIn`, `usesGuardian`, `type VariableContext` de `./variables`):

```ts
export function countsOf(r: repo.SummaryRow): BatchCounts {
  return { total: r.total, pending: r.pending, rendering: r.rendering, rendered: r.rendered, failed: r.failed, discarded: r.discarded };
}

export function toSummary(r: repo.SummaryRow): BatchSummary {
  return {
    id: r.id,
    templateId: r.templateId,
    templateName: r.templateName,
    templateVersion: r.templateVersion,
    status: r.status as BatchStatus,
    createdAt: r.createdAt.toISOString(),
    publishedAt: r.publishedAt ? r.publishedAt.toISOString() : null,
    counts: countsOf(r),
    recipients: r.recipients,
    viewers: r.viewers,
  };
}

/** Todos os campos declarados, nenhum a mais; `data` em AAAA-MM-DD válido. */
function assertFieldValues(fields: repo.TemplateRow["fields"], values: Record<string, string>): void {
  const keys = Object.keys(values).sort();
  const declared = fields.map((f) => f.key).sort();
  const sameKeys = keys.length === declared.length && keys.every((k, i) => k === declared[i]);
  const datesOk = fields.every((f) => f.type !== "data" || IsoDate.safeParse(values[f.key]).success);
  if (!sameKeys || !datesOk) throw new DomainError("validation_failed");
}

export async function createBatch(session: SessionClaims, key: string, body: CreateBatchRequest): Promise<BatchSummary> {
  const schoolId = session.schoolId;
  const hash = requestHash({ route: "POST /api/admin/v1/document-batches", actorId: session.sub, body });
  return withTenant(schoolId, async (trx) => {
    const { response } = await idempotent(trx, { schoolId, key, requestHash: hash }, async () => {
      const template = await repo.findTemplate(trx, body.templateId);
      if (!template || template.archivedAt !== null) throw new DomainError("not_found");
      assertFieldValues(template.fields, body.fieldValues);
      const students = await repo.studentsForBatch(trx, body.studentIds);
      if (students.length !== body.studentIds.length) throw new DomainError("not_found");
      const school = await repo.schoolInfo(trx);
      const perGuardian = usesGuardian(template.bodyMd);
      const guardians = perGuardian ? await repo.guardiansOfStudents(trx, body.studentIds) : [];
      const guardianVars = placeholdersIn(template.bodyMd).filter((n) => n.startsWith("responsavel."));

      const targets: { studentId: string; guardianId: string | null }[] = [];
      const missing: MissingDataDetails["missing"] = [];
      // Ordem estável para a tela: a da seleção, e por responsável dentro do aluno.
      for (const studentId of body.studentIds) {
        const s = students.find((x) => x.id === studentId)!;
        const base: Omit<VariableContext, "guardian"> = {
          schoolName: school.name,
          student: { firstName: s.firstName, fullName: s.fullName, birthDate: s.birthDate, className: s.className },
          issuedOn: school.today,
          fields: template.fields,
          fieldValues: body.fieldValues,
        };
        const recipients = perGuardian ? guardians.filter((g) => g.studentId === studentId) : [null];
        if (recipients.length === 0) {
          missing.push({ studentId, guardianId: null, variables: guardianVars });
          continue;
        }
        for (const g of recipients) {
          const ctx: VariableContext = { ...base, guardian: g && { firstName: g.firstName, fullName: g.fullName, cpf: g.cpf } };
          const lacking = missingVariables(template.bodyMd, ctx);
          if (lacking.length > 0) missing.push({ studentId, guardianId: g?.id ?? null, variables: lacking });
          else targets.push({ studentId, guardianId: g?.id ?? null });
        }
      }
      if (missing.length > 0) throw new DomainError("document_missing_data", "students or guardians lack data", { missing });

      const batchId = uuidv7();
      await repo.insertBatch(trx, { id: batchId, schoolId, templateId: template.id, fieldValues: body.fieldValues, issuedOn: school.today, perGuardian, createdBy: session.sub });
      await repo.insertDocuments(trx, targets.map((t) => ({ id: uuidv7(), schoolId, batchId, ...t })));
      await audit(trx, { schoolId, actorKind: "staff", actorId: session.sub, action: "document_batch.created", detail: { batch_id: batchId, template_id: template.id, documents: targets.length } });
      const [summary] = await repo.batchSummaries(trx, batchId);
      return toSummary(summary!);
    });
    return response;
  });
}

export async function listBatches(session: SessionClaims): Promise<BatchListResponse> {
  const rows = await withTenant(session.schoolId, (trx) => repo.batchSummaries(trx));
  return { batches: rows.map(toSummary) };
}

export async function getBatch(session: SessionClaims, batchId: string): Promise<BatchDetail> {
  return withTenant(session.schoolId, async (trx) => {
    const [summary] = await repo.batchSummaries(trx, batchId);
    const info = await repo.batchInfo(trx, batchId);
    if (!summary || !info) throw new DomainError("not_found");
    const docs = await repo.batchDocuments(trx, batchId);
    return {
      ...toSummary(summary),
      issuedOn: info.issuedOn,
      fieldValues: info.fieldValues,
      documents: docs.map((d) => ({
        id: d.id,
        studentId: d.studentId,
        studentFirstName: d.studentFirstName,
        className: d.className,
        guardianId: d.guardianId,
        guardianFirstName: d.guardianFirstName,
        status: d.status as DocumentStatus,
        discarded: d.discardedAt !== null,
        viewed: d.viewed,
      })),
    };
  });
}
```

(A ordem de `missing` do teste segue a ordem de `studentIds`; mantenha-a.)

- [ ] **Step 4: Rotas**

Em `documentRoutes` (importe `CreateBatchRequest`):

```ts
  const B = "/api/admin/v1/document-batches";
  app.post(B, { config: { auth: OFFICE } }, async (req) =>
    service.createBatch(req.session!, idempotencyKeyFrom(req), CreateBatchRequest.parse(req.body)),
  );
  app.get(B, { config: { auth: OFFICE } }, async (req) => service.listBatches(req.session!));
  app.get(`${B}/:id`, { config: { auth: OFFICE } }, async (req) => service.getBatch(req.session!, IdParams.parse(req.params).id));
```

Run do Step 1 → PASS.

- [ ] **Step 5: Rodar e commitar**

Run: `pnpm --filter @app-lanche/api exec vitest run src/modules/documents && pnpm typecheck && pnpm lint` → PASS.

```bash
git add apps/api/src/modules/documents apps/api/test/documents.ts
git commit -m "feat(documents): create batches after checking every variable has a value"
```

---

### Task 8: Renderização na requisição, descarte, download da equipe e arquivo local

**Files:**
- Modify: `apps/api/src/modules/documents/{repo.ts,service.ts,routes.ts}`
- Create: `apps/api/src/modules/documents/render.test.ts`

**Interfaces:**
- Consumes: `storage`, `documentPath`, `verifyLocalToken`, `ObjectStorage` (Task 5); `renderDocument` (Task 4); `batchInfo`, `batchSummaries`, `schoolInfo` (Tasks 6–7); `config`.
- Produces (repo): `failExhausted(trx, batchId)`, `claimDocuments(trx, batchId, limit)`, `renderContexts(trx, ids)`, `markRendered(trx, { id, attempts, storagePath, sha256 }): Promise<boolean>`, `markAttemptFailed(trx, id, attempts)`, `finishIfDone(trx, batchId)`, `findDocument(trx, id)`, `discardFailed(trx, id): Promise<boolean>`.
- Produces (service): `RENDER_CHUNK = 10`; `type RenderDeps = { render?: (title: string, bodyMd: string, ctx: VariableContext) => Promise<Buffer>; storage?: ObjectStorage; log?: { warn: (obj: object, msg: string) => void } }`; `renderBatch(session, batchId, deps?): Promise<RenderProgress>`; `discardDocument(session, documentId): Promise<void>`; `staffDownload(session, documentId, deps?: { storage?: ObjectStorage }): Promise<DocumentDownloadResponse>`; `readSignedFile(token): Promise<Buffer>`; `signedDownload(path, deps): Promise<DocumentDownloadResponse>`.
- Produces (rotas): `POST /api/admin/v1/document-batches/:id/render`, `POST /api/admin/v1/documents/:id/discard` (204), `POST /api/admin/v1/documents/:id/download` (todas `OFFICE`, sem chave); `GET /api/v1/files?t=` (`"public"`).

- [ ] **Step 1: Testes (falham)**

`apps/api/src/modules/documents/render.test.ts`:

```ts
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { describe, expect, it } from "vitest";
import { adminDb, seedFamily } from "../../../test/helpers";
import { documentsSetup } from "../../../test/documents";
import type { SessionClaims } from "../../platform/session";
import { renderDocument } from "./pdf";
import * as service from "./service";

const BODY = "# Declaração\n\n{{aluno.primeiro_nome}} — {{turma.nome}}";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const file = (path: string) => join(process.env.LOCAL_STORAGE_DIR!, path);

async function batchWith(names: string[]) {
  const s = await documentsSetup();
  const extra = names.length > 0 ? (await seedFamily(s.schoolId, names)).studentIds : [];
  const templateId = await s.template(BODY);
  const batch = (await s.post("/api/admin/v1/document-batches", { templateId, studentIds: [s.leo, s.bia, ...extra], fieldValues: {} })).json();
  const session: SessionClaims = { kind: "staff", sub: s.staffUserId, schoolId: s.schoolId, role: "secretaria" };
  const render = () => s.post(`/api/admin/v1/document-batches/${batch.id}/render`, undefined, null);
  const docs = () => adminDb().selectFrom("documents").selectAll().where("batchId", "=", batch.id).orderBy("id").execute();
  return { ...s, batchId: batch.id as string, session, render, docs };
}

describe("rendering", () => {
  it("renders in chunks of 10, stores each PDF once and records its hash", async () => {
    const b = await batchWith(Array.from({ length: 10 }, (_, i) => `Aluno${i}`));
    const first = await b.render();
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ status: "rendering", counts: { total: 12, pending: 2, rendering: 0, rendered: 10, failed: 0, discarded: 0 } });
    expect((await b.render()).json()).toMatchObject({ status: "ready", counts: { rendered: 12, pending: 0 } });
    for (const d of await b.docs()) {
      expect(d).toMatchObject({ status: "rendered", attempts: 1, leaseUntil: null, storagePath: `schools/${b.schoolId}/documents/${b.batchId}/${d.id}.pdf` });
      const bytes = await readFile(file(d.storagePath!));
      expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      expect(d.sha256).toBe(sha(bytes));
    }
    expect((await b.render()).json()).toMatchObject({ status: "ready" });
  });

  it("never renders a document twice when two tabs render at once", async () => {
    const b = await batchWith(Array.from({ length: 14 }, (_, i) => `Aluno${i}`));
    await Promise.all([b.render(), b.render()]);
    await b.render();
    await b.render();
    const docs = await b.docs();
    expect(docs.every((d) => d.status === "rendered" && d.attempts === 1)).toBe(true);
  });

  it("retries a failing document and marks it failed on the third attempt", async () => {
    const b = await batchWith([]);
    const boom = async () => {
      throw new Error("boom");
    };
    const warnings: object[] = [];
    const log = { warn: (obj: object) => warnings.push(obj) };
    await service.renderBatch(b.session, b.batchId, { render: boom, log });
    await service.renderBatch(b.session, b.batchId, { render: boom, log });
    const last = await service.renderBatch(b.session, b.batchId, { render: boom, log });
    expect(last).toEqual({ status: "ready", counts: { total: 2, pending: 0, rendering: 0, rendered: 0, failed: 2, discarded: 0 } });
    expect((await b.docs()).map((d) => [d.status, d.attempts])).toEqual([["failed", 3], ["failed", 3]]);
    expect(warnings).toHaveLength(6);
    expect(JSON.stringify(warnings)).not.toMatch(/Léo|Bia|Souza/);
  });

  it("takes back an expired lease and fails one that has no attempts left", async () => {
    const b = await batchWith([]);
    const [d1, d2] = await b.docs();
    await adminDb().updateTable("documents").set({ status: "rendering", attempts: 1, leaseUntil: sql`now() - interval '1 second'` }).where("id", "=", d1!.id).execute();
    await adminDb().updateTable("documents").set({ status: "rendering", attempts: 3, leaseUntil: sql`now() - interval '1 second'` }).where("id", "=", d2!.id).execute();
    expect((await b.render()).json()).toMatchObject({ status: "ready", counts: { rendered: 1, failed: 1 } });
    const after = await b.docs();
    expect(after.find((d) => d.id === d1!.id)).toMatchObject({ status: "rendered", attempts: 2 });
    expect(after.find((d) => d.id === d2!.id)).toMatchObject({ status: "failed", attempts: 3 });
  });

  it("keeps the stored object when one already exists and records the hash of its bytes", async () => {
    const b = await batchWith([]);
    const [d1] = await b.docs();
    const path = `schools/${b.schoolId}/documents/${b.batchId}/${d1!.id}.pdf`;
    await mkdir(dirname(file(path)), { recursive: true });
    await writeFile(file(path), "%PDF-1.7 earlier attempt");
    await b.render();
    const row = (await b.docs()).find((d) => d.id === d1!.id)!;
    expect(row.sha256).toBe(sha(Buffer.from("%PDF-1.7 earlier attempt")));
    expect((await readFile(file(path))).toString()).toBe("%PDF-1.7 earlier attempt");
  });

  it("discards only failed documents of an unpublished batch", async () => {
    const b = await batchWith([]);
    await service.renderBatch(b.session, b.batchId, { render: (title, body, ctx) => (ctx.student.firstName === "Bia" ? Promise.reject(new Error("x")) : renderDocument(title, body, ctx)) });
    for (let i = 0; i < 2; i += 1) await service.renderBatch(b.session, b.batchId, { render: async () => Promise.reject(new Error("x")) });
    const docs = await b.docs();
    const failed = docs.find((d) => d.status === "failed")!;
    const rendered = docs.find((d) => d.status === "rendered")!;
    const discard = (id: string) => b.post(`/api/admin/v1/documents/${id}/discard`, undefined, null);
    expect((await discard(rendered.id)).statusCode).toBe(400);
    expect((await discard(failed.id)).statusCode).toBe(204);
    expect((await discard(failed.id)).statusCode).toBe(204);
    const detail = (await b.get(`/api/admin/v1/document-batches/${b.batchId}`)).json();
    expect(detail.counts).toMatchObject({ rendered: 1, failed: 0, discarded: 1 });
    await adminDb().updateTable("documentBatches").set({ status: "published", publishedAt: new Date() }).where("id", "=", b.batchId).execute();
    await adminDb().updateTable("documents").set({ discardedAt: null }).where("id", "=", failed.id).execute();
    expect((await discard(failed.id)).json().error.code).toBe("document_batch_published");
  });

  it("lets staff download a rendered PDF by a signed local URL, audited", async () => {
    const b = await batchWith([]);
    await b.render();
    const [d1] = await b.docs();
    const res = await b.post(`/api/admin/v1/documents/${d1!.id}/download`, undefined, null);
    expect(res.statusCode).toBe(200);
    const { url } = res.json();
    expect(url).toMatch(/^\/api\/v1\/files\?t=/);
    const pdf = await b.app.inject({ method: "GET", url });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(sha(pdf.rawPayload)).toBe(d1!.sha256);
    const tampered = await b.app.inject({ method: "GET", url: `${url.slice(0, -3)}abc` });
    expect(tampered.statusCode).toBe(404);
    const audit = await adminDb().selectFrom("auditLog").select(["actorKind", sql<string>`detail::text`.as("detail")]).where("schoolId", "=", b.schoolId).where("action", "=", "document.downloaded").execute();
    expect(audit).toEqual([{ actorKind: "staff", detail: expect.stringContaining(d1!.id) }]);
  });

  it("answers 404 for a pending document, another school's document and an unknown batch", async () => {
    const b = await batchWith([]);
    const other = await batchWith([]);
    const [d1] = await b.docs();
    expect((await b.post(`/api/admin/v1/documents/${d1!.id}/download`, undefined, null)).statusCode).toBe(404);
    expect((await other.post(`/api/admin/v1/documents/${d1!.id}/discard`, undefined, null)).statusCode).toBe(404);
    expect((await b.post(`/api/admin/v1/document-batches/${uuidv7()}/render`, undefined, null)).statusCode).toBe(404);
    expect((await other.post(`/api/admin/v1/document-batches/${b.batchId}/render`, undefined, null)).statusCode).toBe(404);
  });
});
```

Run: `pnpm --filter @app-lanche/api exec vitest run src/modules/documents/render.test.ts` → FAIL.

- [ ] **Step 2: Repo**

Acrescente a `repo.ts`:

```ts
/** Arrendamento vencido sem tentativas sobrando: não volta para a fila. */
export async function failExhausted(trx: Trx, batchId: string): Promise<void> {
  await sql`
    UPDATE documents SET status = 'failed', lease_until = NULL
    WHERE batch_id = ${batchId} AND status = 'rendering' AND lease_until < now() AND attempts >= 3`.execute(trx);
}

/** Reserva até `limit` documentos: pendentes ou com arrendamento vencido; quem estiver travado por outra aba é pulado. */
export async function claimDocuments(trx: Trx, batchId: string, limit: number) {
  const { rows } = await sql<{ id: string; studentId: string; guardianId: string | null; attempts: number }>`
    UPDATE documents d
    SET status = 'rendering', attempts = d.attempts + 1, lease_until = now() + interval '2 minutes'
    WHERE d.id IN (
      SELECT c.id FROM documents c
      WHERE c.batch_id = ${batchId} AND c.attempts < 3
        AND (c.status = 'pending' OR (c.status = 'rendering' AND c.lease_until < now()))
      ORDER BY c.id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED)
    RETURNING d.id, d.student_id, d.guardian_id, d.attempts`.execute(trx);
  return rows;
}

export async function renderContexts(trx: Trx, documentIds: string[]) {
  return trx
    .selectFrom("documents")
    .innerJoin("students", "students.id", "documents.studentId")
    .innerJoin("classes", "classes.id", "students.classId")
    .leftJoin("guardians", "guardians.id", "documents.guardianId")
    .select([
      "documents.id",
      "students.firstName as studentFirstName",
      "students.fullName as studentFullName",
      "students.birthDate",
      "classes.name as className",
      "guardians.firstName as guardianFirstName",
      "guardians.fullName as guardianFullName",
      "guardians.cpf",
    ])
    .where("documents.id", "in", documentIds)
    .execute();
}

export async function markRendered(trx: Trx, row: { id: string; attempts: number; storagePath: string; sha256: string }): Promise<boolean> {
  const res = await trx
    .updateTable("documents")
    .set({ status: "rendered", storagePath: row.storagePath, sha256: row.sha256, renderedAt: sql`now()`, leaseUntil: null })
    .where("id", "=", row.id)
    .where("status", "=", "rendering")
    .where("attempts", "=", row.attempts)
    .executeTakeFirst();
  return res.numUpdatedRows > 0n;
}

export async function markAttemptFailed(trx: Trx, id: string, attempts: number): Promise<void> {
  await sql`
    UPDATE documents SET status = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'pending' END, lease_until = NULL
    WHERE id = ${id} AND status = 'rendering' AND attempts = ${attempts}`.execute(trx);
}

export async function finishIfDone(trx: Trx, batchId: string): Promise<void> {
  await sql`
    UPDATE document_batches b SET status = 'ready'
    WHERE b.id = ${batchId} AND b.status = 'rendering'
      AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.batch_id = b.id AND d.status IN ('pending', 'rendering'))`.execute(trx);
}

export async function findDocument(trx: Trx, id: string) {
  return trx
    .selectFrom("documents")
    .select(["id", "batchId", "status", "discardedAt", "storagePath"])
    .where("id", "=", id)
    .executeTakeFirst();
}

export async function discardFailed(trx: Trx, id: string): Promise<boolean> {
  const res = await trx
    .updateTable("documents")
    .set({ discardedAt: sql`now()` })
    .where("id", "=", id)
    .where("status", "=", "failed")
    .where("discardedAt", "is", null)
    .executeTakeFirst();
  return res.numUpdatedRows > 0n;
}
```

- [ ] **Step 3: Service**

Acrescente a `service.ts` (importe `createHash` de `node:crypto`; `DocumentDownloadResponse`, `RenderProgress` de contracts; `config` de `../../platform/config`; `documentPath`, `storage`, `verifyLocalToken`, `type ObjectStorage` de `../../platform/storage`):

```ts
export const RENDER_CHUNK = 10;

export type RenderDeps = {
  render?: (title: string, bodyMd: string, ctx: VariableContext) => Promise<Buffer>;
  storage?: ObjectStorage;
  log?: { warn: (obj: object, msg: string) => void };
};

type Outcome = { id: string; attempts: number } & ({ ok: true; path: string; sha256: string } | { ok: false });

/**
 * Uma rodada de renderização (spec 8.3): reserva até 10 documentos, desenha e grava fora da transação e registra.
 * Fechar a aba pausa; a próxima chamada continua. Naturalmente idempotente.
 */
export async function renderBatch(session: SessionClaims, batchId: string, deps: RenderDeps = {}): Promise<RenderProgress> {
  const render = deps.render ?? renderDocument;
  const store = deps.storage ?? storage();
  const schoolId = session.schoolId;

  const work = await withTenant(schoolId, async (trx) => {
    const batch = await repo.batchInfo(trx, batchId);
    if (!batch) throw new DomainError("not_found");
    await repo.failExhausted(trx, batchId);
    const claims = await repo.claimDocuments(trx, batchId, RENDER_CHUNK);
    const contexts = claims.length > 0 ? await repo.renderContexts(trx, claims.map((c) => c.id)) : [];
    const school = await repo.schoolInfo(trx);
    return { batch, claims, contexts, schoolName: school.name };
  });

  const outcomes: Outcome[] = [];
  for (const claim of work.claims) {
    const row = work.contexts.find((c) => c.id === claim.id)!;
    const ctx: VariableContext = {
      schoolName: work.schoolName,
      student: { firstName: row.studentFirstName, fullName: row.studentFullName, birthDate: row.birthDate, className: row.className },
      guardian: row.guardianFirstName === null ? null : { firstName: row.guardianFirstName, fullName: row.guardianFullName, cpf: row.cpf },
      issuedOn: work.batch.issuedOn,
      fields: work.batch.fields,
      fieldValues: work.batch.fieldValues,
    };
    try {
      if (missingVariables(work.batch.bodyMd, ctx).length > 0) throw new Error("data removed after the batch was created");
      const path = documentPath(schoolId, batchId, claim.id);
      let bytes = await render(work.batch.templateName, work.batch.bodyMd, ctx);
      // Tentativa anterior pode ter gravado o objeto e caído antes de registrar: o arquivo gravado vale.
      if ((await store.putIfAbsent(path, bytes, "application/pdf")) === "exists") bytes = await store.read(path);
      outcomes.push({ id: claim.id, attempts: claim.attempts, ok: true, path, sha256: createHash("sha256").update(bytes).digest("hex") });
    } catch (err) {
      // Só ids: a mensagem de erro pode carregar texto do documento.
      deps.log?.warn(
        { batch_id: batchId, document_id: claim.id, attempt: claim.attempts, err_name: err instanceof Error ? err.name : "unknown" },
        "document render failed",
      );
      outcomes.push({ id: claim.id, attempts: claim.attempts, ok: false });
    }
  }

  return withTenant(schoolId, async (trx) => {
    for (const o of outcomes) {
      if (o.ok) await repo.markRendered(trx, { id: o.id, attempts: o.attempts, storagePath: o.path, sha256: o.sha256 });
      else await repo.markAttemptFailed(trx, o.id, o.attempts);
    }
    await repo.finishIfDone(trx, batchId);
    const [summary] = await repo.batchSummaries(trx, batchId);
    return { status: summary!.status as BatchStatus, counts: countsOf(summary!) };
  });
}

export async function discardDocument(session: SessionClaims, documentId: string): Promise<void> {
  await withTenant(session.schoolId, async (trx) => {
    const doc = await repo.findDocument(trx, documentId);
    if (!doc) throw new DomainError("not_found");
    const batch = await repo.batchInfo(trx, doc.batchId, "update");
    if (batch!.status === "published") throw new DomainError("document_batch_published");
    if (doc.status !== "failed") throw new DomainError("request_rejected", "only failed documents can be discarded");
    if (await repo.discardFailed(trx, documentId)) {
      await audit(trx, { schoolId: session.schoolId, actorKind: "staff", actorId: session.sub, action: "document.discarded", detail: { document_id: documentId, batch_id: doc.batchId } });
    }
  });
}

export async function signedDownload(path: string, deps: { storage?: ObjectStorage } = {}): Promise<DocumentDownloadResponse> {
  const signed = await (deps.storage ?? storage()).signedUrl(path);
  return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
}

/** A secretaria baixa qualquer PDF pronto do lote, publicado ou não (para imprimir). Cada download é auditado. */
export async function staffDownload(session: SessionClaims, documentId: string, deps: { storage?: ObjectStorage } = {}): Promise<DocumentDownloadResponse> {
  const path = await withTenant(session.schoolId, async (trx) => {
    const doc = await repo.findDocument(trx, documentId);
    if (!doc || doc.status !== "rendered" || !doc.storagePath) throw new DomainError("not_found");
    await audit(trx, { schoolId: session.schoolId, actorKind: "staff", actorId: session.sub, action: "document.downloaded", detail: { document_id: documentId, batch_id: doc.batchId } });
    return doc.storagePath;
  });
  return signedDownload(path, deps);
}

/** GET /api/v1/files — só no driver local; o token assinado é a autorização. */
export async function readSignedFile(token: string): Promise<Buffer> {
  if (config().storage.driver !== "local") throw new DomainError("not_found");
  const path = verifyLocalToken(token);
  if (!path) throw new DomainError("not_found");
  try {
    return await storage().read(path);
  } catch {
    throw new DomainError("not_found");
  }
}
```

- [ ] **Step 4: Rotas**

Em `documentRoutes` (importe `LOCAL_FILES_ROUTE` de `../../platform/storage`):

```ts
  // Naturalmente idempotente: repetir só continua de onde parou (spec 8.3).
  app.post(`${B}/:id/render`, { config: { auth: OFFICE } }, async (req) =>
    service.renderBatch(req.session!, IdParams.parse(req.params).id, { log: req.log }),
  );
  app.post("/api/admin/v1/documents/:id/discard", { config: { auth: OFFICE } }, async (req, reply) => {
    await service.discardDocument(req.session!, IdParams.parse(req.params).id);
    return reply.status(204).send();
  });
  app.post("/api/admin/v1/documents/:id/download", { config: { auth: OFFICE } }, async (req) =>
    service.staffDownload(req.session!, IdParams.parse(req.params).id),
  );

  // Disco local: o token vai na query string, que o log de requisição descarta.
  const FileQuery = z.object({ t: z.string().min(1).max(2000) });
  app.get(LOCAL_FILES_ROUTE, { config: { auth: "public" } }, async (req, reply) => {
    const pdf = await service.readSignedFile(FileQuery.parse(req.query).t);
    return reply.type("application/pdf").header("content-disposition", 'inline; filename="documento.pdf"').send(pdf);
  });
```

Run do Step 1 → PASS.

- [ ] **Step 5: Rodar e commitar**

Run: `pnpm --filter @app-lanche/api exec vitest run src/modules/documents && pnpm typecheck && pnpm lint` → PASS.

```bash
git add apps/api/src/modules/documents
git commit -m "feat(documents): render batches in-request with leases, discard failures and serve signed downloads"
```

---
### Task 9: Publicação, evento `document.published` e documentos do responsável

**Files:**
- Modify: `packages/contracts/src/events.ts`, `packages/contracts/src/events.test.ts`
- Modify: `docs/superpowers/specs/2026-11-16-app-lanche-design.md` (exemplo da seção 6.3)
- Modify: `apps/api/src/app.ts` (`RouteAuth.scope` aceita lista), `apps/api/src/platform/session.ts`, `apps/api/src/platform/session.test.ts`
- Modify: `apps/api/test/helpers.ts` (`guardianCookie` com escopo)
- Modify: `apps/api/src/modules/documents/{repo.ts,service.ts,routes.ts}`
- Create: `apps/api/src/modules/documents/publish.test.ts`, `apps/api/src/modules/documents/guardian.test.ts`

**Interfaces:**
- Consumes: `batchInfo` (com trava), `batchSummaries`, `toSummary`, `countsOf`, `signedDownload` (Tasks 7–8); `enqueueEvent`; `documentsSetup` (Task 7).
- Produces (contracts): `DocumentPublishedEvent` na união `OutboxEvent`, `data = { guardian_id, phone, first_name, batch_id, template_name, students: string[] (min 1) }`.
- Produces (sessão): `RouteAuth` com `scope?: GuardianScope | GuardianScope[]`; `guardianCookie(schoolId, guardianId, scope?: "order" | "documents")`.
- Produces (repo): `batchRecipients(trx, batchId)`, `markPublished(trx, batchId): Promise<boolean>`, `guardianDocuments(trx, guardianId, documentId?)`, `recordView(trx, row)`.
- Produces (service): `publishBatch(session, key, batchId): Promise<BatchSummary>`; `listGuardianDocuments(session): Promise<GuardianDocumentListResponse>`; `guardianDownload(session, documentId, deps?): Promise<DocumentDownloadResponse>`.
- Produces (rotas): `POST /api/admin/v1/document-batches/:id/publish` (`OFFICE`, chave); `GET /api/v1/documents` e `POST /api/v1/documents/:id/download` (`{ kind: "guardian", scope: ["order", "documents"] }`, sem chave).

- [ ] **Step 1: Contrato do evento, exemplo da spec e fixture (teste falha)**

`events.ts`:

```ts
export const DocumentPublishedEvent = z.object({
  type: z.literal("document.published"),
  data: z.object({
    guardian_id: z.string().uuid(),
    phone: z.string(),
    first_name: z.string(),
    batch_id: z.string().uuid(),
    template_name: z.string().min(1),
    students: z.array(z.string()).min(1),
  }),
});
```

e inclua `DocumentPublishedEvent` na `z.discriminatedUnion` de `OutboxEvent`.

Spec 6.3: depois do exemplo `payment.late_credited`, acrescente o parágrafo "Exemplo de `document.published` (um por responsável; só primeiros nomes, nunca CPF ou nome completo):" e o bloco:

```json
{ "id": "0193…", "type": "document.published", "school_id": "0193…",
  "occurred_at": "2026-11-18T10:15:00-03:00",
  "data": { "guardian_id": "0193…", "phone": "+5511999990000", "first_name": "Ana",
            "batch_id": "0193…", "template_name": "Autorização de passeio", "students": ["Bia", "Léo"] } }
```

`events.test.ts`:

```ts
  it("accepts the document.published example from spec 6.3", () => {
    const example = {
      id: "0193a3b0-0000-7000-8000-000000000011",
      type: "document.published",
      school_id: "0193a3b0-0000-7000-8000-000000000002",
      occurred_at: "2026-11-18T10:15:00-03:00",
      data: {
        guardian_id: "0193a3b0-0000-7000-8000-000000000003",
        phone: "+5511999990000",
        first_name: "Ana",
        batch_id: "0193a3b0-0000-7000-8000-000000000012",
        template_name: "Autorização de passeio",
        students: ["Bia", "Léo"],
      },
    };
    expect(OutboxEnvelope.parse(example)).toEqual(example);
    expect(OutboxEvent.parse({ type: example.type, data: example.data })).toEqual({ type: example.type, data: example.data });
    expect(OutboxEvent.safeParse({ type: example.type, data: { ...example.data, students: [] } }).success).toBe(false);
  });
```

Run: `pnpm --filter @app-lanche/contracts test` → FAIL antes do schema, PASS depois.

- [ ] **Step 2: Lista de escopos na rota (teste falha)**

`session.test.ts` — na função `app()`, acrescente a rota

```ts
  a.get("/api/v1/any", { config: { auth: { kind: "guardian", scope: ["order", "documents"] } } }, async (req) => req.session);
```

e o teste:

```ts
  it("accepts any scope of a route that lists several", async () => {
    for (const scope of ["order", "documents"] as const) {
      const res = await app().inject({ method: "GET", url: "/api/v1/any", cookies: await cookieFor({ ...guardian, scope }) });
      expect(res.statusCode).toBe(200);
    }
  });
```

`app.ts`: `RouteAuth` passa a `{ kind: "guardian" | "staff" | "kitchen"; scope?: GuardianScope | GuardianScope[]; roles?: StaffRole[] }`.

`session.ts`, em `authenticate`, troque a checagem de escopo por:

```ts
  if (claims.kind === "guardian" && auth.scope !== undefined) {
    const allowed: GuardianScope[] = Array.isArray(auth.scope) ? auth.scope : [auth.scope];
    if (!allowed.includes(claims.scope)) throw new DomainError("insufficient_scope");
  }
```

`helpers.ts`:

```ts
export async function guardianCookie(schoolId: string, guardianId: string, scope: "order" | "documents" = "order"): Promise<Record<string, string>> {
  const token = await signToken("session", { kind: "guardian", sub: guardianId, schoolId, scope }, 3600);
  return { [SESSION_COOKIE]: token };
}
```

Run: `pnpm --filter @app-lanche/api exec vitest run src/platform/session.test.ts` → PASS.

- [ ] **Step 3: Testes de publicação e do responsável (falham)**

`apps/api/src/modules/documents/publish.test.ts`:

```ts
import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { describe, expect, it } from "vitest";
import { documentsSetup } from "../../../test/documents";
import { adminDb } from "../../../test/helpers";
import type { SessionClaims } from "../../platform/session";
import * as service from "./service";

const GUARDIAN_BODY = "# Autorização\n\nEu, {{responsavel.nome_completo}}, CPF {{responsavel.cpf}}, autorizo {{aluno.nome_completo}}.";

async function renderedBatch(bodyMd: string, opts: { secondGuardian?: boolean } = {}) {
  const s = await documentsSetup();
  let second: string | null = null;
  if (opts.secondGuardian) {
    second = uuidv7();
    await adminDb().insertInto("guardians").values({ id: second, schoolId: s.schoolId, phoneE164: "+5511977770002", firstName: "Rui", fullName: "Rui Souza", cpf: "11144477735" }).execute();
    await adminDb().insertInto("guardianStudents").values({ schoolId: s.schoolId, guardianId: second, studentId: s.leo }).execute();
  }
  const templateId = await s.template(bodyMd);
  const batchId = (await s.post("/api/admin/v1/document-batches", { templateId, studentIds: [s.leo, s.bia], fieldValues: {} })).json().id as string;
  const publish = (key = crypto.randomUUID()) => s.post(`/api/admin/v1/document-batches/${batchId}/publish`, undefined, key);
  const session: SessionClaims = { kind: "staff", sub: s.staffUserId, schoolId: s.schoolId, role: "secretaria" };
  const events = async () =>
    (await adminDb().selectFrom("outboxEvents").select(sql<string>`data::text`.as("data")).where("schoolId", "=", s.schoolId).where("type", "=", "document.published").execute()).map(
      (e) => JSON.parse(e.data) as Record<string, unknown>,
    );
  return { ...s, second, batchId, publish, session, events };
}

describe("publishing", () => {
  it("refuses while documents are pending or failed, then publishes once with one event per guardian", async () => {
    const b = await renderedBatch("# Declaração\n\n{{aluno.nome_completo}}");
    expect((await b.publish()).json().error.code).toBe("document_batch_not_ready");
    await service.renderBatch(b.session, b.batchId, { render: () => Promise.reject(new Error("x")) });
    await service.renderBatch(b.session, b.batchId, { render: () => Promise.reject(new Error("x")) });
    await service.renderBatch(b.session, b.batchId, { render: () => Promise.reject(new Error("x")) });
    expect((await b.publish()).json().error.code).toBe("document_batch_not_ready");

    const fresh = await renderedBatch("# Declaração\n\n{{aluno.nome_completo}}");
    await fresh.post(`/api/admin/v1/document-batches/${fresh.batchId}/render`, undefined, null);
    const res = await fresh.publish();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "published", recipients: 1, viewers: 0 });
    expect(res.json().publishedAt).not.toBeNull();
    const events = await fresh.events();
    expect(events).toEqual([
      { guardian_id: fresh.guardianId, phone: expect.stringMatching(/^\+55/), first_name: "Ana", batch_id: fresh.batchId, template_name: "Modelo", students: ["Bia", "Léo"] },
    ]);
    const again = await fresh.publish();
    expect(again.statusCode).toBe(200);
    expect(await fresh.events()).toHaveLength(1);
    const audit = await adminDb().selectFrom("auditLog").select("action").where("schoolId", "=", fresh.schoolId).where("action", "=", "document_batch.published").execute();
    expect(audit).toHaveLength(1);
  });

  it("publishes after discarding the failed documents and never puts CPF or full names in events", async () => {
    const b = await renderedBatch(GUARDIAN_BODY, { secondGuardian: true });
    const { renderDocument } = await import("./pdf");
    await service.renderBatch(b.session, b.batchId, {
      render: (title, body, ctx) => (ctx.guardian?.firstName === "Rui" ? Promise.reject(new Error("x")) : renderDocument(title, body, ctx)),
    });
    for (let i = 0; i < 2; i += 1) await service.renderBatch(b.session, b.batchId, { render: () => Promise.reject(new Error("x")) });
    const failed = await adminDb().selectFrom("documents").select("id").where("batchId", "=", b.batchId).where("status", "=", "failed").executeTakeFirstOrThrow();
    expect((await b.post(`/api/admin/v1/documents/${failed.id}/discard`, undefined, null)).statusCode).toBe(204);
    expect((await b.publish()).statusCode).toBe(200);
    const events = await b.events();
    expect(events).toEqual([expect.objectContaining({ guardian_id: b.guardianId, students: ["Bia", "Léo"] })]);
    const raw = JSON.stringify(events);
    for (const secret of ["52998224725", "529.982.247-25", "Souza", "Ana Paula"]) expect(raw).not.toContain(secret);
  });
});
```

`apps/api/src/modules/documents/guardian.test.ts`:

```ts
import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { describe, expect, it } from "vitest";
import { documentsSetup } from "../../../test/documents";
import { adminDb, guardianCookie, seedFamily } from "../../../test/helpers";

async function published(bodyMd: string, opts: { secondGuardian?: boolean } = {}) {
  const s = await documentsSetup();
  let second: string | null = null;
  if (opts.secondGuardian) {
    second = uuidv7();
    await adminDb().insertInto("guardians").values({ id: second, schoolId: s.schoolId, phoneE164: "+5511977770003", firstName: "Rui", fullName: "Rui Souza", cpf: "11144477735" }).execute();
    await adminDb().insertInto("guardianStudents").values({ schoolId: s.schoolId, guardianId: second, studentId: s.leo }).execute();
  }
  const templateId = await s.template(bodyMd);
  const batchId = (await s.post("/api/admin/v1/document-batches", { templateId, studentIds: [s.leo, s.bia], fieldValues: {} })).json().id as string;
  await s.post(`/api/admin/v1/document-batches/${batchId}/render`, undefined, null);
  return { ...s, second, batchId, templateId };
}

describe("guardian documents", () => {
  it("lists only published documents of the guardian's children, with any scope", async () => {
    const s = await published("# Declaração de matrícula\n\n{{aluno.nome_completo}}");
    const list = (scope: "order" | "documents") =>
      guardianCookie(s.schoolId, s.guardianId, scope).then((cookies) => s.app.inject({ method: "GET", url: "/api/v1/documents", cookies }));
    expect((await list("order")).json()).toEqual({ documents: [] });
    await s.post(`/api/admin/v1/document-batches/${s.batchId}/publish`);
    for (const scope of ["order", "documents"] as const) {
      const res = await list(scope);
      expect(res.statusCode).toBe(200);
      expect(res.json().documents.map((d: { studentFirstName: string }) => d.studentFirstName).sort()).toEqual(["Bia", "Léo"]);
      expect(res.json().documents[0]).toMatchObject({ title: "Modelo", category: "outro", viewed: false });
    }
    const stranger = await seedFamily(s.schoolId, ["Caio"]);
    const other = await s.app.inject({ method: "GET", url: "/api/v1/documents", cookies: await guardianCookie(s.schoolId, stranger.guardianId) });
    expect(other.json()).toEqual({ documents: [] });
  });

  it("shows a per-guardian document only to its guardian", async () => {
    const s = await published("# Autorização\n\n{{responsavel.nome_completo}} autoriza {{aluno.primeiro_nome}}.", { secondGuardian: true });
    await s.post(`/api/admin/v1/document-batches/${s.batchId}/publish`);
    const titlesOf = async (guardianId: string) =>
      (await s.app.inject({ method: "GET", url: "/api/v1/documents", cookies: await guardianCookie(s.schoolId, guardianId, "documents") })).json().documents.map(
        (d: { studentFirstName: string }) => d.studentFirstName,
      );
    expect((await titlesOf(s.guardianId)).sort()).toEqual(["Bia", "Léo"]);
    expect(await titlesOf(s.second!)).toEqual(["Léo"]);
    const ruiDoc = await adminDb().selectFrom("documents").select("id").where("batchId", "=", s.batchId).where("guardianId", "=", s.second).executeTakeFirstOrThrow();
    const forbidden = await s.app.inject({ method: "POST", url: `/api/v1/documents/${ruiDoc.id}/download`, cookies: await guardianCookie(s.schoolId, s.guardianId) });
    expect(forbidden.statusCode).toBe(404);
  });

  it("downloads by a signed URL, records the first opening once and audits every download", async () => {
    const s = await published("# Declaração\n\n{{aluno.nome_completo}}");
    await s.post(`/api/admin/v1/document-batches/${s.batchId}/publish`);
    const cookies = await guardianCookie(s.schoolId, s.guardianId, "documents");
    const [doc] = (await s.app.inject({ method: "GET", url: "/api/v1/documents", cookies })).json().documents;
    const download = () => s.app.inject({ method: "POST", url: `/api/v1/documents/${doc.id}/download`, cookies });
    const first = await download();
    expect(first.statusCode).toBe(200);
    const pdf = await s.app.inject({ method: "GET", url: first.json().url });
    expect(pdf.rawPayload.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    await download();
    const views = await adminDb().selectFrom("documentViews").select(["guardianId"]).where("documentId", "=", doc.id).execute();
    expect(views).toEqual([{ guardianId: s.guardianId }]);
    const audits = await adminDb().selectFrom("auditLog").select(["actorKind", "actorId"]).where("schoolId", "=", s.schoolId).where("action", "=", "document.downloaded").execute();
    expect(audits).toEqual([
      { actorKind: "guardian", actorId: s.guardianId },
      { actorKind: "guardian", actorId: s.guardianId },
    ]);
    expect((await s.app.inject({ method: "GET", url: "/api/v1/documents", cookies })).json().documents.find((d: { id: string }) => d.id === doc.id).viewed).toBe(true);
    expect((await s.get("/api/admin/v1/document-batches")).json().batches[0]).toMatchObject({ recipients: 1, viewers: 1 });
    const detail = (await s.get(`/api/admin/v1/document-batches/${s.batchId}`)).json();
    expect(detail.documents.find((d: { id: string }) => d.id === doc.id).viewed).toBe(true);
    const row = await adminDb().selectFrom("documentViews").select(sql<boolean>`first_viewed_at <= now()`.as("ok")).where("documentId", "=", doc.id).executeTakeFirstOrThrow();
    expect(row.ok).toBe(true);
  });

  it("does not serve unpublished documents or documents of another school", async () => {
    const s = await published("# Declaração\n\n{{aluno.nome_completo}}");
    const doc = await adminDb().selectFrom("documents").select("id").where("batchId", "=", s.batchId).executeTakeFirstOrThrow();
    const cookies = await guardianCookie(s.schoolId, s.guardianId);
    expect((await s.app.inject({ method: "POST", url: `/api/v1/documents/${doc.id}/download`, cookies })).statusCode).toBe(404);
    const other = await documentsSetup();
    const foreign = await other.app.inject({ method: "POST", url: `/api/v1/documents/${doc.id}/download`, cookies: await guardianCookie(other.schoolId, other.guardianId) });
    expect(foreign.statusCode).toBe(404);
    expect(await adminDb().selectFrom("documentViews").select("id").where("documentId", "=", doc.id).execute()).toEqual([]);
  });
});
```

Run: `pnpm --filter @app-lanche/api exec vitest run src/modules/documents/publish.test.ts src/modules/documents/guardian.test.ts` → FAIL.

- [ ] **Step 4: Repo**

Acrescente a `repo.ts`:

```ts
/** Um par (responsável, aluno) por documento pronto e não descartado; documento por aluno vai a todo responsável dele. */
export async function batchRecipients(trx: Trx, batchId: string) {
  const { rows } = await sql<{ guardianId: string; phone: string; firstName: string; studentFirstName: string }>`
    SELECT g.id AS guardian_id, g.phone_e164 AS phone, g.first_name, s.first_name AS student_first_name
    FROM documents d
    JOIN students s ON s.id = d.student_id
    LEFT JOIN guardian_students gs ON d.guardian_id IS NULL AND gs.student_id = d.student_id
    JOIN guardians g ON g.id = coalesce(d.guardian_id, gs.guardian_id)
    WHERE d.batch_id = ${batchId} AND d.status = 'rendered' AND d.discarded_at IS NULL
    ORDER BY g.id, s.first_name`.execute(trx);
  return rows;
}

export async function markPublished(trx: Trx, batchId: string): Promise<boolean> {
  const res = await trx
    .updateTable("documentBatches")
    .set({ status: "published", publishedAt: sql`now()` })
    .where("id", "=", batchId)
    .where("status", "=", "ready")
    .executeTakeFirst();
  return res.numUpdatedRows > 0n;
}

/** Documentos publicados visíveis ao responsável; com `documentId`, só aquele. */
export async function guardianDocuments(trx: Trx, guardianId: string, documentId: string | null = null) {
  const { rows } = await sql<{
    id: string;
    title: string;
    category: string;
    studentFirstName: string;
    publishedAt: Date;
    viewed: boolean;
    storagePath: string;
    batchId: string;
  }>`
    SELECT d.id, t.name AS title, t.category, s.first_name AS student_first_name, b.published_at, d.storage_path, d.batch_id,
      EXISTS (SELECT 1 FROM document_views v WHERE v.document_id = d.id AND v.guardian_id = ${guardianId}) AS viewed
    FROM documents d
    JOIN document_batches b ON b.id = d.batch_id
    JOIN document_templates t ON t.id = b.template_id
    JOIN students s ON s.id = d.student_id
    WHERE b.status = 'published' AND d.status = 'rendered' AND d.discarded_at IS NULL
      AND (d.guardian_id = ${guardianId}
           OR (d.guardian_id IS NULL AND EXISTS (
                SELECT 1 FROM guardian_students gs WHERE gs.guardian_id = ${guardianId} AND gs.student_id = d.student_id)))
      AND (${documentId}::uuid IS NULL OR d.id = ${documentId}::uuid)
    ORDER BY b.published_at DESC, s.first_name, d.id`.execute(trx);
  return rows;
}

export async function recordView(trx: Trx, row: { id: string; schoolId: string; documentId: string; guardianId: string }): Promise<void> {
  await trx.insertInto("documentViews").values(row).onConflict((oc) => oc.constraint("document_views_once").doNothing()).execute();
}
```

- [ ] **Step 5: Service**

Acrescente a `service.ts` (importe `enqueueEvent` de `../../platform/outbox`; `GuardianDocumentListResponse` de contracts):

```ts
export async function publishBatch(session: SessionClaims, key: string, batchId: string): Promise<BatchSummary> {
  const schoolId = session.schoolId;
  const hash = requestHash({ route: `POST /api/admin/v1/document-batches/${batchId}/publish`, actorId: session.sub, body: {} });
  return withTenant(schoolId, async (trx) => {
    const { response } = await idempotent(trx, { schoolId, key, requestHash: hash }, async () => {
      const batch = await repo.batchInfo(trx, batchId, "update");
      if (!batch) throw new DomainError("not_found");
      const summaryOf = async () => toSummary((await repo.batchSummaries(trx, batchId))[0]!);
      if (batch.status === "published") return summaryOf();
      const counts = countsOf((await repo.batchSummaries(trx, batchId))[0]!);
      const notReady = batch.status !== "ready" || counts.pending + counts.rendering + counts.failed > 0 || counts.rendered === 0;
      if (notReady) throw new DomainError("document_batch_not_ready");
      if (!(await repo.markPublished(trx, batchId))) return summaryOf();

      const byGuardian = new Map<string, { phone: string; firstName: string; students: Set<string> }>();
      for (const r of await repo.batchRecipients(trx, batchId)) {
        const entry = byGuardian.get(r.guardianId) ?? { phone: r.phone, firstName: r.firstName, students: new Set<string>() };
        entry.students.add(r.studentFirstName);
        byGuardian.set(r.guardianId, entry);
      }
      for (const [guardianId, g] of byGuardian) {
        await enqueueEvent(trx, schoolId, {
          type: "document.published",
          data: {
            guardian_id: guardianId,
            phone: g.phone,
            first_name: g.firstName,
            batch_id: batchId,
            template_name: batch.templateName,
            students: [...g.students].sort((a, b) => a.localeCompare(b, "pt-BR")),
          },
        });
      }
      await audit(trx, { schoolId, actorKind: "staff", actorId: session.sub, action: "document_batch.published", detail: { batch_id: batchId, recipients: byGuardian.size } });
      return summaryOf();
    });
    return response;
  });
}

export async function listGuardianDocuments(session: SessionClaims): Promise<GuardianDocumentListResponse> {
  const rows = await withTenant(session.schoolId, (trx) => repo.guardianDocuments(trx, session.sub));
  return {
    documents: rows.map((r) => ({
      id: r.id,
      title: r.title,
      category: r.category as DocumentCategory,
      studentFirstName: r.studentFirstName,
      publishedAt: r.publishedAt.toISOString(),
      viewed: r.viewed,
    })),
  };
}

/** POST porque registra a primeira abertura (regra 24); repetir não duplica a abertura. */
export async function guardianDownload(session: SessionClaims, documentId: string, deps: { storage?: ObjectStorage } = {}): Promise<DocumentDownloadResponse> {
  const path = await withTenant(session.schoolId, async (trx) => {
    const [doc] = await repo.guardianDocuments(trx, session.sub, documentId);
    if (!doc) throw new DomainError("not_found");
    await repo.recordView(trx, { id: uuidv7(), schoolId: session.schoolId, documentId, guardianId: session.sub });
    await audit(trx, { schoolId: session.schoolId, actorKind: "guardian", actorId: session.sub, action: "document.downloaded", detail: { document_id: documentId, batch_id: doc.batchId } });
    return doc.storagePath;
  });
  return signedDownload(path, deps);
}
```

- [ ] **Step 6: Rotas**

Em `documentRoutes`:

```ts
  const GUARDIAN: RouteAuth = { kind: "guardian", scope: ["order", "documents"] };

  app.post(`${B}/:id/publish`, { config: { auth: OFFICE } }, async (req) =>
    service.publishBatch(req.session!, idempotencyKeyFrom(req), IdParams.parse(req.params).id),
  );

  app.get("/api/v1/documents", { config: { auth: GUARDIAN } }, async (req) => service.listGuardianDocuments(req.session!));
  // Sem Idempotency-Key: registrar a abertura é idempotente por constraint (spec 8.4).
  app.post("/api/v1/documents/:id/download", { config: { auth: GUARDIAN } }, async (req) =>
    service.guardianDownload(req.session!, IdParams.parse(req.params).id),
  );
```

Run do Step 3 → PASS.

- [ ] **Step 7: Rodar e commitar**

Run: `pnpm --filter @app-lanche/contracts test && pnpm --filter @app-lanche/api exec vitest run src/modules/documents src/platform && pnpm typecheck && pnpm lint` → PASS.

```bash
git add packages/contracts/src/events.ts packages/contracts/src/events.test.ts docs/superpowers/specs/2026-11-16-app-lanche-design.md apps/api/src/app.ts apps/api/src/platform/session.ts apps/api/src/platform/session.test.ts apps/api/test/helpers.ts apps/api/src/modules/documents
git commit -m "feat(documents): publish batches to guardians through the outbox and serve their downloads"
```

---

### Task 10: n8n — aviso de documento publicado

**Files:**
- Modify: `n8n/code/events.js`, `n8n/workflows/events.json` (regerado)
- Modify: `apps/api/test/n8n.test.ts`
- Modify: `docs/n8n.md`

**Interfaces:**
- Consumes: evento `document.published` (Task 9); `POST /internal/v1/schools/:school_id/magic-links` com `{ guardian_id, scope: "documents" }` (existe desde a F3).
- Produces: variável de ambiente do n8n `WA_TEMPLATE_DOCUMENT`; modelo do WhatsApp com 4 parâmetros (primeiro nome, nome do modelo, filhos, link).

- [ ] **Step 1: Teste (falha)**

`apps/api/test/n8n.test.ts`: em `ENV`, acrescente `WA_TEMPLATE_DOCUMENT: "documento_publicado"`. Dentro de `describe("events", …)`:

```ts
    it("sends the document link with a documents-scope magic link from document.published", async () => {
      const schoolId = await createSchool();
      const fam = await seedFamily(schoolId, ["Léo", "Bia"]);
      const data = { guardian_id: fam.guardianId, phone: "+5511999990003", first_name: "Ana", batch_id: crypto.randomUUID(), template_name: "Autorização de passeio", students: ["Bia", "Léo"] };
      const req = await withN8n(async () => signedEventRequest({ ...envelope(crypto.randomUUID(), "document.published", data), school_id: schoolId }));
      const h = harness(schoolId);
      const staticData = {};
      const input = { json: { headers: req.headers } };
      const out = await h.run(code("events.json", "Verify and send"), { input, raw: req.body, staticData });
      expect(out).toEqual([{ json: { ok: true, type: "document.published", email: null } }]);
      expect(h.whatsapp).toEqual([
        expect.objectContaining({ to: "5511999990003", template: "documento_publicado", params: ["Ana", "Autorização de passeio", "Bia e Léo", expect.stringMatching(/^https:\/\/app\.test\/l#/)] }),
      ]);
      const links = await adminDb().selectFrom("magicLinks").select(["scope", "serviceDate"]).where("guardianId", "=", fam.guardianId).execute();
      expect(links).toEqual([{ scope: "documents", serviceDate: null }]);
      const dup = await h.run(code("events.json", "Verify and send"), { input, raw: req.body, staticData });
      expect(dup[0]!.json).toMatchObject({ duplicate: true });
      expect(h.whatsapp).toHaveLength(1);
    });
```

Run: `pnpm --filter @app-lanche/api exec vitest run test/n8n.test.ts` → FAIL (o fluxo ignora o tipo).

- [ ] **Step 2: Fluxo**

`n8n/code/events.js`, novo `case` antes do `default`:

```js
  case "document.published": {
    // Link de escopo `documents` (7 dias) pedido à API; o n8n nunca gera token (spec 4.1). Falha → 500 → nova tentativa.
    const link = ensureOk(
      await api(this, "POST", `/internal/v1/schools/${event.school_id}/magic-links`, { guardian_id: d.guardian_id, scope: "documents" }),
      "magic link",
    );
    await send.call(this, d.phone, $env.WA_TEMPLATE_DOCUMENT, [d.first_name, d.template_name, joinNames(d.students), link.link_url]);
    break;
  }
```

Regere: `pnpm n8n:build`.

Run do Step 1 → PASS (inclui o teste "are built from n8n/code").

- [ ] **Step 3: Documentação**

`docs/n8n.md`:
- Tabela de variáveis: `WA_TEMPLATE_DOCUMENT` entra na linha dos nomes de modelo.
- "Comportamento dos fluxos": "Documentos: para cada `document.published` o fluxo pede um magic link de escopo `documents` em `POST /internal/v1/schools/{school_id}/magic-links` (vale 7 dias) e envia o modelo de documento; falha no pedido do link ou no envio responde 500 e a outbox tenta de novo (cada tentativa gera um link novo; os antigos continuam válidos até vencer)."
- "Modelos do WhatsApp":
  ```
  - Documento publicado (utility): `{{1}}` primeiro nome, `{{2}}` nome do documento, `{{3}}` filhos, `{{4}}` link.
    Texto: "Olá, {{1}}! A escola publicou {{2}} de {{3}}. Para ver e baixar, acesse em até 7 dias: {{4}}"
  ```
- "Dados pessoais no n8n": o evento de documento traz só primeiros nomes, o nome do modelo e o telefone; CPF e nomes completos ficam só no PDF.

- [ ] **Step 4: Rodar e commitar**

Run: `pnpm --filter @app-lanche/api exec vitest run test/n8n.test.ts && pnpm lint` → PASS.

```bash
git add n8n/code/events.js n8n/workflows/events.json apps/api/test/n8n.test.ts docs/n8n.md
git commit -m "feat(n8n): send the document link on document.published"
```

---
### Task 11: Web — "Alunos e responsáveis" (lista, filtros e edição)

**Files:**
- Create: `apps/web/src/areas/admin/useStaffErrors.ts`, `apps/web/src/areas/admin/studentFilter.ts`, `apps/web/src/areas/admin/StudentsAdmin.tsx`, `apps/web/src/areas/admin/studentsAdmin.test.tsx`
- Create: `apps/web/src/ui/dates.ts`, `apps/web/src/ui/dates.test.ts`
- Modify: `apps/web/src/ui/messages.ts`, `apps/web/src/areas/admin/AdminHome.tsx`, `apps/web/src/app/App.tsx`

**Interfaces:**
- Consumes: `StudentListResponse`, `ClassListResponse`, `GuardianDetail`, `formatCpf` (Task 2); rotas da Task 2.
- Produces: `useStaffErrors(): { error: string | null; setError(msg: string | null): void; fail(err: unknown): void }` (401 → `/admin/login`); `type StudentRow`; `filterStudents(students, { classId, query }): StudentRow[]`; `studentLabel(s): string`; `StudentFilters` (props `{ classes, classId, query, onClass, onQuery }`, campos com rótulos "Turma" e "Buscar por nome"); `formatIsoDate("2021-03-15") → "15/03/2021"`; `formatInstantDate(iso) → "dd/mm/aaaa"` no fuso do navegador; rota `/admin/alunos`.

- [ ] **Step 1: Testes (falham)**

`apps/web/src/ui/dates.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatIsoDate } from "./dates";

describe("dates", () => {
  it("formats a civil date without time zone shifts", () => {
    expect(formatIsoDate("2021-03-05")).toBe("05/03/2021");
  });
});
```

`apps/web/src/areas/admin/studentsAdmin.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StudentsAdmin } from "./StudentsAdmin";
import { filterStudents } from "./studentFilter";

type Reply = { status: number; body?: unknown };

function mockApi(replies: Record<string, Reply>) {
  const fn = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url, init) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    const reply = replies[key];
    if (!reply) throw new Error(`unexpected request ${key}`);
    return reply.status === 204 ? new Response(null, { status: 204 }) : new Response(JSON.stringify(reply.body), { status: reply.status });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function bodyOf(fn: ReturnType<typeof mockApi>, key: string): unknown {
  const call = fn.mock.calls.find((c) => `${c[1]?.method ?? "GET"} ${c[0]}` === key);
  return call ? JSON.parse(call[1]!.body as string) : undefined;
}

const U = (n: number) => `0193a000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const [C1, C2, S1, S2, G1] = [U(1), U(2), U(3), U(4), U(5)];
const CLASSES = { classes: [{ id: C1, name: "Infantil 3A" }, { id: C2, name: "Infantil 4B" }] };
const STUDENTS = {
  students: [
    {
      id: S1, externalCode: "A1", firstName: "Léo", fullName: "Leonardo Souza", birthDate: "2021-03-15", classId: C1, className: "Infantil 3A",
      guardians: [{ id: G1, firstName: "Ana", fullName: "Ana Paula Souza", phone: "+5511999990001", cpfMasked: "***.982.247-**" }],
    },
    { id: S2, externalCode: "B1", firstName: "Caio", fullName: null, birthDate: null, classId: C2, className: "Infantil 4B", guardians: [] },
  ],
};
const BASE: Record<string, Reply> = {
  "GET /api/admin/v1/students": { status: 200, body: STUDENTS },
  "GET /api/admin/v1/classes": { status: 200, body: CLASSES },
};
const GUARDIAN: Reply = { status: 200, body: { id: G1, firstName: "Ana", fullName: "Ana Paula Souza", cpf: "52998224725" } };

function renderPage() {
  render(
    <MemoryRouter initialEntries={["/admin/alunos"]}>
      <Routes>
        <Route path="/admin/alunos" element={<StudentsAdmin />} />
        <Route path="/admin/login" element={<p>login</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("filterStudents", () => {
  it("filters by class and by an accent-insensitive name", () => {
    expect(filterStudents(STUDENTS.students, { classId: C2, query: "" }).map((s) => s.id)).toEqual([S2]);
    expect(filterStudents(STUDENTS.students, { classId: "", query: "leo" }).map((s) => s.id)).toEqual([S1]);
    expect(filterStudents(STUDENTS.students, { classId: "", query: " SOUZA " }).map((s) => s.id)).toEqual([S1]);
  });
});

describe("students admin", () => {
  it("lists students with the CPF masked and filters them", async () => {
    mockApi(BASE);
    renderPage();
    await screen.findByText("Leonardo Souza");
    expect(screen.getByText("15/03/2021")).toBeTruthy();
    expect(screen.getByText(/\*\*\*\.982\.247-\*\*/)).toBeTruthy();
    expect(screen.getByText("Nenhum responsável")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Turma"), { target: { value: C2 } });
    expect(screen.queryByText("Leonardo Souza")).toBeNull();
    expect(screen.getByText("Caio")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Turma"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Buscar por nome"), { target: { value: "leo" } });
    expect(screen.queryByText("Caio")).toBeNull();
  });

  it("edits a student's full name and birth date", async () => {
    const fn = mockApi({ ...BASE, [`PUT /api/admin/v1/students/${S2}`]: { status: 204 } });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Editar aluno Caio" }));
    fireEvent.change(screen.getByLabelText("Nome completo"), { target: { value: " Caio Lima " } });
    fireEvent.change(screen.getByLabelText("Data de nascimento"), { target: { value: "2020-05-08" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await screen.findByText("Dados salvos.");
    expect(bodyOf(fn, `PUT /api/admin/v1/students/${S2}`)).toEqual({ fullName: "Caio Lima", birthDate: "2020-05-08" });
  });

  it("edits a guardian, showing the full CPF only inside the form", async () => {
    const fn = mockApi({ ...BASE, [`GET /api/admin/v1/guardians/${G1}`]: GUARDIAN, [`PUT /api/admin/v1/guardians/${G1}`]: { status: 204 } });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Editar responsável Ana" }));
    const cpf = (await screen.findByLabelText("CPF")) as HTMLInputElement;
    await waitFor(() => expect(cpf.value).toBe("529.982.247-25"));
    fireEvent.change(cpf, { target: { value: "111.444.777-35" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await screen.findByText("Dados salvos.");
    expect(bodyOf(fn, `PUT /api/admin/v1/guardians/${G1}`)).toEqual({ fullName: "Ana Paula Souza", cpf: "111.444.777-35" });
  });

  it("shows the validation message when the server refuses the CPF", async () => {
    mockApi({
      ...BASE,
      [`GET /api/admin/v1/guardians/${G1}`]: GUARDIAN,
      [`PUT /api/admin/v1/guardians/${G1}`]: { status: 400, body: { error: { code: "validation_failed", message: "x" } } },
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Editar responsável Ana" }));
    await waitFor(() => expect((screen.getByLabelText("CPF") as HTMLInputElement).value).toBe("529.982.247-25"));
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await screen.findByText("Confira os dados e tente de novo.");
  });

  it("sends an expired session to the login", async () => {
    mockApi({ ...BASE, "GET /api/admin/v1/students": { status: 401, body: { error: { code: "unauthenticated", message: "x" } } } });
    renderPage();
    await screen.findByText("login");
  });
});
```

Run: `pnpm --filter @app-lanche/web exec vitest run src/ui/dates.test.ts src/areas/admin/studentsAdmin.test.tsx` → FAIL.

- [ ] **Step 2: Implementar**

`apps/web/src/ui/dates.ts`:

```ts
/** "2021-03-15" → "15/03/2021", sem passar por Date (sem deslocamento de fuso). */
export function formatIsoDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

/** Instante ISO → data local do navegador. */
export function formatInstantDate(iso: string): string {
  return new Date(iso).toLocaleDateString("pt-BR");
}
```

`apps/web/src/areas/admin/useStaffErrors.ts`:

```ts
import { useCallback, useState } from "react";
import { useNavigate } from "react-router";
import { ApiError } from "../../app/api";
import { staffErrorMessage } from "../../ui/messages";

/** Erro numa tela da equipe: sessão vencida leva ao login; o resto vira mensagem. */
export function useStaffErrors() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const fail = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) {
        navigate("/admin/login", { replace: true });
        return;
      }
      setError(staffErrorMessage(err instanceof ApiError ? err.code : "internal_error"));
    },
    [navigate],
  );
  return { error, setError, fail };
}
```

`apps/web/src/areas/admin/studentFilter.ts`:

```ts
import type { ClassListResponse, StudentListResponse } from "@app-lanche/contracts";

export type StudentRow = StudentListResponse["students"][number];

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

export function filterStudents(students: StudentRow[], filter: { classId: string; query: string }): StudentRow[] {
  const q = fold(filter.query.trim());
  return students.filter(
    (s) => (filter.classId === "" || s.classId === filter.classId) && (q === "" || fold(`${s.firstName} ${s.fullName ?? ""}`).includes(q)),
  );
}

export function studentLabel(s: StudentRow): string {
  return s.fullName ?? s.firstName;
}

export type ClassRow = ClassListResponse["classes"][number];
```

`apps/web/src/areas/admin/StudentsAdmin.tsx`:

```tsx
import { ClassListResponse, GuardianDetail, StudentListResponse, formatCpf } from "@app-lanche/contracts";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { z } from "zod";
import { apiFetch } from "../../app/api";
import { formatIsoDate } from "../../ui/dates";
import { filterStudents, studentLabel, type ClassRow, type StudentRow } from "./studentFilter";
import { useStaffErrors } from "./useStaffErrors";

export function StudentFilters(props: { classes: ClassRow[]; classId: string; query: string; onClass: (id: string) => void; onQuery: (q: string) => void }) {
  return (
    <div>
      <label htmlFor="filter-class">Turma</label>
      <select id="filter-class" value={props.classId} onChange={(e) => props.onClass(e.target.value)}>
        <option value="">Todas</option>
        {props.classes.map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>
      <label htmlFor="filter-query">Buscar por nome</label>
      <input id="filter-query" type="search" value={props.query} onChange={(e) => props.onQuery(e.target.value)} />
    </div>
  );
}

type FormProps = { onSaved: () => Promise<void>; onCancel: () => void; onError: (err: unknown) => void };

function StudentForm({ student, onSaved, onCancel, onError }: FormProps & { student: StudentRow }) {
  const [fullName, setFullName] = useState(student.fullName ?? "");
  const [birthDate, setBirthDate] = useState(student.birthDate ?? "");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await apiFetch(`/api/admin/v1/students/${student.id}`, z.undefined(), {
        method: "PUT",
        body: { fullName: fullName.trim() || null, birthDate: birthDate || null },
      });
      await onSaved();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <h2>{student.firstName} — {student.className}</h2>
      <label htmlFor="student-full-name">Nome completo</label>
      <input id="student-full-name" maxLength={200} value={fullName} onChange={(e) => setFullName(e.target.value)} />
      <label htmlFor="student-birth-date">Data de nascimento</label>
      <input id="student-birth-date" type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} />
      <button type="submit" disabled={busy}>Salvar</button>
      <button type="button" onClick={onCancel}>Cancelar</button>
    </form>
  );
}

function GuardianForm({ guardianId, onSaved, onCancel, onError }: FormProps & { guardianId: string }) {
  const [detail, setDetail] = useState<GuardianDetail | null>(null);
  const [fullName, setFullName] = useState("");
  const [cpf, setCpf] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiFetch(`/api/admin/v1/guardians/${guardianId}`, GuardianDetail).then((d) => {
      setDetail(d);
      setFullName(d.fullName ?? "");
      setCpf(d.cpf ? formatCpf(d.cpf) : "");
    }, onError);
  }, [guardianId, onError]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await apiFetch(`/api/admin/v1/guardians/${guardianId}`, z.undefined(), {
        method: "PUT",
        body: { fullName: fullName.trim() || null, cpf: cpf.trim() || null },
      });
      await onSaved();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  if (!detail) return <p>Carregando…</p>;
  return (
    <form onSubmit={submit}>
      <h2>Responsável: {detail.firstName}</h2>
      <label htmlFor="guardian-full-name">Nome completo do responsável</label>
      <input id="guardian-full-name" maxLength={200} value={fullName} onChange={(e) => setFullName(e.target.value)} />
      <label htmlFor="guardian-cpf">CPF</label>
      <input id="guardian-cpf" inputMode="numeric" autoComplete="off" maxLength={14} value={cpf} onChange={(e) => setCpf(e.target.value)} />
      <button type="submit" disabled={busy}>Salvar</button>
      <button type="button" onClick={onCancel}>Cancelar</button>
    </form>
  );
}

export function StudentsAdmin() {
  const { error, setError, fail } = useStaffErrors();
  const [students, setStudents] = useState<StudentRow[] | null>(null);
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [classId, setClassId] = useState("");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<{ kind: "student"; student: StudentRow } | { kind: "guardian"; id: string } | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([
        apiFetch("/api/admin/v1/students", StudentListResponse),
        apiFetch("/api/admin/v1/classes", ClassListResponse),
      ]);
      setStudents(s.students);
      setClasses(c.classes);
    } catch (err) {
      fail(err);
    }
  }, [fail]);

  useEffect(() => void load(), [load]);

  function edit(next: typeof editing) {
    setStatus(null);
    setError(null);
    setEditing(next);
  }

  async function saved() {
    setEditing(null);
    setStatus("Dados salvos.");
    await load();
  }

  if (!students) return <main>{error ? <p role="alert">{error}</p> : <p>Carregando…</p>}</main>;
  const visible = filterStudents(students, { classId, query });
  const formProps = { onSaved: saved, onCancel: () => setEditing(null), onError: fail };

  return (
    <main>
      <p><Link to="/admin">Voltar</Link></p>
      <h1>Alunos e responsáveis</h1>
      <StudentFilters classes={classes} classId={classId} query={query} onClass={setClassId} onQuery={setQuery} />
      {status && <p role="status">{status}</p>}
      {error && <p role="alert">{error}</p>}
      {editing?.kind === "student" && <StudentForm key={editing.student.id} student={editing.student} {...formProps} />}
      {editing?.kind === "guardian" && <GuardianForm key={editing.id} guardianId={editing.id} {...formProps} />}
      <table>
        <thead>
          <tr><th>Aluno</th><th>Turma</th><th>Nascimento</th><th>Responsáveis</th></tr>
        </thead>
        <tbody>
          {visible.map((s) => (
            <tr key={s.id}>
              <td>
                <span>{studentLabel(s)}</span>{" "}
                <button type="button" aria-label={`Editar aluno ${studentLabel(s)}`} onClick={() => edit({ kind: "student", student: s })}>Editar</button>
              </td>
              <td>{s.className}</td>
              <td>{s.birthDate ? formatIsoDate(s.birthDate) : "—"}</td>
              <td>
                {s.guardians.length === 0 ? (
                  <span>Nenhum responsável</span>
                ) : (
                  <ul>
                    {s.guardians.map((g) => (
                      <li key={g.id}>
                        {g.fullName ?? g.firstName} — {g.cpfMasked ?? "CPF não informado"}{" "}
                        <button type="button" aria-label={`Editar responsável ${g.firstName}`} onClick={() => edit({ kind: "guardian", id: g.id })}>Editar</button>
                      </li>
                    ))}
                  </ul>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
```

`apps/web/src/ui/messages.ts` — em `STAFF_MESSAGES`, acrescente:

```ts
  not_found: "Não encontrado. Atualize a página.",
  document_template_invalid: "O modelo usa variáveis que não existem. Corrija as marcadas abaixo.",
  document_template_outdated: "Este modelo foi alterado por outra pessoa. Recarregue a página para editar a versão mais recente.",
  document_missing_data: "Faltam dados de alguns alunos ou responsáveis. Corrija em Alunos e responsáveis e tente de novo.",
  document_batch_not_ready: "Ainda há documentos sem PDF. Aguarde a geração ou descarte os que falharam.",
  document_batch_published: "Este lote já foi publicado.",
  request_rejected: "Só documentos com falha podem ser descartados.",
```

`AdminHome.tsx`:
- Parágrafo das colunas do CSV passa a ser: `Colunas: <code>codigo_aluno, primeiro_nome, turma, responsavel_nome, responsavel_telefone</code>. Opcionais (para documentos): <code>nome_completo, data_nascimento, responsavel_nome_completo, responsavel_cpf</code>. Um aluno com dois responsáveis ocupa duas linhas.`
- Dentro do bloco `(me.role === "admin" || me.role === "secretaria")`, antes de `<MenuAdmin />`: `<nav><Link to="/admin/alunos">Alunos e responsáveis</Link></nav>` (importe `Link` de `react-router`).

`App.tsx`: `<Route path="/admin/alunos" element={<StudentsAdmin />} />`.

Run do Step 1 → PASS; `pnpm --filter @app-lanche/web test` → PASS (testes antigos do admin incluídos).

- [ ] **Step 3: Commitar**

Run: `pnpm typecheck && pnpm lint` → PASS.

```bash
git add apps/web/src/areas/admin apps/web/src/ui apps/web/src/app/App.tsx
git commit -m "feat(web): list and edit students and guardians with the CPF masked"
```

---

### Task 12: Web — modelos (tabela, exemplos, editor com variáveis e prévia)

**Files:**
- Modify: `apps/web/src/app/api.ts`, `apps/web/src/app/api.test.ts`
- Create: `apps/web/src/areas/admin/documentLabels.ts`, `apps/web/src/areas/admin/DocumentsAdmin.tsx`, `apps/web/src/areas/admin/TemplateEditor.tsx`, `apps/web/src/areas/admin/documentsAdmin.test.tsx`
- Modify: `apps/web/src/areas/admin/AdminHome.tsx`, `apps/web/src/app/App.tsx`

**Interfaces:**
- Consumes: contratos da Task 1; rotas das Tasks 6–7; `useStaffErrors`, `formatInstantDate` (Task 11).
- Produces: `ApiError.details?: Record<string, unknown>`; `apiFetchBlob(path, init?): Promise<Blob>`; `CATEGORY_LABELS`, `BATCH_STATUS_LABELS`, `DOCUMENT_STATUS_LABELS`; rotas `/admin/documentos`, `/admin/documentos/modelos/novo`, `/admin/documentos/modelos/:id`.

- [ ] **Step 1: Cliente de API (teste falha)**

`api.test.ts` — acrescente:

```ts
  it("exposes the error details", async () => {
    mockFetch(422, { error: { code: "document_missing_data", message: "x", details: { missing: [] } } });
    await expect(apiFetch("/api/v1/x", z.object({}))).rejects.toMatchObject({ status: 422, code: "document_missing_data", details: { missing: [] } });
  });

  it("returns a binary body as a Blob", async () => {
    mockResponse(new Response(new Blob(["%PDF-1.7"]), { status: 200, headers: { "content-type": "application/pdf" } }));
    const blob = await apiFetchBlob("/api/v1/x", { method: "POST", body: {} });
    expect(await blob.text()).toBe("%PDF-1.7");
  });
```

(importe `apiFetchBlob`.)

`api.ts`:

```ts
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(code);
  }
}

type Init = { method?: string; body?: unknown; idempotencyKey?: string };

async function send(path: string, init: Init): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.idempotencyKey) headers["idempotency-key"] = init.idempotencyKey;
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? "GET",
      credentials: "same-origin",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new ApiError(0, "network_error");
  }
  if (!res.ok) {
    const parsed = ErrorResponse.safeParse(await res.json().catch(() => null));
    throw parsed.success
      ? new ApiError(res.status, parsed.data.error.code, parsed.data.error.details)
      : new ApiError(res.status, "internal_error");
  }
  return res;
}

export async function apiFetch<T>(path: string, schema: z.ZodType<T>, init: Init = {}): Promise<T> {
  const res = await send(path, init);
  // 204 has no body: validate undefined against the schema (z.undefined() passes, object schemas fail).
  const json: unknown = res.status === 204 ? undefined : await res.json().catch(() => null);
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ApiError(res.status, "invalid_response");
  return parsed.data;
}

/** Corpo binário (PDF da prévia). */
export async function apiFetchBlob(path: string, init: Init = {}): Promise<Blob> {
  return (await send(path, init)).blob();
}
```

Run: `pnpm --filter @app-lanche/web exec vitest run src/app/api.test.ts` → PASS.

- [ ] **Step 2: Testes das telas (falham)**

`apps/web/src/areas/admin/documentsAdmin.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentsAdmin } from "./DocumentsAdmin";
import { TemplateEditor } from "./TemplateEditor";

type Reply = { status: number; body?: unknown; raw?: () => Response };

function mockApi(replies: Record<string, Reply>) {
  const fn = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url, init) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    const reply = replies[key];
    if (!reply) throw new Error(`unexpected request ${key}`);
    if (reply.raw) return reply.raw();
    return reply.status === 204 ? new Response(null, { status: 204 }) : new Response(JSON.stringify(reply.body), { status: reply.status });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function callOf(fn: ReturnType<typeof mockApi>, key: string) {
  const call = fn.mock.calls.find((c) => `${c[1]?.method ?? "GET"} ${c[0]}` === key);
  return call && { headers: call[1]!.headers as Record<string, string>, body: JSON.parse((call[1]!.body as string | undefined) ?? "null") as unknown };
}

const U = (n: number) => `0193a000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const [T1, T2, T3, B1] = [U(1), U(2), U(3), U(4)];
const SUMMARY = { id: T1, groupId: T1, version: 2, name: "Autorização de passeio", category: "autorizacao", updatedAt: "2026-11-18T13:00:00.000Z" };
const TEMPLATE = { ...SUMMARY, bodyMd: "# Oi\n\n{{aluno.primeiro_nome}}", fields: [], archived: false, latest: true };
const COUNTS = { total: 3, pending: 0, rendering: 0, rendered: 3, failed: 0, discarded: 0 };
const BATCH = { id: B1, templateId: T1, templateName: "Autorização de passeio", templateVersion: 2, status: "published", createdAt: "2026-11-18T13:00:00.000Z", publishedAt: "2026-11-18T13:10:00.000Z", counts: COUNTS, recipients: 3, viewers: 2 };
const LIST: Record<string, Reply> = {
  "GET /api/admin/v1/document-templates": { status: 200, body: { templates: [SUMMARY] } },
  "GET /api/admin/v1/document-templates/examples": { status: 200, body: { examples: [{ key: "declaracao-matricula", name: "Declaração de matrícula", category: "declaracao" }] } },
  "GET /api/admin/v1/document-batches": { status: 200, body: { batches: [BATCH] } },
};

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin/documentos" element={<DocumentsAdmin />} />
        <Route path="/admin/documentos/modelos/novo" element={<TemplateEditor />} />
        <Route path="/admin/documentos/modelos/:id" element={<TemplateEditor />} />
        <Route path="/admin/login" element={<p>login</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("documents admin", () => {
  it("lists templates, examples and batches with how many guardians opened", async () => {
    mockApi(LIST);
    renderAt("/admin/documentos");
    await screen.findByText("Autorização de passeio");
    expect(screen.getByText("Autorização")).toBeTruthy();
    expect(screen.getByText("Declaração de matrícula")).toBeTruthy();
    expect(screen.getByText("Autorização de passeio (versão 2)")).toBeTruthy();
    expect(screen.getByText("Publicado")).toBeTruthy();
    expect(screen.getByText("2 de 3")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Gerar" }).getAttribute("href")).toBe(`/admin/documentos/gerar/${T1}`);
  });

  it("copies an example and opens it in the editor", async () => {
    const fn = mockApi({
      ...LIST,
      "POST /api/admin/v1/document-templates/from-example": { status: 200, body: { ...TEMPLATE, id: T2, groupId: T2, version: 1, name: "Declaração de matrícula" } },
      [`GET /api/admin/v1/document-templates/${T2}`]: { status: 200, body: { ...TEMPLATE, id: T2, groupId: T2, version: 1, name: "Declaração de matrícula" } },
    });
    renderAt("/admin/documentos");
    fireEvent.click(await screen.findByRole("button", { name: "Usar exemplo Declaração de matrícula" }));
    await waitFor(() => expect((screen.getByLabelText("Nome") as HTMLInputElement).value).toBe("Declaração de matrícula"));
    const call = callOf(fn, "POST /api/admin/v1/document-templates/from-example")!;
    expect(call.body).toEqual({ exampleKey: "declaracao-matricula" });
    expect(call.headers["idempotency-key"]).toBeTruthy();
  });

  it("archives a template after confirmation", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const fn = mockApi({ ...LIST, [`POST /api/admin/v1/document-templates/${T1}/archive`]: { status: 204 } });
    renderAt("/admin/documentos");
    fireEvent.click(await screen.findByRole("button", { name: "Arquivar Autorização de passeio" }));
    await waitFor(() => expect(callOf(fn, `POST /api/admin/v1/document-templates/${T1}/archive`)).toBeTruthy());
  });
});

describe("template editor", () => {
  it("inserts variables at the cursor, declares a field and saves a new template", async () => {
    const fn = mockApi({
      "POST /api/admin/v1/document-templates": { status: 200, body: { ...TEMPLATE, id: T2, groupId: T2, version: 1 } },
      [`GET /api/admin/v1/document-templates/${T2}`]: { status: 200, body: { ...TEMPLATE, id: T2, groupId: T2, version: 1 } },
    });
    renderAt("/admin/documentos/modelos/novo");
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Passeio" } });
    fireEvent.change(screen.getByLabelText("Categoria"), { target: { value: "autorizacao" } });
    const body = screen.getByLabelText("Texto do modelo") as HTMLTextAreaElement;
    fireEvent.change(body, { target: { value: "Autorizo " } });
    body.setSelectionRange(9, 9);
    fireEvent.click(screen.getByRole("button", { name: "Nome completo do aluno" }));
    expect(body.value).toBe("Autorizo {{aluno.nome_completo}}");
    fireEvent.click(screen.getByRole("button", { name: "Adicionar campo" }));
    fireEvent.change(screen.getByLabelText("Chave"), { target: { value: "destino" } });
    fireEvent.change(screen.getByLabelText("Rótulo"), { target: { value: "Destino" } });
    body.setSelectionRange(body.value.length, body.value.length);
    fireEvent.click(screen.getByRole("button", { name: "Campo: Destino" }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await screen.findByText("Versão 1 salva.");
    expect(callOf(fn, "POST /api/admin/v1/document-templates")!.body).toEqual({
      name: "Passeio",
      category: "autorizacao",
      bodyMd: "Autorizo {{aluno.nome_completo}}{{campo.destino}}",
      fields: [{ key: "destino", label: "Destino", type: "texto" }],
    });
  });

  it("marks the invalid variables the server reports", async () => {
    mockApi({
      "POST /api/admin/v1/document-templates": {
        status: 422,
        body: { error: { code: "document_template_invalid", message: "x", details: { variables: ["{{aluno.apelido}}"] } } },
      },
    });
    renderAt("/admin/documentos/modelos/novo");
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "X" } });
    fireEvent.change(screen.getByLabelText("Texto do modelo"), { target: { value: "{{aluno.apelido}}" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await screen.findByText("O modelo usa variáveis que não existem. Corrija as marcadas abaixo.");
    expect(screen.getByText("{{aluno.apelido}}")).toBeTruthy();
  });

  it("previews the PDF of the draft", async () => {
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:preview") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const fn = mockApi({
      [`GET /api/admin/v1/document-templates/${T1}`]: { status: 200, body: TEMPLATE },
      "POST /api/admin/v1/document-templates/preview": { status: 200, raw: () => new Response(new Blob(["%PDF-1.7"]), { status: 200 }) },
    });
    renderAt(`/admin/documentos/modelos/${T1}`);
    await waitFor(() => expect((screen.getByLabelText("Nome") as HTMLInputElement).value).toBe("Autorização de passeio"));
    fireEvent.click(screen.getByRole("button", { name: "Ver prévia" }));
    const frame = await screen.findByTitle("Prévia do PDF");
    expect(frame.getAttribute("src")).toBe("blob:preview");
    expect(callOf(fn, "POST /api/admin/v1/document-templates/preview")!.body).toMatchObject({ name: "Autorização de passeio", bodyMd: TEMPLATE.bodyMd });
  });

  it("saves an edit as a new version and explains a stale one", async () => {
    const fn = mockApi({
      [`GET /api/admin/v1/document-templates/${T1}`]: { status: 200, body: TEMPLATE },
      [`POST /api/admin/v1/document-templates/${T1}/versions`]: { status: 200, body: { ...TEMPLATE, id: T3, version: 3 } },
      [`GET /api/admin/v1/document-templates/${T3}`]: { status: 200, body: { ...TEMPLATE, id: T3, version: 3 } },
    });
    renderAt(`/admin/documentos/modelos/${T1}`);
    await waitFor(() => expect((screen.getByLabelText("Nome") as HTMLInputElement).value).toBe("Autorização de passeio"));
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Passeio ao zoo" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await screen.findByText("Versão 3 salva.");
    expect(callOf(fn, `POST /api/admin/v1/document-templates/${T1}/versions`)!.body).toMatchObject({ name: "Passeio ao zoo" });

    cleanup();
    mockApi({
      [`GET /api/admin/v1/document-templates/${T1}`]: { status: 200, body: TEMPLATE },
      [`POST /api/admin/v1/document-templates/${T1}/versions`]: { status: 409, body: { error: { code: "document_template_outdated", message: "x" } } },
    });
    renderAt(`/admin/documentos/modelos/${T1}`);
    await waitFor(() => expect((screen.getByLabelText("Nome") as HTMLInputElement).value).toBe("Autorização de passeio"));
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await screen.findByText("Este modelo foi alterado por outra pessoa. Recarregue a página para editar a versão mais recente.");
  });
});
```

Run: `pnpm --filter @app-lanche/web exec vitest run src/areas/admin/documentsAdmin.test.tsx` → FAIL.

- [ ] **Step 3: Implementar**

`apps/web/src/areas/admin/documentLabels.ts`:

```ts
import type { BatchStatus, DocumentCategory, DocumentStatus } from "@app-lanche/contracts";

export const CATEGORY_LABELS: Record<DocumentCategory, string> = {
  declaracao: "Declaração",
  comunicado: "Comunicado",
  autorizacao: "Autorização",
  outro: "Outro",
};

export const BATCH_STATUS_LABELS: Record<BatchStatus, string> = {
  rendering: "Gerando PDFs",
  ready: "Pronto para publicar",
  published: "Publicado",
};

export const DOCUMENT_STATUS_LABELS: Record<DocumentStatus, string> = {
  pending: "Na fila",
  rendering: "Gerando",
  rendered: "Pronto",
  failed: "Falhou",
};
```

`apps/web/src/areas/admin/DocumentsAdmin.tsx`:

```tsx
import { BatchListResponse, Template, TemplateExampleListResponse, TemplateListResponse } from "@app-lanche/contracts";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { z } from "zod";
import { apiFetch } from "../../app/api";
import { formatInstantDate } from "../../ui/dates";
import { BATCH_STATUS_LABELS, CATEGORY_LABELS } from "./documentLabels";
import { useStaffErrors } from "./useStaffErrors";

export function DocumentsAdmin() {
  const navigate = useNavigate();
  const { error, fail } = useStaffErrors();
  const [templates, setTemplates] = useState<TemplateListResponse["templates"] | null>(null);
  const [examples, setExamples] = useState<TemplateExampleListResponse["examples"]>([]);
  const [batches, setBatches] = useState<BatchListResponse["batches"]>([]);

  const load = useCallback(async () => {
    try {
      const [t, e, b] = await Promise.all([
        apiFetch("/api/admin/v1/document-templates", TemplateListResponse),
        apiFetch("/api/admin/v1/document-templates/examples", TemplateExampleListResponse),
        apiFetch("/api/admin/v1/document-batches", BatchListResponse),
      ]);
      setTemplates(t.templates);
      setExamples(e.examples);
      setBatches(b.batches);
    } catch (err) {
      fail(err);
    }
  }, [fail]);

  useEffect(() => void load(), [load]);

  async function copyExample(exampleKey: string) {
    try {
      const t = await apiFetch("/api/admin/v1/document-templates/from-example", Template, {
        method: "POST",
        body: { exampleKey },
        idempotencyKey: crypto.randomUUID(),
      });
      navigate(`/admin/documentos/modelos/${t.id}`);
    } catch (err) {
      fail(err);
    }
  }

  async function archive(id: string, name: string) {
    if (!window.confirm(`Arquivar o modelo "${name}"? Ele deixa de aparecer para gerar documentos.`)) return;
    try {
      await apiFetch(`/api/admin/v1/document-templates/${id}/archive`, z.undefined(), { method: "POST" });
      await load();
    } catch (err) {
      fail(err);
    }
  }

  if (!templates) return <main>{error ? <p role="alert">{error}</p> : <p>Carregando…</p>}</main>;

  return (
    <main>
      <p><Link to="/admin">Voltar</Link></p>
      <h1>Documentos</h1>
      {error && <p role="alert">{error}</p>}
      <section>
        <h2>Modelos</h2>
        <p><Link to="/admin/documentos/modelos/novo">Novo modelo</Link></p>
        {templates.length === 0 ? (
          <p>Nenhum modelo ainda. Comece por um exemplo pronto.</p>
        ) : (
          <table>
            <thead>
              <tr><th>Nome</th><th>Categoria</th><th>Versão</th><th>Atualizado em</th><th>Ações</th></tr>
            </thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td>{CATEGORY_LABELS[t.category]}</td>
                  <td>{t.version}</td>
                  <td>{formatInstantDate(t.updatedAt)}</td>
                  <td>
                    <Link to={`/admin/documentos/modelos/${t.id}`}>Editar</Link>{" "}
                    <Link to={`/admin/documentos/gerar/${t.id}`}>Gerar</Link>{" "}
                    <button type="button" aria-label={`Arquivar ${t.name}`} onClick={() => void archive(t.id, t.name)}>Arquivar</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <h3>Exemplos prontos</h3>
        <ul>
          {examples.map((e) => (
            <li key={e.key}>
              <span>{e.name}</span>{" "}
              <button type="button" aria-label={`Usar exemplo ${e.name}`} onClick={() => void copyExample(e.key)}>Usar exemplo</button>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2>Lotes</h2>
        {batches.length === 0 ? (
          <p>Nenhum lote gerado.</p>
        ) : (
          <table>
            <thead>
              <tr><th>Modelo</th><th>Situação</th><th>Criado em</th><th>Documentos</th><th>Abriram</th><th></th></tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.id}>
                  <td>{b.templateName} (versão {b.templateVersion})</td>
                  <td>{BATCH_STATUS_LABELS[b.status]}</td>
                  <td>{formatInstantDate(b.createdAt)}</td>
                  <td>{b.counts.total - b.counts.discarded}</td>
                  <td>{b.status === "published" ? `${b.viewers} de ${b.recipients}` : "—"}</td>
                  <td><Link to={`/admin/documentos/lotes/${b.id}`}>Abrir</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
```

(Se o React gerar nós de texto separados em `{b.templateName} (versão {b.templateVersion})`, o `getByText` ainda casa: ele junta os nós de texto do próprio elemento.)

`apps/web/src/areas/admin/TemplateEditor.tsx`:

```tsx
import {
  DocumentCategory,
  TEMPLATE_VARIABLE_LABELS,
  TEMPLATE_VARIABLES,
  Template,
  type DocumentField,
  type TemplateInput,
} from "@app-lanche/contracts";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { ApiError, apiFetch, apiFetchBlob } from "../../app/api";
import { staffErrorMessage } from "../../ui/messages";
import { CATEGORY_LABELS } from "./documentLabels";
import { useStaffErrors } from "./useStaffErrors";

const EMPTY: TemplateInput = { name: "", category: "declaracao", bodyMd: "", fields: [] };

export function TemplateEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { error, setError, fail } = useStaffErrors();
  const [loaded, setLoaded] = useState<Template | null>(null);
  const [draft, setDraft] = useState<TemplateInput | null>(id ? null : EMPTY);
  const [invalid, setInvalid] = useState<string[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const body = useRef<HTMLTextAreaElement>(null);
  const savedVersion = (location.state as { savedVersion?: number } | null)?.savedVersion;

  useEffect(() => {
    if (!id) return;
    apiFetch(`/api/admin/v1/document-templates/${id}`, Template).then((t) => {
      setLoaded(t);
      setDraft({ name: t.name, category: t.category, bodyMd: t.bodyMd, fields: t.fields });
    }, fail);
  }, [id, fail]);

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  if (!draft) return <main>{error ? <p role="alert">{error}</p> : <p>Carregando…</p>}</main>;

  const update = (patch: Partial<TemplateInput>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const updateField = (i: number, patch: Partial<DocumentField>) =>
    update({ fields: draft.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) });

  function insert(variable: string) {
    const el = body.current;
    const text = `{{${variable}}}`;
    const start = el?.selectionStart ?? draft!.bodyMd.length;
    const end = el?.selectionEnd ?? start;
    update({ bodyMd: draft!.bodyMd.slice(0, start) + text + draft!.bodyMd.slice(end) });
  }

  function handle(err: unknown) {
    if (err instanceof ApiError && err.code === "document_template_invalid") {
      const variables = err.details?.variables;
      setInvalid(Array.isArray(variables) ? variables.map(String) : []);
      setError(staffErrorMessage(err.code));
      return;
    }
    fail(err);
  }

  async function showPreview() {
    setBusy(true);
    setError(null);
    setInvalid([]);
    try {
      const blob = await apiFetchBlob("/api/admin/v1/document-templates/preview", { method: "POST", body: draft });
      setPreview(URL.createObjectURL(blob));
    } catch (err) {
      handle(err);
    } finally {
      setBusy(false);
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setInvalid([]);
    try {
      const url = loaded ? `/api/admin/v1/document-templates/${loaded.id}/versions` : "/api/admin/v1/document-templates";
      const saved = await apiFetch(url, Template, { method: "POST", body: draft, idempotencyKey: crypto.randomUUID() });
      navigate(`/admin/documentos/modelos/${saved.id}`, { replace: true, state: { savedVersion: saved.version } });
    } catch (err) {
      handle(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <p><Link to="/admin/documentos">Voltar aos documentos</Link></p>
      <h1>{loaded ? `${loaded.name} — versão ${loaded.version}` : "Novo modelo"}</h1>
      {savedVersion !== undefined && <p role="status">Versão {savedVersion} salva.</p>}
      {loaded && !loaded.latest && <p>Esta não é a versão mais recente do modelo.</p>}
      {error && (
        <div role="alert">
          <p>{error}</p>
          {invalid.length > 0 && <ul>{invalid.map((v) => <li key={v}>{v}</li>)}</ul>}
        </div>
      )}
      <form onSubmit={save}>
        <label htmlFor="template-name">Nome</label>
        <input id="template-name" required maxLength={120} value={draft.name} onChange={(e) => update({ name: e.target.value })} />
        <label htmlFor="template-category">Categoria</label>
        <select id="template-category" value={draft.category} onChange={(e) => update({ category: DocumentCategory.parse(e.target.value) })}>
          {DocumentCategory.options.map((c) => (
            <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
          ))}
        </select>

        <fieldset>
          <legend>Variáveis (clique para inserir no texto)</legend>
          {TEMPLATE_VARIABLES.map((v) => (
            <button key={v} type="button" title={`{{${v}}}`} onClick={() => insert(v)}>{TEMPLATE_VARIABLE_LABELS[v]}</button>
          ))}
          {draft.fields.filter((f) => f.key && f.label).map((f) => (
            <button key={f.key} type="button" title={`{{campo.${f.key}}}`} onClick={() => insert(`campo.${f.key}`)}>Campo: {f.label}</button>
          ))}
        </fieldset>

        <label htmlFor="template-body">Texto do modelo</label>
        <p>Use # e ## para títulos, **negrito**, listas com - ou 1. e tabelas com |.</p>
        <textarea id="template-body" ref={body} rows={16} required value={draft.bodyMd} onChange={(e) => update({ bodyMd: e.target.value })} />

        <fieldset>
          <legend>Campos preenchidos ao gerar (até 10)</legend>
          {draft.fields.map((f, i) => (
            <div key={i}>
              <label htmlFor={`field-key-${i}`}>Chave</label>
              <input id={`field-key-${i}`} required pattern="[a-z][a-z0-9_]{0,29}" value={f.key} onChange={(e) => updateField(i, { key: e.target.value })} />
              <label htmlFor={`field-label-${i}`}>Rótulo</label>
              <input id={`field-label-${i}`} required maxLength={80} value={f.label} onChange={(e) => updateField(i, { label: e.target.value })} />
              <label htmlFor={`field-type-${i}`}>Tipo</label>
              <select id={`field-type-${i}`} value={f.type} onChange={(e) => updateField(i, { type: e.target.value === "data" ? "data" : "texto" })}>
                <option value="texto">Texto</option>
                <option value="data">Data</option>
              </select>
              <button type="button" onClick={() => update({ fields: draft.fields.filter((_, j) => j !== i) })}>Remover campo</button>
            </div>
          ))}
          {draft.fields.length < 10 && (
            <button type="button" onClick={() => update({ fields: [...draft.fields, { key: "", label: "", type: "texto" }] })}>Adicionar campo</button>
          )}
        </fieldset>

        <button type="button" disabled={busy} onClick={() => void showPreview()}>Ver prévia</button>
        <button type="submit" disabled={busy}>Salvar</button>
      </form>
      {preview && <iframe title="Prévia do PDF" src={preview} width="100%" height="600" />}
    </main>
  );
}
```

(`fail` vem de `useCallback` e é estável; o efeito de carga só roda quando `id` muda. O teste "inserts variables…" usa a ordem dos campos `name, category, bodyMd, fields` do estado — mantenha-a.)

`AdminHome.tsx`: o `<nav>` da Task 11 ganha ` · <Link to="/admin/documentos">Documentos</Link>`.

`App.tsx`:

```tsx
      <Route path="/admin/documentos" element={<DocumentsAdmin />} />
      <Route path="/admin/documentos/modelos/novo" element={<TemplateEditor />} />
      <Route path="/admin/documentos/modelos/:id" element={<TemplateEditor />} />
```

Run do Step 2 → PASS.

- [ ] **Step 4: Rodar e commitar**

Run: `pnpm --filter @app-lanche/web test && pnpm typecheck && pnpm lint` → PASS.

```bash
git add apps/web/src/app apps/web/src/areas/admin
git commit -m "feat(web): manage document templates with clickable variables and PDF preview"
```

---

### Task 13: Web — gerar lote (seleção de alunos) e tela do lote

**Files:**
- Create: `apps/web/src/areas/admin/GenerateBatch.tsx`, `apps/web/src/areas/admin/BatchPage.tsx`, `apps/web/src/areas/admin/batches.test.tsx`
- Modify: `apps/web/src/app/App.tsx`

**Interfaces:**
- Consumes: `Template`, `BatchSummary`, `BatchDetail`, `RenderProgress`, `MissingDataDetails`, `DocumentDownloadResponse`, `TEMPLATE_VARIABLE_LABELS` (Task 1); `StudentFilters`, `filterStudents`, `studentLabel`, `useStaffErrors`, `formatInstantDate`, `formatIsoDate` (Task 11); rótulos (Task 12); rotas das Tasks 7–9.
- Produces: rotas `/admin/documentos/gerar/:templateId` e `/admin/documentos/lotes/:id`; `RENDER_IDLE_MS = 2000`.

- [ ] **Step 1: Testes (falham)**

`apps/web/src/areas/admin/batches.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BatchPage } from "./BatchPage";
import { GenerateBatch } from "./GenerateBatch";

type Reply = { status: number; body?: unknown };

/** Respostas por "MÉTODO url"; uma lista é consumida em ordem e a última se repete. */
function mockApi(replies: Record<string, Reply | Reply[]>) {
  const fn = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url, init) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    const entry = replies[key];
    if (!entry) throw new Error(`unexpected request ${key}`);
    const reply = Array.isArray(entry) ? (entry.length > 1 ? entry.shift()! : entry[0]!) : entry;
    return reply.status === 204 ? new Response(null, { status: 204 }) : new Response(JSON.stringify(reply.body), { status: reply.status });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function callOf(fn: ReturnType<typeof mockApi>, key: string) {
  const call = fn.mock.calls.find((c) => `${c[1]?.method ?? "GET"} ${c[0]}` === key);
  return call && { headers: call[1]!.headers as Record<string, string>, body: JSON.parse((call[1]!.body as string | undefined) ?? "null") as unknown };
}

const U = (n: number) => `0193a000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const [T1, B1, C1, C2, S1, S2, G1, D1, D2] = [U(1), U(2), U(3), U(4), U(5), U(6), U(7), U(8), U(9)];
const TEMPLATE = {
  id: T1, groupId: T1, version: 1, name: "Autorização de passeio", category: "autorizacao", updatedAt: "2026-11-18T13:00:00.000Z",
  bodyMd: "x", archived: false, latest: true,
  fields: [{ key: "destino", label: "Destino", type: "texto" }, { key: "data_passeio", label: "Data do passeio", type: "data" }],
};
const STUDENTS = {
  students: [
    { id: S1, externalCode: "A1", firstName: "Léo", fullName: "Leonardo Souza", birthDate: "2021-03-15", classId: C1, className: "Infantil 3A",
      guardians: [{ id: G1, firstName: "Ana", fullName: "Ana Paula Souza", phone: "+5511999990001", cpfMasked: null }] },
    { id: S2, externalCode: "B1", firstName: "Caio", fullName: null, birthDate: null, classId: C2, className: "Infantil 4B", guardians: [] },
  ],
};
const CLASSES = { classes: [{ id: C1, name: "Infantil 3A" }, { id: C2, name: "Infantil 4B" }] };
const GENERATE: Record<string, Reply> = {
  [`GET /api/admin/v1/document-templates/${T1}`]: { status: 200, body: TEMPLATE },
  "GET /api/admin/v1/students": { status: 200, body: STUDENTS },
  "GET /api/admin/v1/classes": { status: 200, body: CLASSES },
};
const counts = (c: Partial<Record<"total" | "pending" | "rendering" | "rendered" | "failed" | "discarded", number>>) => ({
  total: 2, pending: 0, rendering: 0, rendered: 0, failed: 0, discarded: 0, ...c,
});
const summary = (status: string, c: ReturnType<typeof counts>) => ({
  id: B1, templateId: T1, templateName: "Autorização de passeio", templateVersion: 1, status,
  createdAt: "2026-11-18T13:00:00.000Z", publishedAt: status === "published" ? "2026-11-18T13:10:00.000Z" : null,
  counts: c, recipients: 1, viewers: 0,
});
const doc = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, studentId: S1, studentFirstName: id === D1 ? "Léo" : "Bia", className: "Infantil 3A", guardianId: null, guardianFirstName: null,
  status, discarded: false, viewed: false, ...extra,
});
const detail = (status: string, c: ReturnType<typeof counts>, docs: unknown[]) => ({ ...summary(status, c), issuedOn: "2026-11-18", fieldValues: {}, documents: docs });

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin/documentos/gerar/:templateId" element={<GenerateBatch />} />
        <Route path="/admin/documentos/lotes/:id" element={<BatchPage />} />
        <Route path="/admin/login" element={<p>login</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("generate batch", () => {
  it("marks a class, fills the batch fields and creates the batch", async () => {
    const fn = mockApi({
      ...GENERATE,
      "POST /api/admin/v1/document-batches": { status: 200, body: summary("rendering", counts({ pending: 1, total: 1 })) },
      [`GET /api/admin/v1/document-batches/${B1}`]: { status: 200, body: detail("ready", counts({ total: 1, rendered: 1 }), [doc(D1, "rendered")]) },
      [`POST /api/admin/v1/document-batches/${B1}/render`]: { status: 200, body: { status: "ready", counts: counts({ total: 1, rendered: 1 }) } },
    });
    renderAt(`/admin/documentos/gerar/${T1}`);
    await screen.findByLabelText("Leonardo Souza — Infantil 3A");
    fireEvent.change(screen.getByLabelText("Turma"), { target: { value: C1 } });
    fireEvent.click(screen.getByRole("button", { name: "Marcar turma" }));
    expect((screen.getByLabelText("Leonardo Souza — Infantil 3A") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("1 aluno(s) marcado(s)")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Destino"), { target: { value: "Zoológico" } });
    fireEvent.change(screen.getByLabelText("Data do passeio"), { target: { value: "2026-12-05" } });
    fireEvent.click(screen.getByRole("button", { name: "Gerar documentos" }));
    await screen.findByText("Autorização de passeio — versão 1");
    const call = callOf(fn, "POST /api/admin/v1/document-batches")!;
    expect(call.body).toEqual({ templateId: T1, studentIds: [S1], fieldValues: { destino: "Zoológico", data_passeio: "2026-12-05" } });
    expect(call.headers["idempotency-key"]).toBeTruthy();
  });

  it("lists who lacks data, by name and variable label", async () => {
    mockApi({
      ...GENERATE,
      "POST /api/admin/v1/document-batches": {
        status: 422,
        body: {
          error: {
            code: "document_missing_data",
            message: "x",
            details: { missing: [{ studentId: S2, guardianId: null, variables: ["aluno.data_nascimento"] }, { studentId: S1, guardianId: G1, variables: ["responsavel.cpf"] }] },
          },
        },
      },
    });
    renderAt(`/admin/documentos/gerar/${T1}`);
    fireEvent.click(await screen.findByRole("button", { name: "Marcar todos" }));
    expect(screen.getByText("2 aluno(s) marcado(s)")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Destino"), { target: { value: "Zoo" } });
    fireEvent.change(screen.getByLabelText("Data do passeio"), { target: { value: "2026-12-05" } });
    fireEvent.click(screen.getByRole("button", { name: "Gerar documentos" }));
    await screen.findByText("Caio: Data de nascimento do aluno");
    expect(screen.getByText("Leonardo Souza (responsável Ana): CPF do responsável")).toBeTruthy();
  });
});

describe("batch page", () => {
  it("renders until ready, then publishes after confirmation", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const fn = mockApi({
      [`GET /api/admin/v1/document-batches/${B1}`]: [
        { status: 200, body: detail("rendering", counts({ pending: 2 }), [doc(D1, "pending"), doc(D2, "pending")]) },
        { status: 200, body: detail("ready", counts({ rendered: 2 }), [doc(D1, "rendered"), doc(D2, "rendered")]) },
        { status: 200, body: detail("published", counts({ rendered: 2 }), [doc(D1, "rendered"), doc(D2, "rendered")]) },
      ],
      [`POST /api/admin/v1/document-batches/${B1}/render`]: [
        { status: 200, body: { status: "rendering", counts: counts({ pending: 1, rendered: 1 }) } },
        { status: 200, body: { status: "ready", counts: counts({ rendered: 2 }) } },
      ],
      [`POST /api/admin/v1/document-batches/${B1}/publish`]: { status: 200, body: summary("published", counts({ rendered: 2 })) },
    });
    renderAt(`/admin/documentos/lotes/${B1}`);
    const publish = await screen.findByRole("button", { name: "Publicar e avisar os responsáveis" });
    await waitFor(() => expect((publish as HTMLButtonElement).disabled).toBe(false));
    expect(fn.mock.calls.filter((c) => c[0] === `/api/admin/v1/document-batches/${B1}/render`)).toHaveLength(2);
    fireEvent.click(publish);
    await screen.findByText("Lote publicado. Os responsáveis serão avisados pelo WhatsApp.");
    expect(callOf(fn, `POST /api/admin/v1/document-batches/${B1}/publish`)!.headers["idempotency-key"]).toBeTruthy();
  });

  it("downloads a PDF for printing and discards a failed document", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const fn = mockApi({
      [`GET /api/admin/v1/document-batches/${B1}`]: { status: 200, body: detail("ready", counts({ rendered: 1, failed: 1 }), [doc(D1, "rendered"), doc(D2, "failed")]) },
      [`POST /api/admin/v1/documents/${D1}/download`]: { status: 200, body: { url: "/api/v1/files?t=abc", expiresAt: "2026-11-18T13:05:00.000Z" } },
      [`POST /api/admin/v1/documents/${D2}/discard`]: { status: 204 },
    });
    renderAt(`/admin/documentos/lotes/${B1}`);
    expect(((await screen.findByRole("button", { name: "Publicar e avisar os responsáveis" })) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Baixar PDF de Léo" }));
    await waitFor(() => expect(open).toHaveBeenCalledWith("/api/v1/files?t=abc", "_blank", "noopener"));
    fireEvent.click(screen.getByRole("button", { name: "Descartar documento de Bia" }));
    await waitFor(() => expect(callOf(fn, `POST /api/admin/v1/documents/${D2}/discard`)).toBeTruthy());
  });
});
```

Run: `pnpm --filter @app-lanche/web exec vitest run src/areas/admin/batches.test.tsx` → FAIL.

- [ ] **Step 2: Gerar lote**

`apps/web/src/areas/admin/GenerateBatch.tsx`:

```tsx
import {
  BatchSummary,
  ClassListResponse,
  MissingDataDetails,
  StudentListResponse,
  TEMPLATE_VARIABLE_LABELS,
  Template,
  type TemplateVariable,
} from "@app-lanche/contracts";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ApiError, apiFetch } from "../../app/api";
import { staffErrorMessage } from "../../ui/messages";
import { StudentFilters } from "./StudentsAdmin";
import { filterStudents, studentLabel, type ClassRow, type StudentRow } from "./studentFilter";
import { useStaffErrors } from "./useStaffErrors";

const label = (v: string) => TEMPLATE_VARIABLE_LABELS[v as TemplateVariable] ?? v;

export function GenerateBatch() {
  const { templateId } = useParams();
  const navigate = useNavigate();
  const { error, setError, fail } = useStaffErrors();
  const [template, setTemplate] = useState<Template | null>(null);
  const [students, setStudents] = useState<StudentRow[]>([]);
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [classId, setClassId] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [values, setValues] = useState<Record<string, string>>({});
  const [missing, setMissing] = useState<MissingDataDetails["missing"]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([
      apiFetch(`/api/admin/v1/document-templates/${templateId}`, Template),
      apiFetch("/api/admin/v1/students", StudentListResponse),
      apiFetch("/api/admin/v1/classes", ClassListResponse),
    ]).then(([t, s, c]) => {
      setTemplate(t);
      setStudents(s.students);
      setClasses(c.classes);
    }, fail);
  }, [templateId, fail]);

  if (!template) return <main>{error ? <p role="alert">{error}</p> : <p>Carregando…</p>}</main>;

  const visible = filterStudents(students, { classId, query });
  const mark = (ids: string[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  const nameOf = (id: string) => {
    const s = students.find((x) => x.id === id);
    return s ? studentLabel(s) : id;
  };
  const guardianOf = (id: string) => students.flatMap((s) => s.guardians).find((g) => g.id === id)?.firstName ?? id;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMissing([]);
    try {
      const batch = await apiFetch("/api/admin/v1/document-batches", BatchSummary, {
        method: "POST",
        body: { templateId: template!.id, studentIds: [...selected], fieldValues: values },
        idempotencyKey: crypto.randomUUID(),
      });
      navigate(`/admin/documentos/lotes/${batch.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === "document_missing_data") {
        setMissing(MissingDataDetails.safeParse(err.details).data?.missing ?? []);
        setError(staffErrorMessage(err.code));
      } else {
        fail(err);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <p><Link to="/admin/documentos">Voltar aos documentos</Link></p>
      <h1>Gerar: {template.name}</h1>
      {error && (
        <div role="alert">
          <p>{error}</p>
          {missing.length > 0 && (
            <ul>
              {missing.map((m) => (
                <li key={`${m.studentId}-${m.guardianId}`}>
                  {nameOf(m.studentId)}
                  {m.guardianId ? ` (responsável ${guardianOf(m.guardianId)})` : ""}: {m.variables.map(label).join(", ")}
                </li>
              ))}
            </ul>
          )}
          {missing.length > 0 && <p><Link to="/admin/alunos">Abrir Alunos e responsáveis</Link></p>}
        </div>
      )}
      <form onSubmit={submit}>
        <section>
          <h2>Alunos</h2>
          <StudentFilters classes={classes} classId={classId} query={query} onClass={setClassId} onQuery={setQuery} />
          <button type="button" disabled={classId === ""} onClick={() => mark(students.filter((s) => s.classId === classId).map((s) => s.id), true)}>Marcar turma</button>
          <button type="button" onClick={() => mark(students.map((s) => s.id), true)}>Marcar todos</button>
          <button type="button" onClick={() => setSelected(new Set())}>Desmarcar todos</button>
          <p>{selected.size} aluno(s) marcado(s)</p>
          <ul>
            {visible.map((s) => (
              <li key={s.id}>
                <input id={`pick-${s.id}`} type="checkbox" checked={selected.has(s.id)} onChange={(e) => mark([s.id], e.target.checked)} />
                <label htmlFor={`pick-${s.id}`}>{studentLabel(s)} — {s.className}</label>
              </li>
            ))}
          </ul>
        </section>
        {template.fields.length > 0 && (
          <section>
            <h2>Campos do lote</h2>
            {template.fields.map((f) => (
              <div key={f.key}>
                <label htmlFor={`value-${f.key}`}>{f.label}</label>
                <input
                  id={`value-${f.key}`}
                  type={f.type === "data" ? "date" : "text"}
                  required
                  maxLength={200}
                  value={values[f.key] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                />
              </div>
            ))}
          </section>
        )}
        <button type="submit" disabled={busy || selected.size === 0}>Gerar documentos</button>
      </form>
    </main>
  );
}
```

(O texto de cada `label` de aluno junta nós de texto num só elemento, então `getByLabelText("Leonardo Souza — Infantil 3A")` casa.)

- [ ] **Step 3: Tela do lote**

`apps/web/src/areas/admin/BatchPage.tsx`:

```tsx
import { BatchDetail, BatchSummary, DocumentDownloadResponse, RenderProgress } from "@app-lanche/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { z } from "zod";
import { apiFetch } from "../../app/api";
import { formatInstantDate, formatIsoDate } from "../../ui/dates";
import { BATCH_STATUS_LABELS, DOCUMENT_STATUS_LABELS } from "./documentLabels";
import { useStaffErrors } from "./useStaffErrors";

/** Espera quando outra aba segura os arrendamentos restantes. */
export const RENDER_IDLE_MS = 2000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function BatchPage() {
  const { id } = useParams();
  const { error, setError, fail } = useStaffErrors();
  const [batch, setBatch] = useState<BatchDetail | null>(null);
  const [rendering, setRendering] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const b = await apiFetch(`/api/admin/v1/document-batches/${id}`, BatchDetail);
      if (alive.current) setBatch(b);
      return b;
    } catch (err) {
      fail(err);
      return null;
    }
  }, [id, fail]);

  // Spec 8.3: a tela chama render em sequência; fechar a aba pausa, reabrir continua.
  const renderAll = useCallback(async () => {
    setRendering(true);
    try {
      for (;;) {
        const p = await apiFetch(`/api/admin/v1/document-batches/${id}/render`, RenderProgress, { method: "POST" });
        if (!alive.current) return;
        setBatch((b) => (b ? { ...b, status: p.status, counts: p.counts } : b));
        if (p.status !== "rendering") break;
        if (p.counts.pending === 0) await sleep(RENDER_IDLE_MS);
      }
    } catch (err) {
      fail(err);
    } finally {
      if (alive.current) {
        setRendering(false);
        await load();
      }
    }
  }, [id, fail, load]);

  useEffect(() => {
    void load().then((b) => {
      if (b?.status === "rendering") void renderAll();
    });
  }, [load, renderAll]);

  async function download(documentId: string) {
    setError(null);
    try {
      const r = await apiFetch(`/api/admin/v1/documents/${documentId}/download`, DocumentDownloadResponse, { method: "POST" });
      window.open(r.url, "_blank", "noopener");
    } catch (err) {
      fail(err);
    }
  }

  async function discard(documentId: string) {
    if (!window.confirm("Descartar este documento? Ele não será publicado.")) return;
    setError(null);
    try {
      await apiFetch(`/api/admin/v1/documents/${documentId}/discard`, z.undefined(), { method: "POST" });
      await load();
    } catch (err) {
      fail(err);
    }
  }

  async function publish() {
    if (!batch || !window.confirm(`Publicar e avisar ${batch.recipients} responsável(is) pelo WhatsApp?`)) return;
    setError(null);
    try {
      await apiFetch(`/api/admin/v1/document-batches/${id}/publish`, BatchSummary, { method: "POST", idempotencyKey: crypto.randomUUID() });
      await load();
      setStatus("Lote publicado. Os responsáveis serão avisados pelo WhatsApp.");
    } catch (err) {
      fail(err);
    }
  }

  if (!batch) return <main>{error ? <p role="alert">{error}</p> : <p>Carregando…</p>}</main>;
  const c = batch.counts;
  const canPublish = batch.status === "ready" && c.failed === 0 && c.rendered > 0;

  return (
    <main>
      <p><Link to="/admin/documentos">Voltar aos documentos</Link></p>
      <h1>{batch.templateName} — versão {batch.templateVersion}</h1>
      <p>
        Emitido em {formatIsoDate(batch.issuedOn)} · {BATCH_STATUS_LABELS[batch.status]} · {c.rendered} de {c.total - c.discarded} PDFs prontos
        {c.failed > 0 ? ` · ${c.failed} com falha` : ""}
      </p>
      {rendering && <p role="status">Gerando PDFs… Mantenha esta página aberta.</p>}
      {status && <p role="status">{status}</p>}
      {error && <p role="alert">{error}</p>}
      {batch.status === "published" ? (
        <p>
          Publicado em {formatInstantDate(batch.publishedAt!)}. Abriram: {batch.viewers} de {batch.recipients} responsáveis.
        </p>
      ) : (
        <button type="button" disabled={!canPublish} onClick={() => void publish()}>Publicar e avisar os responsáveis</button>
      )}
      <table>
        <thead>
          <tr><th>Aluno</th><th>Turma</th><th>Responsável</th><th>Situação</th><th>Ações</th></tr>
        </thead>
        <tbody>
          {batch.documents.map((d) => (
            <tr key={d.id}>
              <td>{d.studentFirstName}</td>
              <td>{d.className}</td>
              <td>{d.guardianFirstName ?? "Todos"}</td>
              <td>{d.discarded ? "Descartado" : DOCUMENT_STATUS_LABELS[d.status]}{d.viewed ? " · aberto" : ""}</td>
              <td>
                {d.status === "rendered" && (
                  <button type="button" aria-label={`Baixar PDF de ${d.studentFirstName}`} onClick={() => void download(d.id)}>Baixar PDF</button>
                )}
                {d.status === "failed" && !d.discarded && batch.status !== "published" && (
                  <button type="button" aria-label={`Descartar documento de ${d.studentFirstName}`} onClick={() => void discard(d.id)}>Descartar</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
```

`App.tsx`:

```tsx
      <Route path="/admin/documentos/gerar/:templateId" element={<GenerateBatch />} />
      <Route path="/admin/documentos/lotes/:id" element={<BatchPage />} />
```

Run do Step 1 → PASS.

- [ ] **Step 4: Rodar e commitar**

Run: `pnpm --filter @app-lanche/web test && pnpm typecheck && pnpm lint` → PASS.

```bash
git add apps/web/src/areas/admin apps/web/src/app/App.tsx
git commit -m "feat(web): pick students to generate a batch, follow its rendering and publish it"
```

---

### Task 14: Web — página "Documentos" do responsável, fechamento da fase

**Files:**
- Create: `apps/web/src/areas/guardian/DocumentsPage.tsx`, `apps/web/src/areas/guardian/documents.test.tsx`
- Modify: `apps/web/src/areas/guardian/OrderHome.tsx`, `apps/web/src/app/App.tsx`
- Modify: `docs/superpowers/specs/2026-11-16-app-lanche-design.md` (seção 14)

**Interfaces:**
- Consumes: `GuardianDocumentListResponse`, `DocumentDownloadResponse` (Task 1); rotas da Task 9; `formatInstantDate` (Task 11); `LinkLanding` já leva o escopo `documents` a `/documentos`.
- Produces: rota `/documentos` com `DocumentsPage`.

- [ ] **Step 1: Testes (falham)**

`apps/web/src/areas/guardian/documents.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentsPage } from "./DocumentsPage";

type Reply = { status: number; body: unknown };

function mockApi(replies: Record<string, Reply>) {
  const fn = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url, init) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    const reply = replies[key];
    if (!reply) throw new Error(`unexpected request ${key}`);
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const D1 = "00000000-0000-4000-8000-000000000001";
const DOCS = {
  documents: [
    { id: D1, title: "Autorização de passeio", category: "autorizacao", studentFirstName: "Léo", publishedAt: "2026-11-18T13:10:00.000Z", viewed: false },
  ],
};

function renderPage() {
  render(
    <MemoryRouter initialEntries={["/documentos"]}>
      <Routes>
        <Route path="/documentos" element={<DocumentsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("guardian documents page", () => {
  it("lists published documents and opens one by a signed URL", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const fn = mockApi({
      "GET /api/v1/documents": { status: 200, body: DOCS },
      [`POST /api/v1/documents/${D1}/download`]: { status: 200, body: { url: "https://storage.test/signed", expiresAt: "2026-11-18T13:15:00.000Z" } },
    });
    renderPage();
    await screen.findByText("Autorização de passeio");
    expect(screen.getByText("novo")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Abrir Autorização de passeio de Léo" }));
    await waitFor(() => expect(open).toHaveBeenCalledWith("https://storage.test/signed", "_blank", "noopener"));
    expect(screen.getByRole("link", { name: "Se o PDF não abriu, toque aqui" }).getAttribute("href")).toBe("https://storage.test/signed");
    expect(screen.queryByText("novo")).toBeNull();
    expect(fn.mock.calls.find((c) => c[0] === `/api/v1/documents/${D1}/download`)![1]!.method).toBe("POST");
  });

  it("explains an empty list", async () => {
    mockApi({ "GET /api/v1/documents": { status: 200, body: { documents: [] } } });
    renderPage();
    await screen.findByText("Nenhum documento publicado por enquanto.");
  });

  it("asks to open the link again when the session expired", async () => {
    mockApi({ "GET /api/v1/documents": { status: 401, body: { error: { code: "unauthenticated", message: "x" } } } });
    renderPage();
    await screen.findByText("Sua sessão expirou. Abra o link novamente.");
  });
});
```

Run: `pnpm --filter @app-lanche/web exec vitest run src/areas/guardian/documents.test.tsx` → FAIL.

- [ ] **Step 2: Implementar**

`apps/web/src/areas/guardian/DocumentsPage.tsx`:

```tsx
import { DocumentDownloadResponse, GuardianDocumentListResponse } from "@app-lanche/contracts";
import { useEffect, useState } from "react";
import { ApiError, apiFetch } from "../../app/api";
import { formatInstantDate } from "../../ui/dates";
import { errorMessage } from "../../ui/messages";

type Doc = GuardianDocumentListResponse["documents"][number];
const codeOf = (err: unknown) => (err instanceof ApiError ? err.code : "internal_error");

export function DocumentsPage() {
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<{ id: string; url: string } | null>(null);

  useEffect(() => {
    apiFetch("/api/v1/documents", GuardianDocumentListResponse).then(
      (r) => setDocs(r.documents),
      (err) => setError(errorMessage(codeOf(err))),
    );
  }, []);

  async function open(doc: Doc) {
    setError(null);
    try {
      const r = await apiFetch(`/api/v1/documents/${doc.id}/download`, DocumentDownloadResponse, { method: "POST" });
      setOpened({ id: doc.id, url: r.url });
      setDocs((ds) => ds?.map((d) => (d.id === doc.id ? { ...d, viewed: true } : d)) ?? ds);
      window.open(r.url, "_blank", "noopener");
    } catch (err) {
      setError(codeOf(err) === "not_found" ? "Documento não encontrado." : errorMessage(codeOf(err)));
    }
  }

  if (!docs) return <main>{error ? <p role="alert">{error}</p> : <p>Carregando…</p>}</main>;

  return (
    <main>
      <h1>Documentos</h1>
      {error && <p role="alert">{error}</p>}
      {docs.length === 0 ? (
        <p>Nenhum documento publicado por enquanto.</p>
      ) : (
        <ul>
          {docs.map((d) => (
            <li key={d.id}>
              <strong>{d.title}</strong> — {d.studentFirstName} · publicado em {formatInstantDate(d.publishedAt)}
              {!d.viewed && <> · <span>novo</span></>}{" "}
              <button type="button" aria-label={`Abrir ${d.title} de ${d.studentFirstName}`} onClick={() => void open(d)}>Abrir</button>
              {opened?.id === d.id && (
                <a href={opened.url} target="_blank" rel="noopener">Se o PDF não abriu, toque aqui</a>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
```

`App.tsx`: troque `<Route path="/documentos" element={<OrderHome />} />` por `<Route path="/documentos" element={<DocumentsPage />} />`.

`OrderHome.tsx`: o parágrafo do saldo passa a terminar com ` · <Link to="/carteira">Minha carteira</Link> · <Link to="/documentos">Documentos</Link>`. Rode os testes do pedido para confirmar que continuam verdes.

Run do Step 1 → PASS.

- [ ] **Step 3: Spec 14**

Na seção 14, depois do parágrafo sobre a F2, acrescente:

"F5 concluída em 2026-11-18 (plano `2026-11-18-f5-documentos.md`): campos pessoais confirmados (nascimento, nome completo e CPF do responsável) na importação CSV e na lista "Alunos e responsáveis"; modelos versionados com quatro exemplos, prévia e validação de variáveis; lotes por aluno ou por par aluno–responsável com conferência prévia; renderização na requisição com arrendamento; armazenamento GCS (URL assinada V4) ou disco local assinado por HMAC no Docker; publicação pela outbox (`document.published`) com magic link de escopo `documents` pelo n8n; página `/documentos` com registro de abertura."

e atualize a frase "Já escritos: …" para listar também `2026-11-17-f3-rotas-internas-outbox-n8n.md`, `2026-11-17-f4-kds-offline.md` e `2026-11-18-f5-documentos.md`.

- [ ] **Step 4: Verificação completa e commit**

O compose precisa estar desligado nesta máquina WSL antes dos testes de API: `pnpm app:down; docker compose down`.

Run: `pnpm typecheck && pnpm lint && pnpm test` → PASS (contracts, API com Testcontainers, web).

```bash
git add apps/web/src/areas/guardian apps/web/src/app/App.tsx docs/superpowers/specs/2026-11-16-app-lanche-design.md
git commit -m "feat(web): guardian documents page and close out phase F5"
```

---

## Verificação final da fase

- Com o compose desligado (`pnpm app:down; docker compose down` — nesta máquina WSL os testes de API com Testcontainers não passam com ele no ar): `pnpm typecheck && pnpm lint && pnpm test` passando; `pnpm --filter @app-lanche/api build` e `pnpm --filter @app-lanche/web build` passando.
- `pnpm app:up`: entrar em `/admin` com `admin@escola.local` (`pnpm app:otp`), abrir "Documentos", usar o exemplo "Autorização de passeio", gerar para a turma "Infantil 3A", ver os PDFs prontos, baixar um, publicar; `docker compose exec -T db psql -U postgres app_lanche -tAc "SELECT data::text FROM outbox_events WHERE type = 'document.published'"` mostra um evento por responsável sem CPF; os PDFs estão no volume `documents`.
- `grep -rn "getDb" apps/api/src/modules/documents apps/api/src/platform/storage.ts` não encontra nada.
- `grep -rn "cpf" apps/api/src --include=*.ts | grep -i "log\." ` não encontra nada (CPF nunca em log).
- Spec 6.3 (exemplo `document.published`), 9 (MER) e 14 atualizadas; `docs/local.md`, `docs/deploy.md` e `docs/n8n.md` com as seções de documentos.
