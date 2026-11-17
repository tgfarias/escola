import { sql } from "kysely";
import { getDb } from "../../db/index";

export async function resolveMagicLink(
  tokenHash: string,
): Promise<{ schoolId: string; magicLinkId: string } | undefined> {
  const { rows } = await sql<{ schoolId: string; magicLinkId: string }>`
    SELECT school_id, magic_link_id FROM resolve_magic_link(${tokenHash})`.execute(getDb());
  return rows[0];
}

export async function resolveStaffEmail(
  email: string,
): Promise<{ schoolId: string; staffUserId: string } | undefined> {
  const { rows } = await sql<{ schoolId: string; staffUserId: string }>`
    SELECT school_id, staff_user_id FROM resolve_staff_email(${email})`.execute(getDb());
  return rows[0];
}
