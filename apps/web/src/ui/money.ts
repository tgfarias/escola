/** Formata centavos como "R$ 1.250,00" sem ponto flutuante (CLAUDE.md regra 6). */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(cents));
  const reais = Math.floor(abs / 100);
  const centavos = String(abs % 100).padStart(2, "0");
  const grouped = String(reais).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${sign}R$ ${grouped},${centavos}`;
}

/** "9" → 900, "9,5" → 950, "9,50" → 950, "1.250,00" → 125000; inválido ou zero → null. Sem ponto flutuante. */
export function parsePriceToCents(text: string): number | null {
  const m = /^\s*(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{1,2}))?\s*$/.exec(text);
  if (!m) return null;
  const reais = Number(m[1]!.replace(/\./g, ""));
  const cents = Number((m[2] ?? "0").padEnd(2, "0"));
  const total = reais * 100 + cents;
  return total > 0 && total <= 1_000_000 ? total : null;
}
