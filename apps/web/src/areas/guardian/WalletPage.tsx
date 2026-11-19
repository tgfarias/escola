import { TOPUP_MAX_CENTS, TOPUP_MIN_CENTS, TopupView, WalletResponse, type GuardianTopupRequest } from "@app-lanche/contracts";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { ApiError, apiFetch } from "../../app/api";
import { errorMessage } from "../../ui/messages";
import { formatCents, parsePriceToCents } from "../../ui/money";
import { entryLabel } from "../../ui/walletLabels";

const day = (iso: string) => new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
const names = (list: string[]) => (list.length <= 1 ? list.join("") : `${list.slice(0, -1).join(", ")} e ${list[list.length - 1]}`);

export function WalletPage() {
  const navigate = useNavigate();
  // Aberta direto pelo link do WhatsApp não há para onde voltar dentro do app.
  const hasHistory = useLocation().key !== "default";
  const [wallet, setWallet] = useState<WalletResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  // Mesma chave enquanto o pedido é o mesmo e não deu certo: repetir depois de uma falha não cria outra recarga.
  const held = useRef<{ body: string; key: string } | null>(null);
  // Trava síncrona: dois toques antes de o React redesenhar o botão desligado não criam duas recargas.
  const inFlight = useRef(false);

  useEffect(() => {
    apiFetch("/api/v1/wallet", WalletResponse).then(setWallet, (err) => setError(errorMessage(err instanceof ApiError ? err.code : "internal_error")));
  }, []);

  async function pay(body: GuardianTopupRequest) {
    if (inFlight.current) return;
    inFlight.current = true;
    const fingerprint = JSON.stringify(body);
    if (held.current?.body !== fingerprint) held.current = { body: fingerprint, key: crypto.randomUUID() };
    setBusy(true);
    setError(null);
    try {
      const topup = await apiFetch("/api/v1/topups", TopupView, { method: "POST", body, idempotencyKey: held.current.key });
      held.current = null;
      navigate(`/carteira/recarga/${topup.id}`);
    } catch (err) {
      setError(errorMessage(err instanceof ApiError ? err.code : "internal_error"));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function addCredit(event: FormEvent) {
    event.preventDefault();
    const cents = parsePriceToCents(amount);
    if (cents === null || cents < TOPUP_MIN_CENTS || cents > TOPUP_MAX_CENTS) {
      setError("Informe um valor entre R$ 10,00 e R$ 1.000,00.");
      return;
    }
    void pay({ purpose: "credit", amountCents: cents });
  }

  if (!wallet) return <main>{error ? <p role="alert">{error}</p> : <p>Carregando…</p>}</main>;
  const debt = wallet.balanceCents < 0;

  return (
    <main>
      <h1>Carteira</h1>
      {debt ? (
        <p>
          <strong>Débito: {formatCents(-wallet.balanceCents)}</strong>
        </p>
      ) : (
        <p>Saldo: {formatCents(wallet.balanceCents)}</p>
      )}
      {wallet.financialFor.length > 0 && <p>Você é o responsável financeiro de {names(wallet.financialFor)}.</p>}
      {debt && (
        <button type="button" disabled={busy} onClick={() => void pay({ purpose: "debt" })}>
          Pagar débito ({formatCents(-wallet.balanceCents)})
        </button>
      )}
      <form onSubmit={addCredit}>
        <label htmlFor="credit">Valor (R$ 10,00 a R$ 1.000,00)</label>
        <input id="credit" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <button type="submit" disabled={busy}>Adicionar créditos</button>
      </form>
      {error && <p role="alert">{error}</p>}
      <h2>Extrato</h2>
      {wallet.entries.length === 0 ? (
        <p>Nenhum lançamento.</p>
      ) : (
        <ul>
          {wallet.entries.map((e) => (
            <li key={e.id}>
              {day(e.createdAt)} · {entryLabel(e.kind, e.studentFirstName)} · {e.amountCents > 0 ? "+" : ""}
              {formatCents(e.amountCents)}
              {e.overLimit ? " · acima do limite" : ""}
              {e.kind === "counter_charge" && e.voided ? " · estornado" : ""}
            </li>
          ))}
        </ul>
      )}
      {wallet.otherSales.length > 0 && (
        <>
          <h2>Lanches lançados na conta de outro responsável</h2>
          <ul>
            {wallet.otherSales.map((s) => (
              <li key={s.id}>
                {day(s.occurredAt)} · {s.studentFirstName} · {formatCents(s.totalCents)}
                {s.voided ? " · estornado" : ""}
              </li>
            ))}
          </ul>
        </>
      )}
      {hasHistory && (
        <button type="button" onClick={() => navigate(-1)}>
          Voltar
        </button>
      )}
    </main>
  );
}
