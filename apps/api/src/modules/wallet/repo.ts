import { uuidv7 } from "uuidv7";
import type { Trx } from "../../db/index";

export async function ensureWallet(trx: Trx, schoolId: string, guardianId: string): Promise<void> {
  await trx
    .insertInto("wallets")
    .values({ id: uuidv7(), schoolId, guardianId })
    .onConflict((oc) => oc.columns(["schoolId", "guardianId"]).doNothing())
    .execute();
}

export async function lockWallet(trx: Trx, guardianId: string) {
  return trx
    .selectFrom("wallets")
    .select(["id", "balanceCents"])
    .where("guardianId", "=", guardianId)
    .forUpdate()
    .executeTakeFirstOrThrow();
}

export async function insertEntry(
  trx: Trx,
  entry: {
    schoolId: string;
    walletId: string;
    kind: string;
    amountCents: number;
    sourceType: string;
    sourceId: string;
    note: string | null;
  },
): Promise<boolean> {
  const row = await trx
    .insertInto("walletEntries")
    .values({ id: uuidv7(), ...entry })
    .onConflict((oc) => oc.columns(["schoolId", "sourceType", "sourceId", "kind"]).doNothing())
    .returning("id")
    .executeTakeFirst();
  return row !== undefined;
}

export async function setBalance(trx: Trx, walletId: string, balanceCents: number): Promise<void> {
  await trx.updateTable("wallets").set({ balanceCents }).where("id", "=", walletId).execute();
}

export async function readBalance(trx: Trx, guardianId: string): Promise<number> {
  const row = await trx.selectFrom("wallets").select("balanceCents").where("guardianId", "=", guardianId).executeTakeFirst();
  return row?.balanceCents ?? 0;
}

export async function listEntries(trx: Trx, guardianId: string, limit: number) {
  return trx
    .selectFrom("walletEntries")
    .innerJoin("wallets", "wallets.id", "walletEntries.walletId")
    .select(["walletEntries.id", "walletEntries.kind", "walletEntries.amountCents", "walletEntries.createdAt"])
    .where("wallets.guardianId", "=", guardianId)
    .orderBy("walletEntries.createdAt", "desc")
    .orderBy("walletEntries.id", "desc")
    .limit(limit)
    .execute();
}

export async function guardianExists(trx: Trx, guardianId: string): Promise<boolean> {
  const row = await trx.selectFrom("guardians").select("id").where("id", "=", guardianId).executeTakeFirst();
  return row !== undefined;
}
