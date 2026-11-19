import { uuidv7 } from "uuidv7";
import type { Trx } from "../../db/index";
import { config } from "../../platform/config";
import { DomainError } from "../../platform/errors";
import type { GuardianScope } from "../../platform/session";
import * as repo from "./repo";
import { generateToken, hashToken } from "./tokens";

/**
 * Cria um link reutilizável. A validade vem do banco: `order` até o corte do dia (aberto e antes do corte),
 * `documents` e `wallet` por 7 dias (spec 4.1).
 */
export async function createMagicLink(
  trx: Trx,
  input: { schoolId: string; guardianId: string; scope: GuardianScope; serviceDate?: string },
): Promise<{ url: string; expiresAt: Date }> {
  if ((input.scope === "order") !== (input.serviceDate !== undefined)) {
    throw new Error("order links need a service date and other links must not have one");
  }
  const token = generateToken();
  const expiresAt = await repo.insertMagicLink(trx, {
    id: uuidv7(),
    schoolId: input.schoolId,
    guardianId: input.guardianId,
    tokenHash: hashToken(token),
    scope: input.scope,
    serviceDate: input.serviceDate ?? null,
  });
  if (!expiresAt) throw new DomainError("cutoff_passed");
  return { url: `${config().appBaseUrl}/l#${token}`, expiresAt };
}
