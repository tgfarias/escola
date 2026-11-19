import { TopupView } from "@app-lanche/contracts";
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { ApiError, apiFetch } from "../../app/api";
import { errorMessage } from "../../ui/messages";
import { formatCents } from "../../ui/money";

const FINAL_TEXT: Partial<Record<TopupView["status"], string>> = {
  expired: "Este Pix expirou. Gere outro na carteira.",
  cancelled: "Este Pix foi substituído por outro mais recente.",
};

/** Pix da recarga, consultado a cada 3 s como no checkout; sem cobrança ainda, pede de novo ao servidor. */
export function TopupPage() {
  const { id } = useParams();
  const [topup, setTopup] = useState<TopupView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let stopped = false;
    let needsPix = false;
    const load = () =>
      (needsPix ? apiFetch(`/api/v1/topups/${id}/charge`, TopupView, { method: "POST" }) : apiFetch(`/api/v1/topups/${id}`, TopupView)).then(
        (t) => {
          if (stopped) return;
          setError(null);
          setTopup(t);
          needsPix = t.status === "pending_payment" && !t.payment?.pixCopyPaste;
          if (t.status === "pending_payment") timer.current = setTimeout(() => void load(), 3000);
        },
        (err) => {
          if (stopped) return;
          setError(errorMessage(err instanceof ApiError ? err.code : "internal_error"));
          const transient = err instanceof ApiError && (err.status === 0 || err.status >= 500);
          if (transient) timer.current = setTimeout(() => void load(), 3000);
        },
      );
    void load();
    return () => {
      stopped = true;
      clearTimeout(timer.current);
    };
  }, [id]);

  if (!topup) return <main>{error ? <p role="alert">{error}</p> : <p>Carregando…</p>}</main>;
  const pix = topup.payment;
  return (
    <main>
      <h1>Pix de {formatCents(topup.amountCents)}</h1>
      {topup.status === "pending_payment" &&
        (pix?.pixCopyPaste ? (
          <section>
            {pix.pixQrPngBase64 && <img alt="QR Code Pix" src={`data:image/png;base64,${pix.pixQrPngBase64}`} />}
            <textarea readOnly value={pix.pixCopyPaste} aria-label="Código Pix" />
            <button type="button" onClick={() => navigator.clipboard.writeText(pix.pixCopyPaste!).then(() => setCopied(true), () => setCopied(false))}>
              {copied ? "Código copiado" : "Copiar código Pix"}
            </button>
            <p>Aguardando o pagamento…</p>
          </section>
        ) : (
          <p>Gerando o Pix… aguarde alguns segundos.</p>
        ))}
      {topup.status === "paid" && <p>Pagamento confirmado! Saldo: {formatCents(topup.balanceCents)}</p>}
      {FINAL_TEXT[topup.status] && <p>{FINAL_TEXT[topup.status]}</p>}
      {error && <p role="alert">{error}</p>}
      <Link to="/carteira">Voltar à carteira</Link>
    </main>
  );
}
