import { WalletResponse } from "@app-lanche/contracts";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ApiError, apiFetch } from "../../app/api";
import { errorMessage } from "../../ui/messages";
import { formatCents } from "../../ui/money";

const LABEL: Record<WalletResponse["entries"][number]["kind"], string> = {
  checkout_hold: "Usado em pedido",
  hold_release: "Devolução de saldo reservado",
  late_payment_credit: "Pagamento após o horário",
  cancel_credit: "Pedido cancelado",
  refund: "Reembolso",
  manual_adjustment: "Ajuste da escola",
};

export function WalletPage() {
  const [wallet, setWallet] = useState<WalletResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch("/api/v1/wallet", WalletResponse).then(setWallet, (err) =>
      setError(errorMessage(err instanceof ApiError ? err.code : "internal_error")),
    );
  }, []);

  if (error) return <main><p role="alert">{error}</p></main>;
  if (!wallet) return <main><p>Carregando…</p></main>;
  return (
    <main>
      <h1>Saldo: {formatCents(wallet.balanceCents)}</h1>
      <ul>
        {wallet.entries.map((e) => (
          <li key={e.id}>
            {new Date(e.createdAt).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })} · {LABEL[e.kind]} ·{" "}
            {e.amountCents > 0 ? "+" : ""}
            {formatCents(e.amountCents)}
          </li>
        ))}
      </ul>
      <Link to="/pedido">Voltar</Link>
    </main>
  );
}
