import { useEffect, useState } from "react";
import { badgeText } from "./badge";
import { kdsDb, markOrder } from "./db";
import * as sync from "./sync";
import { useLive } from "./useLive";

export function KdsBoard({ serviceDate, onUnpaired }: { serviceDate: string; onUnpaired: () => void }) {
  const manifest = useLive(() => kdsDb.manifest.get(serviceDate), [serviceDate]);
  const states = useLive(() => kdsDb.orderState.where("serviceDate").equals(serviceDate).toArray(), [serviceDate]);
  const pending = useLive(() => kdsDb.outbox.count(), []);
  const lastSyncAt = useLive(async () => (await kdsDb.meta.get("lastSyncAt"))?.value ?? null, []);
  const [now, setNow] = useState(() => new Date());
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => sync.start(serviceDate), [serviceDate]);
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 10_000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => {
    // Spec 7.4: tela acesa enquanto o KDS está aberto.
    let lock: { release: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } };
    nav.wakeLock?.request("screen").then((l) => (lock = l), () => undefined);
    return () => void lock?.release();
  }, []);

  const delivered = new Set((states ?? []).filter((s) => s.state === "delivered").map((s) => s.orderId));
  const badge = badgeText(pending ?? 0, lastSyncAt ?? null, now);
  const closed = manifest?.status === "closed";

  async function unpair() {
    if (!(await sync.unpair())) {
      setMessage("Há entregas ainda não sincronizadas. Conecte o tablet à internet e aguarde antes de desparear.");
      return;
    }
    onUnpaired();
  }

  return (
    <main>
      <header>
        <h1>Cozinha — {serviceDate.split("-").reverse().join("/")}</h1>
        <p data-testid="kds-badge" style={{ color: badge.stale ? "#b91c1c" : undefined }}>{badge.text}</p>
      </header>
      {!manifest && <p>Carregando o romaneio… Conecte o tablet à internet na primeira vez.</p>}
      {manifest && !closed && (
        <p data-testid="kds-waiting">Prévia parcial — aguardando fechamento. As entregas podem ser marcadas depois do fechamento.</p>
      )}
      {manifest && (
        <p>
          {manifest.content.totals.orders} pedidos ·{" "}
          {manifest.content.totals.by_item.map((i) => `${i.qty}x ${i.item}`).join(" · ")}
        </p>
      )}
      {manifest?.content.by_class.map((c) => (
        <section key={c.class}>
          <h2>{c.class}</h2>
          <ul>
            {c.orders.map((o) => {
              const isDelivered = delivered.has(o.order_id);
              return (
                <li key={o.order_id}>
                  <button
                    type="button"
                    data-testid={`kds-order-${o.order_id}`}
                    aria-pressed={isDelivered}
                    disabled={!closed}
                    onClick={() => void markOrder(o.order_id, serviceDate, !isDelivered)}
                  >
                    {isDelivered ? "✓ " : ""}
                    {o.student} — {o.items.join(", ")}
                    {o.restrictions ? ` (restrição: ${o.restrictions})` : ""}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      <footer>
        <button data-testid="kds-unpair" type="button" onClick={() => void unpair()}>Desparear este tablet</button>
        {message && <p role="alert">{message}</p>}
      </footer>
    </main>
  );
}
