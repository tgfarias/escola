import { TOPUP_MAX_CENTS, TOPUP_MIN_CENTS, TopupView, WalletResponse, type GuardianTopupRequest } from "@app-lanche/contracts";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { ApiError, apiFetch } from "../../app/api";
import { errorMessage } from "../../ui/messages";
import { formatCents, parsePriceToCents } from "../../ui/money";
import { entryLabel } from "../../ui/walletLabels";
import { GuardianPending, GuardianShell } from "./GuardianShell";

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

  if (!wallet) return <GuardianPending error={error} />;
  const debt = wallet.balanceCents < 0;

  return (
    <GuardianShell>
      <h1>Carteira</h1>
      <section className={`g-card g-balance ${debt ? "g-balance--debt" : "g-balance--ok"}`}>
        {debt ? (
          <p className="g-balance__value">Débito: {formatCents(-wallet.balanceCents)}</p>
        ) : (
          <p className="g-balance__value">Saldo: {formatCents(wallet.balanceCents)}</p>
        )}
        {wallet.financialFor.length > 0 && (
          <p className="g-muted mt-2 mb-0">Você é o responsável financeiro de {names(wallet.financialFor)}.</p>
        )}
        {debt && (
          <button type="button" className="btn btn-primary btn-lg w-100 mt-3" disabled={busy} onClick={() => void pay({ purpose: "debt" })}>
            Pagar débito ({formatCents(-wallet.balanceCents)})
          </button>
        )}
      </section>
      <form className="g-card" onSubmit={addCredit}>
        <h2>Adicionar créditos</h2>
        <label htmlFor="credit" className="form-label">
          Valor (R$ 10,00 a R$ 1.000,00)
        </label>
        <input id="credit" className="form-control form-control-lg mb-3" inputMode="decimal" placeholder="Ex.: 50,00" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <button type="submit" className={`btn ${debt ? "btn-outline-primary" : "btn-primary"} btn-lg w-100`} disabled={busy}>
          Adicionar créditos
        </button>
      </form>
      {error && (
        <p role="alert" className="g-alert">
          {error}
        </p>
      )}
      <section className="g-card">
        <h2>Extrato</h2>
        {wallet.entries.length === 0 ? (
          <p className="g-muted mb-0">Nenhum lançamento.</p>
        ) : (
          <ul className="g-list">
            {wallet.entries.map((e) => (
              <li key={e.id} className="d-flex justify-content-between gap-2">
                <span>
                  <span className="g-muted">{day(e.createdAt)} · </span>
                  {entryLabel(e.kind, e.studentFirstName)}
                  {e.overLimit && <span className="g-tag g-tag--warn">acima do limite</span>}
                  {e.kind === "counter_charge" && e.voided && <span className="g-tag">estornado</span>}
                </span>
                <span className={`g-amount${e.amountCents > 0 ? " g-amount--in" : ""}`}>
                  {e.amountCents > 0 ? "+" : ""}
                  {formatCents(e.amountCents)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {wallet.otherSales.length > 0 && (
        <section className="g-card">
          <h2>Lanches lançados na conta de outro responsável</h2>
          <ul className="g-list">
            {wallet.otherSales.map((s) => (
              <li key={s.id} className="d-flex justify-content-between gap-2">
                <span>
                  <span className="g-muted">{day(s.occurredAt)} · </span>
                  {s.studentFirstName}
                  {s.voided && <span className="g-tag">estornado</span>}
                </span>
                <span className="g-amount">{formatCents(s.totalCents)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {hasHistory && (
        <button type="button" className="btn btn-link w-100" onClick={() => navigate(-1)}>
          Voltar
        </button>
      )}
    </GuardianShell>
  );
}
