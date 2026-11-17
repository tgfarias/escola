import { OutboxEvent } from "@app-lanche/contracts";
import { uuidv7 } from "uuidv7";
import type { Trx } from "../db/index";

/** Grava o evento na mesma transação da mudança de estado que o originou. */
export async function enqueueEvent(trx: Trx, schoolId: string, event: OutboxEvent): Promise<string> {
  const parsed = OutboxEvent.parse(event);
  const id = uuidv7();
  await trx
    .insertInto("outboxEvents")
    .values({ id, schoolId, type: parsed.type, data: JSON.stringify(parsed.data) })
    .execute();
  return id;
}
