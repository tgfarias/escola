import type { CounterRosterResponse } from "@app-lanche/contracts";

/** Regras do lançamento no balcão (tablet e admin). Só para a tela: preço e total valem os do servidor (regra 7). */
export type RosterItem = CounterRosterResponse["items"][number];
export type RosterRow = {
  studentId: string;
  firstName: string;
  className: string;
  restrictions: string | null;
  guardianId: string | null;
  guardianFirstName: string | null;
  balanceCents: number;
};
export type Cart = Record<string, number>;
export type SaleLine = { menuItemId: string; name: string; qty: number; unitPriceCents: number };

export const OVER_LIMIT_TEXT = "Saldo insuficiente: peça à secretaria";
export const MAX_QTY = 10;

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

export function filterRoster(rows: RosterRow[], filter: { query: string; className: string | null }): RosterRow[] {
  const q = fold(filter.query.trim());
  return rows.filter((r) => (filter.className === null || r.className === filter.className) && (q === "" || fold(r.firstName).includes(q)));
}

export function setQty(cart: Cart, menuItemId: string, qty: number): Cart {
  const next = { ...cart };
  if (qty <= 0) delete next[menuItemId];
  else next[menuItemId] = Math.min(Math.trunc(qty), MAX_QTY);
  return next;
}

export function cartLines(cart: Cart, items: RosterItem[]): SaleLine[] {
  return items
    .filter((i) => (cart[i.id] ?? 0) > 0)
    .map((i) => ({ menuItemId: i.id, name: i.name, qty: cart[i.id]!, unitPriceCents: i.priceCents }));
}

export function cartTotal(cart: Cart, items: RosterItem[]): number {
  return cartLines(cart, items).reduce((sum, l) => sum + l.qty * l.unitPriceCents, 0);
}

/** O saldo depois do lançamento não pode ficar abaixo de -limite (spec F5B). */
export function canSell(balanceCents: number, totalCents: number, limitCents: number): boolean {
  return totalCents > 0 && balanceCents - totalCents >= -limitCents;
}

/** Ajuste do saldo local pelo que ainda está na outbox: lançamento debita, estorno credita. */
export function pendingDelta(rows: { kind: string; guardianId?: string; totalCents?: number }[], guardianId: string): number {
  let delta = 0;
  for (const r of rows) {
    if (r.guardianId !== guardianId || r.totalCents === undefined) continue;
    if (r.kind === "counter_sale") delta -= r.totalCents;
    else if (r.kind === "counter_void") delta += r.totalCents;
  }
  return delta;
}

export function rosterRows(res: CounterRosterResponse, pending: { kind: string; guardianId?: string; totalCents?: number }[]): RosterRow[] {
  return res.students.map((s) => ({
    studentId: s.id,
    firstName: s.firstName,
    className: s.className,
    restrictions: s.restrictions,
    guardianId: s.guardian?.id ?? null,
    guardianFirstName: s.guardian?.firstName ?? null,
    balanceCents: s.guardian ? s.guardian.balanceCents + pendingDelta(pending, s.guardian.id) : 0,
  }));
}
