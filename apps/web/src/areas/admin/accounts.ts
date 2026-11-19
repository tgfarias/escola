import type { AccountListResponse } from "@app-lanche/contracts";
import { formatCents, parsePriceToCents } from "../../ui/money";

export type AccountRow = AccountListResponse["accounts"][number];

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Filtra e ordena com os débitos primeiro (maior débito no topo); empate mantém a ordem do servidor. */
export function filterAccounts(rows: AccountRow[], filter: { query: string; onlyDebt: boolean }): AccountRow[] {
  const q = fold(filter.query.trim());
  return rows
    .filter((a) => (!filter.onlyDebt || a.balanceCents < 0) && (q === "" || fold([a.firstName, ...a.students].join(" ")).includes(q)))
    .sort((a, b) => Math.min(a.balanceCents, 0) - Math.min(b.balanceCents, 0));
}

/** "50,00" para o campo de valor (sem "R$"). */
export function centsToInput(cents: number): string {
  return formatCents(cents).replace("R$ ", "");
}

/** Limite aceita zero (sem débito); outros valores como em parsePriceToCents. */
export function parseLimitCents(text: string): number | null {
  return /^\s*0+(,0{1,2})?\s*$/.test(text) ? 0 : parsePriceToCents(text);
}

export function formatDayTime(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}
