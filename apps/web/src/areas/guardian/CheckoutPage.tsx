import { CheckoutView } from "@app-lanche/contracts";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { ApiError, apiFetch } from "../../app/api";
import { errorMessage } from "../../ui/messages";

const FINAL_TEXT: Partial<Record<CheckoutView["status"], string>> = {
  expired: "Este pedido expirou sem pagamento.",
  late_credited: "O pagamento chegou depois do horário. O valor virou crédito na sua carteira.",
  cancelled: "Pedido cancelado. O valor voltou para a sua carteira.",
};

export function CheckoutPage() {
  const { id } = useParams();
  const [checkout, setCheckout] = useState<CheckoutView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const fail = (err: unknown) => setError(errorMessage(err instanceof ApiError ? err.code : "internal_error"));

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const load = () =>
      apiFetch(`/api/v1/checkouts/${id}`, CheckoutView).then(
        (c) => {
          if (stopped) return;
          setCheckout(c);
          if (c.status === "pending_payment") timer = setTimeout(load, 3000);
        },
        (err) => {
          if (!stopped) fail(err);
        },
      );
    void load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [id]);

  async function cancel() {
    if (!window.confirm("Cancelar este pedido?")) return;
    try {
      setCheckout(await apiFetch(`/api/v1/checkouts/${id}/cancel`, CheckoutView, { method: "POST" }));
    } catch (err) {
      fail(err);
    }
  }

  if (!checkout) return <main>{error ? <p role="alert">{error}</p> : <p>Carregando…</p>}</main>;
  const until = new Date(checkout.cutoffAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const pix = checkout.payment;

  return (
    <main>
      {checkout.status === "pending_payment" &&
        (pix?.pixCopyPaste ? (
          <section>
            <p>Pague com Pix até {until}</p>
            {pix.pixQrPngBase64 && <img alt="QR Code Pix" src={`data:image/png;base64,${pix.pixQrPngBase64}`} />}
            <textarea readOnly value={pix.pixCopyPaste} aria-label="Código Pix" />
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(pix.pixCopyPaste!).then(() => setCopied(true), () => setCopied(false))}
            >
              {copied ? "Código copiado" : "Copiar código Pix"}
            </button>
          </section>
        ) : (
          <p>Gerando o Pix… aguarde alguns segundos.</p>
        ))}
      {checkout.status === "paid" && (
        <section>
          <p>Pedido confirmado!</p>
          <ul>
            {checkout.orders.map((o) => (
              <li key={o.id}>
                {o.studentFirstName}: {o.items.map((i) => `${i.qty}x ${i.name}`).join(", ")}
              </li>
            ))}
          </ul>
        </section>
      )}
      {FINAL_TEXT[checkout.status] && <p>{FINAL_TEXT[checkout.status]}</p>}
      {(checkout.status === "paid" || checkout.status === "pending_payment") && (
        <button type="button" onClick={cancel}>
          Cancelar pedido
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      <Link to="/pedido">Voltar</Link>
    </main>
  );
}
