import { badgeText } from "./badge";

/** Selo de sincronização (spec 7.4): verde sincronizado, laranja com pendentes, vermelho após 2 min sem sincronizar. */
export function SyncBadge({ pending, lastSyncAt, now }: { pending: number; lastSyncAt: string | null; now: Date }) {
  const badge = badgeText(pending, lastSyncAt, now);
  const tone = badge.stale ? "danger" : pending > 0 ? "warning" : "success";
  return (
    <span data-testid="kds-badge" className={`badge rounded-pill kds-sync-badge text-bg-${tone}`}>
      {badge.stale ? `${badge.text} — sem sincronizar` : badge.text}
    </span>
  );
}
