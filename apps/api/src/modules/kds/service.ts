import { PAIRING_ALPHABET, type KitchenDeviceListResponse, type PairingCodeResponse } from "@app-lanche/contracts";
import { randomInt } from "node:crypto";
import { uuidv7 } from "uuidv7";
import { withTenant } from "../../db/index";
import { audit } from "../../platform/audit";
import { DomainError } from "../../platform/errors";
import { idempotent, requestHash } from "../../platform/idempotency";
import type { SessionClaims } from "../../platform/session";
import * as auth from "../auth/service";
import * as repo from "./repo";

export function generatePairingCode(): string {
  let code = "";
  for (let i = 0; i < 8; i += 1) code += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)];
  return code;
}

export async function createPairingCode(session: SessionClaims, key: string): Promise<PairingCodeResponse> {
  const hash = requestHash({ route: "POST /api/admin/v1/kds/pairing-codes", actorId: session.sub, body: {} });
  return withTenant(session.schoolId, async (trx) => {
    const { response } = await idempotent(trx, { schoolId: session.schoolId, key, requestHash: hash }, async () => {
      const deviceId = uuidv7();
      const code = generatePairingCode();
      const expiresAt = await repo.insertPendingDevice(trx, { id: deviceId, schoolId: session.schoolId, codeHash: auth.hashToken(code) });
      await audit(trx, { schoolId: session.schoolId, actorKind: "staff", actorId: session.sub, action: "kds.pairing_code_created", detail: { device_id: deviceId } });
      return { deviceId, code, expiresAt: expiresAt.toISOString() };
    });
    return response;
  });
}

/** Troca o código por uma sessão de cozinha. Código desconhecido, vencido ou já usado: invalid_token. */
export async function pair(code: string): Promise<{ schoolId: string; deviceId: string }> {
  const codeHash = auth.hashToken(code);
  const found = await auth.resolvePairingCode(codeHash);
  if (!found) throw new DomainError("invalid_token");
  const ok = await withTenant(found.schoolId, async (trx) => {
    const consumed = await repo.consumePairingCode(trx, found.deviceId, codeHash);
    if (consumed) await audit(trx, { schoolId: found.schoolId, actorKind: "kitchen", actorId: found.deviceId, action: "kds.paired" });
    return consumed;
  });
  if (!ok) throw new DomainError("invalid_token");
  return found;
}

export async function listDevices(session: SessionClaims): Promise<KitchenDeviceListResponse> {
  const rows = await withTenant(session.schoolId, (trx) => repo.listKitchenDevices(trx));
  return {
    devices: rows.map((d) => ({
      id: d.id,
      createdAt: d.createdAt.toISOString(),
      paired: d.pairingCodeHash === null,
      revokedAt: d.revokedAt ? d.revokedAt.toISOString() : null,
    })),
  };
}

export async function revokeDevice(session: SessionClaims, deviceId: string): Promise<void> {
  await withTenant(session.schoolId, async (trx) => {
    const result = await repo.revokeKitchenDevice(trx, deviceId);
    if (result === "missing") throw new DomainError("not_found");
    if (result === "revoked") {
      await audit(trx, { schoolId: session.schoolId, actorKind: "staff", actorId: session.sub, action: "kds.device_revoked", detail: { device_id: deviceId } });
    }
  });
}
