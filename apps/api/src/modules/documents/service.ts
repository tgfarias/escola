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
