import { CheckoutView, type DayItem, type GuardianShift, type MeResponse, type Shift } from "@app-lanche/contracts";
import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ApiError, apiFetch } from "../../app/api";
import { errorMessage } from "../../ui/messages";
import { formatCents } from "../../ui/money";
import { SHIFT_LABELS } from "../../ui/shifts";

type Cart = Record<string, Record<string, number>>; // studentId → menuItemId → qty
type Props = {
  serviceDate: string;
  items: DayItem[];
  shift: Shift;
  info: GuardianShift | undefined;
  students: MeResponse["students"];
  ordered: Map<string, string>; // studentId → checkoutId
  labelled: boolean;
};

const time = (iso: string) => new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

/** Pedido de um turno: o checkout é de um turno só (spec F5C, B.1). */
export function ShiftOrder({ serviceDate, items, shift, info, students, ordered, labelled }: Props) {
  const navigate = useNavigate();
  const [cart, setCart] = useState<Cart>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const keyRef = useRef<string | null>(null);

  function change(studentId: string, menuItemId: string, delta: number) {
    keyRef.current = null;
    setCart((prev) => {
      const current = prev[studentId]?.[menuItemId] ?? 0;
      const qty = Math.min(10, Math.max(0, current + delta));
      return { ...prev, [studentId]: { ...prev[studentId], [menuItemId]: qty } };
    });
  }

  const price = new Map(items.map((i) => [i.menuItemId, i.priceCents]));
  const orders = Object.entries(cart)
    .map(([studentId, lines]) => ({
      studentId,
      items: Object.entries(lines)
        .filter(([, qty]) => qty > 0)
        .map(([menuItemId, qty]) => ({ menuItemId, qty })),
    }))
    .filter((o) => o.items.length > 0);
  const total = orders.reduce((sum, o) => sum + o.items.reduce((s, i) => s + (price.get(i.menuItemId) ?? 0) * i.qty, 0), 0);

  async function pay() {
    setBusy(true);
    setError(null);
    keyRef.current ??= crypto.randomUUID();
    try {
      const checkout = await apiFetch("/api/v1/checkouts", CheckoutView, {
        method: "POST",
        body: { serviceDate, orders },
        idempotencyKey: keyRef.current,
      });
      navigate(`/pedido/checkout/${checkout.id}`);
    } catch (err) {
      setError(errorMessage(err instanceof ApiError ? err.code : "internal_error"));
    } finally {
      setBusy(false);
    }
  }

  const names = students.map((s) => s.firstName).join(" e ");
  const open = info?.acceptingOrders === true;
  return (
    <section className="mb-3">
      {labelled && <h2 className="h5">{SHIFT_LABELS[shift]}</h2>}
      {!info ? (
        <p className="g-card g-muted">{`Não há lanche para a turma de ${names} neste dia.`}</p>
      ) : (
        <>
          <p className="g-muted">{open ? `Pedidos até ${time(info.cutoffAt)}` : `Pedidos encerrados às ${time(info.cutoffAt)}`}</p>
          {students.map((s) => (
            <article key={s.id} className="g-card">
              <h3 className="h6">{s.firstName}</h3>
              {ordered.has(s.id) ? (
                <p className="mb-0">
                  <span className="g-tag ms-0">Pedido já feito</span> · <Link to={`/pedido/checkout/${ordered.get(s.id)}`}>Ver pedido</Link>
                </p>
              ) : (
                open && (
                  <ul className="g-list">
                    {items.map((item) => {
                      const qty = cart[s.id]?.[item.menuItemId] ?? 0;
                      return (
                        <li key={item.menuItemId} className="d-flex align-items-center justify-content-between gap-2">
                          <span>
                            {item.name}
                            <br />
                            <span className="g-muted">{formatCents(item.priceCents)}</span>
                          </span>
                          <span className="g-stepper">
                            <button
                              type="button"
                              className="btn btn-outline-secondary"
                              aria-label={`Remover ${item.name} de ${s.firstName}`}
                              disabled={qty === 0}
                              onClick={() => change(s.id, item.menuItemId, -1)}
                            >
                              −
                            </button>
                            <span className="g-stepper__qty">{qty}</span>
                            <button
                              type="button"
                              className="btn btn-primary"
                              aria-label={`Adicionar ${item.name} para ${s.firstName}`}
                              onClick={() => change(s.id, item.menuItemId, 1)}
                            >
                              +
                            </button>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )
              )}
            </article>
          ))}
          {error && (
            <p role="alert" className="g-alert">
              {error}
            </p>
          )}
          {open && students.some((s) => !ordered.has(s.id)) && (
            <button type="button" className="btn btn-primary btn-lg w-100" disabled={total === 0 || busy} onClick={pay}>
              Pagar {formatCents(total)}
            </button>
          )}
        </>
      )}
    </section>
  );
}
