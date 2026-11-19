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
