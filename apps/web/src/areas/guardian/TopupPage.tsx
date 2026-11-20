import { TopupView } from "@app-lanche/contracts";
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { ApiError, apiFetch } from "../../app/api";
import { errorMessage } from "../../ui/messages";
import { formatCents } from "../../ui/money";
import { GuardianPending, GuardianShell } from "./GuardianShell";

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

  if (!topup) return <GuardianPending error={error} />;
  const pix = topup.payment;
  const until = pix ? new Date(pix.expiresAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : null;
  return (
    <GuardianShell>
      <h1>Pix de {formatCents(topup.amountCents)}</h1>
      {topup.status === "pending_payment" && pix?.pixCopyPaste && (
        <section className="g-card g-pix">
          {pix.pixQrPngBase64 && <img alt="QR Code Pix" src={`data:image/png;base64,${pix.pixQrPngBase64}`} />}
          <textarea className="form-control mb-3" rows={3} readOnly value={pix.pixCopyPaste} aria-label="Código Pix" />
          <button
            type="button"
            className="btn btn-primary btn-lg w-100"
            onClick={() => navigator.clipboard.writeText(pix.pixCopyPaste!).then(() => setCopied(true), () => setCopied(false))}
          >
            {copied ? "Código copiado" : "Copiar código Pix"}
          </button>
          <p className="g-muted mt-2 mb-0">Vale até {until}</p>
        </section>
      )}
      {/* A mudança de situação (pago, expirado) é anunciada pelo leitor de tela. */}
      <div role="status">
        {topup.status === "pending_payment" && (
          <p className="g-muted text-center">{pix?.pixCopyPaste ? "Aguardando o pagamento…" : "Gerando o Pix… aguarde alguns segundos."}</p>
        )}
        {topup.status === "paid" && <p className="g-ok">Pagamento confirmado! Saldo: {formatCents(topup.balanceCents)}</p>}
        {FINAL_TEXT[topup.status] && <p className="g-card">{FINAL_TEXT[topup.status]}</p>}
      </div>
      {error && (
        <p role="alert" className="g-alert">
          {error}
        </p>
      )}
      <Link className="btn btn-link w-100" to="/carteira">
        Voltar à carteira
      </Link>
    </GuardianShell>
  );
}
