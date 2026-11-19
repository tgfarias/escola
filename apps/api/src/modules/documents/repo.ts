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
      count(d.id)::int AS total,
      (count(d.id) FILTER (WHERE d.status = 'pending'))::int AS pending,
      (count(d.id) FILTER (WHERE d.status = 'rendering'))::int AS rendering,
      (count(d.id) FILTER (WHERE d.status = 'rendered'))::int AS rendered,
      (count(d.id) FILTER (WHERE d.status = 'failed' AND d.discarded_at IS NULL))::int AS failed,
      (count(d.id) FILTER (WHERE d.discarded_at IS NOT NULL))::int AS discarded,
      (SELECT count(DISTINCT coalesce(r.guardian_id, gs.guardian_id))
         FROM documents r
         LEFT JOIN guardian_students gs ON r.guardian_id IS NULL AND gs.student_id = r.student_id
         WHERE r.batch_id = b.id AND r.discarded_at IS NULL)::int AS recipients,
      (SELECT count(DISTINCT v.guardian_id)
         FROM document_views v JOIN documents vd ON vd.id = v.document_id
         WHERE vd.batch_id = b.id)::int AS viewers
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
