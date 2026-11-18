export type DeliveryState = "pending" | "delivered";
export type OrderState = { orderId: string; serviceDate: string; state: DeliveryState; occurredAt: string; eventId: string };
export type DeliveryEvent = { eventId: string; orderId: string; type: "delivered" | "undelivered"; occurredAt: string };

/** Spec 7.3 (5): vence o maior occurred_at; empate pelo maior event_id (texto). Igual ao servidor. */
export function isNewer(a: { occurredAt: string; eventId: string }, b: { occurredAt: string; eventId: string }): boolean {
  const ta = Date.parse(a.occurredAt);
  const tb = Date.parse(b.occurredAt);
  if (ta !== tb) return ta > tb;
  return a.eventId > b.eventId;
}

/**
 * Instante de um toque: max(agora, último estado + 1 ms). Um toque sempre substitui o que a tela mostra,
 * mesmo que o estado atual venha de um tablet com o relógio adiantado.
 */
export function nextOccurredAt(nowIso: string, currentIso: string | undefined): string {
  const now = Date.parse(nowIso);
  if (currentIso === undefined) return new Date(now).toISOString();
  return new Date(Math.max(now, Date.parse(currentIso) + 1)).toISOString();
}

/** Novo estado do pedido após o evento, ou undefined se o estado atual já é mais recente. */
export function mergeEvent(current: OrderState | undefined, ev: DeliveryEvent, serviceDate: string): OrderState | undefined {
  if (current && !isNewer(ev, current)) return undefined;
  return {
    orderId: ev.orderId,
    serviceDate,
    state: ev.type === "delivered" ? "delivered" : "pending",
    occurredAt: ev.occurredAt,
    eventId: ev.eventId,
  };
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Data local do tablet (YYYY-MM-DD). Só para a tela e a limpeza local, nunca para regra de negócio. */
export function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Soma dias a uma data YYYY-MM-DD (aritmética de calendário, sem fuso). */
export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
