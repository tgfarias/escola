import { CounterRosterResponse, KdsChangesResponse, KdsEventsResponse, KdsManifestResponse, KdsPairResponse } from "@app-lanche/contracts";
import { ApiError, apiFetch } from "../../app/api";
import {
  adjustRosterBalance,
  applyRemoteEvents,
  getMeta,
  kdsDb,
  replaceRoster,
  ROSTER_FETCHED_AT,
  setMeta,
  type CounterSaleOutboxRow,
  type CounterVoidOutboxRow,
  type DeliveryOutboxRow,
} from "./db";
import { voidsReadyToSend } from "../../ui/counter";
import { chunk, localDate, shiftDate } from "./state";

const INTERVAL_MS = 15_000;
const KEEP_DAYS = 2;
const DATED_META = ["cursor:", "noService:"];
const ROSTER_META = "roster:";

export async function pair(code: string): Promise<string> {
  const res = await apiFetch("/api/kds/v1/pair", KdsPairResponse, { method: "POST", body: { code } });
  // A new pairing may be another device or school: refetch from scratch. The outbox is kept and retried;
  // events for orders of another school come back as rejected and are dropped.
  await kdsDb.transaction("rw", [kdsDb.manifest, kdsDb.orderState, kdsDb.meta, kdsDb.roster, kdsDb.counterSales], async () => {
    await kdsDb.manifest.clear();
    await kdsDb.orderState.clear();
    await kdsDb.meta.where("key").startsWith("cursor:").delete();
    await kdsDb.meta.where("key").startsWith("noService:").delete();
    await kdsDb.roster.clear();
    await kdsDb.counterSales.clear();
    await kdsDb.meta.where("key").startsWith(ROSTER_META).delete();
    await kdsDb.meta.delete("authLost");
    await kdsDb.meta.put({ key: "deviceId", value: res.deviceId });
  });
  await navigator.storage?.persist?.().catch(() => false);
  return res.deviceId;
}

export async function isPaired(): Promise<boolean> {
  return (await getMeta("deviceId")) !== null;
}

/** True after a 401, or a 403 for a non-kitchen session: the UI asks for a new pairing code and keeps the outbox. */
export async function isAuthLost(): Promise<boolean> {
  return (await getMeta("authLost")) !== null;
}

/** Desparear só com a outbox vazia (spec 7.4). Devolve false se recusado. */
export async function unpair(): Promise<boolean> {
  await running?.catch(() => undefined); // a round in flight must not write after the clear
  return kdsDb.transaction("rw", [kdsDb.manifest, kdsDb.orderState, kdsDb.outbox, kdsDb.meta, kdsDb.roster, kdsDb.counterSales], async () => {
    if ((await kdsDb.outbox.count()) > 0) return false;
    await kdsDb.manifest.clear();
    await kdsDb.orderState.clear();
    await kdsDb.roster.clear();
    await kdsDb.counterSales.clear();
    await kdsDb.meta.clear(); // deviceId, cursors, lastSyncAt, authLost
    return true;
  });
}

async function stillPaired(deviceId: string): Promise<boolean> {
  return (await getMeta("deviceId")) === deviceId;
}

async function pushDeliveries(): Promise<void> {
  const pending = (await kdsDb.outbox.where("kind").equals("delivery").sortBy("occurredAt")) as DeliveryOutboxRow[];
  for (const batch of chunk(pending, 100)) {
    const res = await apiFetch("/api/kds/v1/events", KdsEventsResponse, {
      method: "POST",
      body: { events: batch.map(({ eventId, orderId, type, occurredAt }) => ({ eventId, orderId, type, occurredAt })) },
    });
    // CLAUDE.md 34: só sai da outbox o que o servidor confirmou (aceito ou recusado em definitivo).
    const rejected = new Set(res.rejected);
    await kdsDb.transaction("rw", kdsDb.outbox, kdsDb.orderState, async () => {
      for (const ev of batch) {
        if (!rejected.has(ev.eventId)) continue;
        // Do not keep showing a delivery the server refused.
        const row = await kdsDb.orderState.get(ev.orderId);
        if (row?.eventId === ev.eventId) await kdsDb.orderState.delete(ev.orderId);
      }
      await kdsDb.outbox.bulkDelete([...res.accepted, ...res.rejected]);
    });
  }
}

/** Lançamentos do balcão em lotes de 100. Recusado: sai da outbox, fica "recusado" na lista e o saldo local volta. */
async function pushCounterSales(): Promise<void> {
  const pending = (await kdsDb.outbox.where("kind").equals("counter_sale").sortBy("occurredAt")) as CounterSaleOutboxRow[];
  for (const batch of chunk(pending, 100)) {
    const res = await apiFetch("/api/kds/v1/counter-sales", KdsEventsResponse, {
      method: "POST",
      body: { sales: batch.map((s) => ({ id: s.eventId, studentId: s.studentId, items: s.items, occurredAt: s.occurredAt })) },
    });
    const accepted = new Set(res.accepted);
    const rejected = new Set(res.rejected);
    await kdsDb.transaction("rw", kdsDb.outbox, kdsDb.counterSales, kdsDb.roster, async () => {
      for (const s of batch) {
        if (rejected.has(s.eventId)) {
          const sale = await kdsDb.counterSales.get(s.eventId);
          // Um lançamento já desfeito localmente teve o saldo devolvido pelo estorno.
          if (!sale?.voided) await adjustRosterBalance(s.guardianId, s.totalCents);
          await kdsDb.counterSales.update(s.eventId, { status: "rejected" });
        } else if (accepted.has(s.eventId)) {
          await kdsDb.counterSales.update(s.eventId, { status: "accepted" });
        }
      }
      await kdsDb.outbox.bulkDelete([...res.accepted, ...res.rejected]);
    });
  }
}

/**
 * Estornos depois dos lançamentos. O servidor responde pelo id do lançamento. Um estorno cujo lançamento ainda está
 * na outbox (gravado durante esta rodada) espera a próxima: enviado antes do lançamento, seria recusado e o "Desfazer"
 * se perderia.
 */
async function pushCounterVoids(): Promise<void> {
  const pending = await kdsDb.transaction("r", kdsDb.outbox, async () => {
    const voids = (await kdsDb.outbox.where("kind").equals("counter_void").sortBy("occurredAt")) as CounterVoidOutboxRow[];
    const sales = new Set((await kdsDb.outbox.where("kind").equals("counter_sale").toArray()).map((s) => s.eventId));
    return voidsReadyToSend(voids, sales);
  });
  for (const batch of chunk(pending, 100)) {
    const res = await apiFetch("/api/kds/v1/counter-voids", KdsEventsResponse, {
      method: "POST",
      body: { voids: batch.map((v) => ({ saleId: v.saleId, occurredAt: v.occurredAt })) },
    });
    const done = new Set([...res.accepted, ...res.rejected]);
    const rejected = new Set(res.rejected);
    await kdsDb.transaction("rw", kdsDb.outbox, kdsDb.counterSales, kdsDb.roster, async () => {
      for (const v of batch) {
        if (!rejected.has(v.saleId)) continue;
        const sale = await kdsDb.counterSales.get(v.saleId);
        // Estorno recusado de um lançamento aceito: o lanche continua cobrado.
        if (sale && sale.status !== "rejected" && sale.voided) {
          await kdsDb.counterSales.update(v.saleId, { voided: false });
          await adjustRosterBalance(v.guardianId, -v.totalCents);
        }
      }
      await kdsDb.outbox.bulkDelete(batch.filter((v) => done.has(v.saleId)).map((v) => v.eventId));
    });
  }
}

async function pushOutbox(): Promise<void> {
  await pushDeliveries();
  await pushCounterSales();
  await pushCounterVoids();
}

async function pullRoster(deviceId: string): Promise<void> {
  const res = await apiFetch("/api/kds/v1/roster", CounterRosterResponse);
  if (!(await stillPaired(deviceId))) return;
  await replaceRoster(res);
}

async function pullManifest(serviceDate: string, deviceId: string): Promise<void> {
  const current = await kdsDb.manifest.get(serviceDate);
  if (current?.status === "closed") return; // imutável depois de fechado
  try {
    const res = await apiFetch(`/api/kds/v1/manifest/${serviceDate}`, KdsManifestResponse);
    if (!(await stillPaired(deviceId))) return;
    await kdsDb.transaction("rw", kdsDb.manifest, kdsDb.meta, async () => {
      await kdsDb.manifest.put({ ...res, fetchedAt: new Date().toISOString() });
      await kdsDb.meta.delete(`noService:${serviceDate}`);
    });
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404)) throw err;
    // No service day for that date: there is no manifest, and the board says so.
    if (!(await stillPaired(deviceId))) return;
    await kdsDb.transaction("rw", kdsDb.manifest, kdsDb.meta, async () => {
      await kdsDb.manifest.delete(serviceDate);
      await kdsDb.meta.put({ key: `noService:${serviceDate}`, value: "1" });
    });
  }
}

async function pullChanges(serviceDate: string, deviceId: string): Promise<void> {
  const key = `cursor:${serviceDate}`;
  const since = await getMeta(key);
  const url = `/api/kds/v1/changes?date=${serviceDate}${since ? `&since=${encodeURIComponent(since)}` : ""}`;
  const res = await apiFetch(url, KdsChangesResponse);
  if (!(await stillPaired(deviceId))) return;
  await applyRemoteEvents(serviceDate, res.events);
  if (res.cursor && (await stillPaired(deviceId))) await setMeta(key, res.cursor);
}

/**
 * Limpeza local (spec 7.4): apaga romaneio, estado, cursores e lançamentos do balcão de dias com mais de 2 dias,
 * exceto o dia na tela, e o roster parado há mais de 2 dias. Nunca toca na outbox.
 */
async function pruneOldDays(serviceDate: string): Promise<void> {
  const cutoff = shiftDate(localDate(new Date()), -KEEP_DAYS);
  const old = (date: string) => date < cutoff && date !== serviceDate;
  await kdsDb.transaction("rw", [kdsDb.manifest, kdsDb.orderState, kdsDb.meta, kdsDb.counterSales, kdsDb.roster], async () => {
    await kdsDb.manifest.where("serviceDate").below(cutoff).and((m) => old(m.serviceDate)).delete();
    await kdsDb.orderState.where("serviceDate").below(cutoff).and((o) => old(o.serviceDate)).delete();
    for (const prefix of DATED_META) {
      await kdsDb.meta.where("key").startsWith(prefix).and((m) => old(m.key.slice(prefix.length))).delete();
    }
    await kdsDb.counterSales.where("serviceDate").below(cutoff).and((s) => old(s.serviceDate)).delete();
    // Roster sem atualização há mais de 2 dias (tablet parado): some, como o romaneio antigo (LGPD).
    const fetchedAt = (await kdsDb.meta.get(ROSTER_FETCHED_AT))?.value;
    if (fetchedAt && localDate(new Date(fetchedAt)) < cutoff) {
      await kdsDb.roster.clear();
      await kdsDb.meta.where("key").startsWith(ROSTER_META).delete();
    }
  });
}

/** Sessão perdida: apaga o romaneio, o roster e a lista do balcão (LGPD) e mantém a outbox e o deviceId para o novo pareamento. */
async function markAuthLost(deviceId: string): Promise<void> {
  await kdsDb.transaction("rw", [kdsDb.manifest, kdsDb.orderState, kdsDb.meta, kdsDb.roster, kdsDb.counterSales], async () => {
    if ((await kdsDb.meta.get("deviceId"))?.value !== deviceId) return;
    await kdsDb.manifest.clear();
    await kdsDb.orderState.clear();
    await kdsDb.roster.clear();
    await kdsDb.counterSales.clear();
    await kdsDb.meta.where("key").startsWith(ROSTER_META).delete();
    // Without local state the cursors would skip events already applied to it.
    for (const prefix of DATED_META) await kdsDb.meta.where("key").startsWith(prefix).delete();
    await kdsDb.meta.put({ key: "authLost", value: "1" });
  });
}

let running: Promise<void> | null = null;
let runningDate: string | null = null;
let queued: { date: string; promise: Promise<void> } | null = null;

async function round(serviceDate: string): Promise<void> {
  const deviceId = await getMeta("deviceId");
  if (!deviceId) return;
  try {
    await pushOutbox();
    await pullManifest(serviceDate, deviceId);
    await pullChanges(serviceDate, deviceId);
    await pullRoster(deviceId);
    if (await stillPaired(deviceId)) {
      await setMeta("lastSyncAt", new Date().toISOString());
      await kdsDb.meta.delete("authLost");
      await pruneOldDays(serviceDate);
    }
  } catch (err) {
    if (err instanceof ApiError) {
      console.warn("kds sync failed", err.status, err.code);
      // A staff or guardian session in this browser replaced the kitchen cookie (403 insufficient_scope): same as losing it.
      const lost = err.status === 401 || (err.status === 403 && err.code === "insufficient_scope");
      if (lost) await markAuthLost(deviceId);
    } else {
      console.warn("kds sync failed", err instanceof Error ? err.name : "unknown");
    }
    // A outbox fica como está e a próxima rodada tenta de novo.
  }
}

/** Uma rodada: envia a outbox, atualiza o romaneio, puxa mudanças e o roster. Nunca roda duas ao mesmo tempo. */
export function syncNow(serviceDate: string): Promise<void> {
  if (running) {
    if (runningDate === serviceDate) return running;
    if (queued?.date === serviceDate) return queued.promise;
    const promise = running.then(() => {
      queued = null;
      return syncNow(serviceDate);
    });
    queued = { date: serviceDate, promise };
    return promise;
  }
  runningDate = serviceDate;
  running = round(serviceDate).finally(() => {
    running = null;
    runningDate = null;
  });
  return running;
}

/** Spec 7.3 (4): evento online, a cada 15 s e no retorno de foco. Sem Background Sync API. */
export function start(serviceDate: string): () => void {
  const run = () => void syncNow(serviceDate);
  const onVisible = () => {
    if (document.visibilityState === "visible") run();
  };
  window.addEventListener("online", run);
  document.addEventListener("visibilitychange", onVisible);
  const timer = window.setInterval(run, INTERVAL_MS);
  run();
  return () => {
    window.removeEventListener("online", run);
    document.removeEventListener("visibilitychange", onVisible);
    window.clearInterval(timer);
  };
}
