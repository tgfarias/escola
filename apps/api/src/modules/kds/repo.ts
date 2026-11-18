import { sql } from "kysely";
import type { Trx } from "../../db/index";

/** Novo tablet aguardando pareamento; validade de 10 min pelo relógio do banco. */
export async function insertPendingDevice(trx: Trx, row: { id: string; schoolId: string; codeHash: string }): Promise<Date> {
  const { rows } = await sql<{ pairingExpiresAt: Date }>`
    INSERT INTO devices (id, school_id, kind, pairing_code_hash, pairing_expires_at)
    VALUES (${row.id}, ${row.schoolId}, 'kitchen', ${row.codeHash}, now() + interval '10 minutes')
    RETURNING pairing_expires_at`.execute(trx);
  return rows[0]!.pairingExpiresAt;
}

/** Consome o código: só uma troca vence. */
export async function consumePairingCode(trx: Trx, deviceId: string, codeHash: string): Promise<boolean> {
  const res = await sql`
    UPDATE devices SET pairing_code_hash = NULL, pairing_expires_at = NULL
    WHERE id = ${deviceId} AND kind = 'kitchen' AND pairing_code_hash = ${codeHash}
      AND pairing_expires_at > now() AND revoked_at IS NULL`.execute(trx);
  return Number(res.numAffectedRows ?? 0) === 1;
}

export async function listKitchenDevices(trx: Trx) {
  return trx
    .selectFrom("devices")
    .select(["id", "createdAt", "pairingCodeHash", "revokedAt"])
    .where("kind", "=", "kitchen")
    .orderBy("createdAt", "desc")
    .execute();
}

export async function revokeKitchenDevice(trx: Trx, deviceId: string): Promise<"revoked" | "already" | "missing"> {
  const res = await sql`UPDATE devices SET revoked_at = now() WHERE id = ${deviceId} AND kind = 'kitchen' AND revoked_at IS NULL`.execute(trx);
  if (Number(res.numAffectedRows ?? 0) === 1) return "revoked";
  const row = await trx.selectFrom("devices").select("id").where("id", "=", deviceId).where("kind", "=", "kitchen").executeTakeFirst();
  return row ? "already" : "missing";
}
