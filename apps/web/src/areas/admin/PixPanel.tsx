import { TopupView } from "@app-lanche/contracts";
import { useEffect, useRef, useState } from "react";
import { Button, Input, Label } from "reactstrap";
import { apiFetch } from "../../app/api";
import { formatCents } from "../../ui/money";

const POLL_MS = 3000;

/** QR e copia-e-cola de uma recarga, acompanhando o pagamento a cada 3 s (sem cobrança ainda: pede de novo). */
export function PixPanel({ initial, onPaid }: { initial: TopupView; onPaid: () => void }) {
  const [topup, setTopup] = useState(initial);
  const [copied, setCopied] = useState(false);
  const onPaidRef = useRef(onPaid);
  onPaidRef.current = onPaid;

  useEffect(() => {
    setTopup(initial);
    let current = initial;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const next = current.payment?.pixCopyPaste
          ? await apiFetch(`/api/admin/v1/topups/${initial.id}`, TopupView)
          : await apiFetch(`/api/admin/v1/topups/${initial.id}/charge`, TopupView, { method: "POST" });
        if (stopped) return;
        current = next;
        setTopup(next);
        if (next.status === "paid") onPaidRef.current();
      } catch {
        // Rede ou servidor: tenta de novo no próximo ciclo.
      }
      if (!stopped && current.status === "pending_payment") timer = setTimeout(() => void tick(), POLL_MS);
    };
    if (current.status === "pending_payment") timer = setTimeout(() => void tick(), POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [initial]);

  const pix = topup.payment;
  return (
    <div className="border rounded bg-light p-3 my-3" data-testid="pix-panel">
      <p className="fw-semibold">Pix de {formatCents(topup.amountCents)}</p>
      {topup.status === "paid" && <p className="mb-0 text-success fw-semibold">Pagamento recebido. Saldo agora: {formatCents(topup.balanceCents)}.</p>}
      {topup.status === "expired" && <p className="mb-0">Este Pix expirou. Gere um novo.</p>}
      {topup.status === "cancelled" && <p className="mb-0">Este Pix foi substituído por outro mais recente.</p>}
      {topup.status === "pending_payment" &&
        (pix?.pixCopyPaste ? (
          <>
            {pix.pixQrPngBase64 && <img alt="QR Code Pix" className="d-block mb-2 pix-qr" src={`data:image/png;base64,${pix.pixQrPngBase64}`} />}
            <Label for="pix-code">Pix copia e cola</Label>
            <Input id="pix-code" type="textarea" readOnly rows={3} value={pix.pixCopyPaste} />
            <Button
              className="mt-2"
              color="secondary"
              outline
              type="button"
              onClick={() => navigator.clipboard.writeText(pix.pixCopyPaste!).then(() => setCopied(true), () => setCopied(false))}
            >
              {copied ? "Código copiado" : "Copiar código Pix"}
            </Button>
            <p className="mt-2 mb-0">
              Aguardando o pagamento… vale até {new Date(pix.expiresAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}.
            </p>
          </>
        ) : (
          <p className="mb-0">Gerando o Pix… aguarde alguns segundos.</p>
        ))}
    </div>
  );
}
