import { OutboxEnvelope } from "@app-lanche/contracts";
import type { FastifyBaseLogger } from "fastify";
import { withTenant } from "../../db/index";
import { config } from "../../platform/config";
import { signInternal } from "../../platform/hmac";
import * as repo from "./repo";

export type DispatchCounts = { delivered: number; failed: number; abandoned: number };
export type DispatchResult = DispatchCounts & { schools: number };

const BATCH = 50;
const MAX_BATCHES_PER_SCHOOL = 4;
const TIMEOUT_MS = 10_000;

/** Monta o POST assinado para o n8n (spec 6.1: mesmo esquema, outro segredo). */
export function signedEventRequest(envelope: OutboxEnvelope): { url: string; headers: Record<string, string>; body: string } {
  const { n8nEventsUrl, n8nHmacSecret } = config();
  if (!n8nEventsUrl || !n8nHmacSecret) throw new Error("n8n is not configured");
  const url = new URL(n8nEventsUrl);
  const body = JSON.stringify(OutboxEnvelope.parse(envelope));
  const timestamp = new Date().toISOString();
  return {
    url: url.toString(),
    body,
    headers: {
      "content-type": "application/json",
      "x-timestamp": timestamp,
      "x-signature": signInternal(n8nHmacSecret, { method: "POST", path: url.pathname + url.search, timestamp, body }),
    },
  };
}

async function post(envelope: OutboxEnvelope): Promise<number | null> {
  const req = signedEventRequest(envelope);
  try {
    const res = await fetch(req.url, { method: "POST", headers: req.headers, body: req.body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    await res.arrayBuffer().catch(() => undefined);
    return res.status;
  } catch {
    return null;
  }
}

/** Entrega os eventos prontos de uma escola. Nunca lança por falha do n8n. */
export async function dispatchSchool(schoolId: string, log: FastifyBaseLogger): Promise<DispatchCounts> {
  const counts: DispatchCounts = { delivered: 0, failed: 0, abandoned: 0 };
  if (!config().n8nEventsUrl) return counts;
  for (let i = 0; i < MAX_BATCHES_PER_SCHOOL; i += 1) {
    const events = await withTenant(schoolId, (trx) => repo.claim(trx, BATCH));
    if (events.length === 0) break;
    for (const e of events) {
      if (e.abandon) {
        await withTenant(schoolId, (trx) => repo.abandon(trx, e.id));
        counts.abandoned += 1;
        log.warn({ event_id: e.id, event_type: e.type, school_id: schoolId }, "outbox event abandoned");
        continue;
      }
      const status = await post({
        id: e.id,
        type: e.type,
        school_id: schoolId,
        occurred_at: e.occurredAt.toISOString(),
        data: JSON.parse(e.data) as Record<string, unknown>,
      });
      if (status !== null && status >= 200 && status < 300) {
        await withTenant(schoolId, (trx) => repo.markDelivered(trx, e.id));
        counts.delivered += 1;
      } else {
        await withTenant(schoolId, (trx) => repo.markAttemptFailed(trx, e.id));
        counts.failed += 1;
        log.warn({ event_id: e.id, event_type: e.type, school_id: schoolId, status }, "outbox delivery failed");
      }
    }
    if (events.length < BATCH) break;
  }
  return counts;
}

/** Job do Cloud Scheduler: todas as escolas com eventos prontos, uma por vez. `schoolIds` restringe (testes). */
export async function dispatchOutbox(opts: { log: FastifyBaseLogger; schoolIds?: string[] }): Promise<DispatchResult> {
  const result: DispatchResult = { schools: 0, delivered: 0, failed: 0, abandoned: 0 };
  if (!config().n8nEventsUrl) return result;
  const pending = await repo.listSchoolsWithPendingEvents();
  const schools = opts.schoolIds ? pending.filter((id) => opts.schoolIds!.includes(id)) : pending;
  for (const schoolId of schools) {
    const c = await dispatchSchool(schoolId, opts.log);
    result.schools += 1;
    result.delivered += c.delivered;
    result.failed += c.failed;
    result.abandoned += c.abandoned;
  }
  return result;
}
