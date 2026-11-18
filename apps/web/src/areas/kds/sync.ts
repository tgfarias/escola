import { KdsChangesResponse, KdsEventsResponse, KdsManifestResponse, KdsPairResponse } from "@app-lanche/contracts";
import { ApiError, apiFetch } from "../../app/api";
import { applyRemoteEvents, getMeta, kdsDb, setMeta } from "./db";
import { chunk } from "./state";

const INTERVAL_MS = 15_000;

export async function pair(code: string): Promise<string> {
  const res = await apiFetch("/api/kds/v1/pair", KdsPairResponse, { method: "POST", body: { code } });
  // A new pairing may be another device or school: refetch from scratch. The outbox is kept and retried;
  // events for orders of another school come back as rejected and are dropped.
  await kdsDb.transaction("rw", kdsDb.manifest, kdsDb.orderState, kdsDb.meta, async () => {
    await kdsDb.manifest.clear();
    await kdsDb.orderState.clear();
    await kdsDb.meta.where("key").startsWith("cursor:").delete();
    await kdsDb.meta.delete("authLost");
    await kdsDb.meta.put({ key: "deviceId", value: res.deviceId });
  });
  await navigator.storage?.persist?.().catch(() => false);
  return res.deviceId;
}

export async function isPaired(): Promise<boolean> {
  return (await getMeta("deviceId")) !== null;
}

/** True after a 401: the UI asks for a new pairing code and keeps the outbox. */
export async function isAuthLost(): Promise<boolean> {
  return (await getMeta("authLost")) !== null;
}

/** Desparear só com a outbox vazia (spec 7.4). Devolve false se recusado. */
export async function unpair(): Promise<boolean> {
  await running?.catch(() => undefined); // a round in flight must not write after the clear
  return kdsDb.transaction("rw", kdsDb.manifest, kdsDb.orderState, kdsDb.outbox, kdsDb.meta, async () => {
    if ((await kdsDb.outbox.count()) > 0) return false;
    await kdsDb.manifest.clear();
    await kdsDb.orderState.clear();
    await kdsDb.meta.clear(); // deviceId, cursors, lastSyncAt, authLost
    return true;
  });
}

async function stillPaired(deviceId: string): Promise<boolean> {
  return (await getMeta("deviceId")) === deviceId;
}

async function pushOutbox(): Promise<void> {
  const pending = await kdsDb.outbox.orderBy("occurredAt").toArray();
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

async function pullManifest(serviceDate: string, deviceId: string): Promise<void> {
  const current = await kdsDb.manifest.get(serviceDate);
  if (current?.status === "closed") return; // imutável depois de fechado
  try {
    const res = await apiFetch(`/api/kds/v1/manifest/${serviceDate}`, KdsManifestResponse);
    if (!(await stillPaired(deviceId))) return;
    await kdsDb.manifest.put({ ...res, fetchedAt: new Date().toISOString() });
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404)) throw err;
    // No service day for that date: there is no manifest.
    if (await stillPaired(deviceId)) await kdsDb.manifest.delete(serviceDate);
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
    if (await stillPaired(deviceId)) {
      await setMeta("lastSyncAt", new Date().toISOString());
      await kdsDb.meta.delete("authLost");
    }
  } catch (err) {
    if (err instanceof ApiError) {
      console.warn("kds sync failed", err.status, err.code);
      if (err.status === 401 && (await stillPaired(deviceId))) await setMeta("authLost", "1");
    } else {
      console.warn("kds sync failed", err instanceof Error ? err.name : "unknown");
    }
    // A outbox fica como está e a próxima rodada tenta de novo.
  }
}

/** Uma rodada: envia a outbox, atualiza o romaneio e puxa mudanças. Nunca roda duas ao mesmo tempo. */
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
