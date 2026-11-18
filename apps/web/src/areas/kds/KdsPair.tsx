import { useState, type FormEvent } from "react";
import { ApiError } from "../../app/api";
import * as sync from "./sync";

export function KdsPair({ onPaired }: { onPaired: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await sync.pair(code);
      onPaired();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 0
          ? "Sem conexão. O pareamento precisa de internet."
          : "Código inválido ou vencido. Peça um novo código à secretaria.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Parear tablet da cozinha</h1>
      <form onSubmit={submit}>
        <label>
          Código de pareamento
          <input data-testid="kds-pair-code" value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="characters" maxLength={8} />
        </label>
        <button data-testid="kds-pair-submit" type="submit" disabled={busy || code.trim().length !== 8}>Parear</button>
      </form>
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
