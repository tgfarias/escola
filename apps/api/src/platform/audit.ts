import { uuidv7 } from "uuidv7";
import type { Trx } from "../db/index";

/** Detalhe nunca contém dado pessoal: só ids e contagens. */
export async function audit(
  trx: Trx,
  entry: {
    schoolId: string;
    actorKind: "guardian" | "staff" | "kitchen" | "system";
    actorId: string | null;
    action: string;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await trx
    .insertInto("auditLog")
    .values({
      id: uuidv7(),
      schoolId: entry.schoolId,
      actorKind: entry.actorKind,
      actorId: entry.actorId,
      action: entry.action,
      detail: JSON.stringify(entry.detail ?? {}),
    })
    .execute();
}
