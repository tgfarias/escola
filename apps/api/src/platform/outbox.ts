import { OutboxEvent } from "@app-lanche/contracts";
import { uuidv7 } from "uuidv7";
import { afterCommit, type Trx } from "../db/index";

let kickHandler: (schoolId: string) => void = () => undefined;

/** O app registra aqui o disparo imediato do dispatcher (platform não importa módulos). */
export function setOutboxKickHandler(handler: (schoolId: string) => void): void {
  kickHandler = handler;
}

/** Grava o evento na mesma transação da mudança de estado que o originou. */
export async function enqueueEvent(trx: Trx, schoolId: string, event: OutboxEvent): Promise<string> {
  const parsed = OutboxEvent.parse(event);
  const id = uuidv7();
  await trx
    .insertInto("outboxEvents")
    .values({ id, schoolId, type: parsed.type, data: JSON.stringify(parsed.data) })
    .execute();
  afterCommit(trx, () => kickHandler(schoolId));
  return id;
}
