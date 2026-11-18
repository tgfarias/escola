const STALE_MS = 2 * 60 * 1000;

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Spec 7.4: "N pendentes · última sincronização HH:MM"; vermelho após 2 min sem sincronizar. */
export function badgeText(pending: number, lastSyncAt: string | null, now: Date): { text: string; stale: boolean } {
  const count = pending === 1 ? "1 pendente" : `${pending} pendentes`;
  if (!lastSyncAt) return { text: `${count} · nunca sincronizado`, stale: true };
  return {
    text: `${count} · última sincronização ${hhmm(lastSyncAt)}`,
    stale: now.getTime() - Date.parse(lastSyncAt) > STALE_MS,
  };
}
