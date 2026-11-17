import { MeResponse } from "@app-lanche/contracts";
import { useEffect, useState } from "react";
import { ApiError, apiFetch } from "../../app/api";
import { errorMessage } from "../../ui/messages";

export function OrderHome() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch("/api/v1/me", MeResponse).then(setMe, (err) =>
      setError(errorMessage(err instanceof ApiError ? err.code : "internal_error")),
    );
  }, []);

  if (error) return <main><p role="alert">{error}</p></main>;
  if (!me) return <main><p>Carregando…</p></main>;

  return (
    <main>
      <h1>Olá, {me.guardian.firstName}</h1>
      <ul>
        {me.students.map((s) => (
          <li key={s.id}>{s.firstName} — {s.className}</li>
        ))}
      </ul>
    </main>
  );
}
