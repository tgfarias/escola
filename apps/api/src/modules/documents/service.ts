import {
  IsoDate,
  type BatchCounts,
  type BatchDetail,
  type BatchListResponse,
  type BatchStatus,
  type BatchSummary,
  type CreateBatchRequest,
  type DocumentCategory,
  type DocumentStatus,
  type MissingDataDetails,
  type Template,
  type TemplateExampleListResponse,
  type TemplateInput,
  type TemplateListResponse,
} from "@app-lanche/contracts";
import { uuidv7 } from "uuidv7";
import { withTenant, type Trx } from "../../db/index";
import { audit } from "../../platform/audit";
import { DomainError, isUniqueViolation } from "../../platform/errors";
import { idempotent, requestHash } from "../../platform/idempotency";
import type { SessionClaims } from "../../platform/session";
import { TEMPLATE_EXAMPLES, sampleContext } from "./examples";
import { renderDocument } from "./pdf";
import * as repo from "./repo";
import { missingVariables, placeholdersIn, templateProblems, usesGuardian, type VariableContext } from "./variables";

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
  // A primeira versão usa o id do grupo como id; as seguintes ganham id próprio.
  const id = group.version === 1 ? group.id : uuidv7();
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
