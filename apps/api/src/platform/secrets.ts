const REF_FORMAT = /^[A-Z][A-Z0-9_]{2,100}$/;

/**
 * Segredo por escola. `ref` é o nome de uma variável de ambiente que o Cloud Run preenche a partir do
 * Secret Manager (`--set-secrets`). As mensagens de erro citam o nome, nunca o valor.
 */
export function getSecret(ref: string): string {
  if (!REF_FORMAT.test(ref)) throw new Error("invalid secret reference");
  const value = process.env[ref];
  if (!value || value.length < 32) throw new Error(`secret ${ref} is missing or shorter than 32 characters`);
  return value;
}
