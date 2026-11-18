import {
  PAIRING_ALPHABET,
  type KdsChangesResponse,
  type KdsEventsRequest,
  type KdsEventsResponse,
  type KitchenDeviceListResponse,
  type PairingCodeResponse,
} from "@app-lanche/contracts";
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

const MAX_CLOCK_AHEAD_MS = 5 * 60_000;

export async function recordEvents(schoolId: string, deviceId: string, body: KdsEventsRequest): Promise<KdsEventsResponse> {
  return withTenant(schoolId, async (trx) => {
    // A tablet clock more than 5 min ahead of the database would let its events win over every later tap.
    const latestAllowed = (await repo.dbNow(trx)).getTime() + MAX_CLOCK_AHEAD_MS;
    const inTime = body.events.filter((e) => Date.parse(e.occurredAt) <= latestAllowed);
    const orderIds = [...new Set(inTime.map((e) => e.orderId))];
    const deliverable = await repo.deliverableOrders(trx, orderIds);
    const ok = inTime.filter((e) => deliverable.has(e.orderId));
    await repo.insertEvents(trx, schoolId, deviceId, ok);
    const present = await repo.existingEventIds(trx, ok.map((e) => e.eventId));
    await repo.applyLatestState(trx, [...new Set(ok.map((e) => e.orderId))]);
    return {
      accepted: body.events.filter((e) => present.has(e.eventId)).map((e) => e.eventId),
      rejected: body.events.filter((e) => !present.has(e.eventId)).map((e) => e.eventId),
    };
  });
}

export async function changes(schoolId: string, serviceDate: string, since: string | null): Promise<KdsChangesResponse> {
  const rows = await withTenant(schoolId, (trx) => repo.changesSince(trx, serviceDate, since));
  return {
    events: rows.map((r) => ({ eventId: r.eventId, orderId: r.orderId, type: r.type, occurredAt: r.occurredAt.toISOString(), deviceId: r.deviceId })),
    cursor: rows.length > 0 ? rows[rows.length - 1]!.receivedAt : since,
  };
}
