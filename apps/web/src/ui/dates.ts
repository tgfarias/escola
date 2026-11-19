/** "2021-03-15" → "15/03/2021", sem passar por Date (sem deslocamento de fuso). */
export function formatIsoDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

/** Instante ISO → data local do navegador. */
export function formatInstantDate(iso: string): string {
  return new Date(iso).toLocaleDateString("pt-BR");
}
