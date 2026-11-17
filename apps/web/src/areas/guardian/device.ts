const KEY = "deviceSecret";

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Identificador do aparelho. Não é cookie porque o Firebase Hosting só repassa `__session`. */
export function getDeviceSecret(): string {
  try {
    const existing = localStorage.getItem(KEY);
    if (existing) return existing;
    const created = randomSecret();
    localStorage.setItem(KEY, created);
    return created;
  } catch {
    // Armazenamento bloqueado (aba anônima): o aparelho será tratado como novo a cada acesso.
    return randomSecret();
  }
}
