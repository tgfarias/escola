import { uuidv7 } from "uuidv7";
import type { Trx } from "../../db/index";
import { config } from "../../platform/config";
import type { GuardianScope } from "../../platform/session";
import * as repo from "./repo";
import { generateToken, hashToken } from "./tokens";

export async function createMagicLink(
  trx: Trx,
  input: { schoolId: string; guardianId: string; scope: GuardianScope; serviceDate?: string; expiresAt: Date },
): Promise<{ url: string; expiresAt: Date }> {
  const token = generateToken();
  await repo.insertMagicLink(trx, {
    id: uuidv7(),
    schoolId: input.schoolId,
    guardianId: input.guardianId,
    tokenHash: hashToken(token),
    scope: input.scope,
    serviceDate: input.serviceDate ?? null,
    expiresAt: input.expiresAt,
  });
  return { url: `${config().appBaseUrl}/l#${token}`, expiresAt: input.expiresAt };
}
