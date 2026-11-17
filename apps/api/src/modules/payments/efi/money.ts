const REAIS = /^(\d+)\.(\d{2})$/;

export function centsToReais(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error("invalid cents");
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

export function reaisToCents(text: string): number {
  const m = REAIS.exec(text);
  if (!m) throw new Error("invalid amount format");
  const cents = Number(m[1]) * 100 + Number(m[2]);
  if (!Number.isSafeInteger(cents)) throw new Error("invalid amount");
  return cents;
}

/** Pontos-base para o percentual com duas casas que a Efí espera ("10.00"). */
export function bpsToPercent(bps: number): string {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new Error("invalid bps");
  return `${Math.floor(bps / 100)}.${String(bps % 100).padStart(2, "0")}`;
}
