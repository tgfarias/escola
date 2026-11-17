import {
  CheckoutListResponse,
  CheckoutView,
  type GuardianServiceDay,
  type MeResponse,
} from "@app-lanche/contracts";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ApiError, apiFetch } from "../../app/api";
import { errorMessage } from "../../ui/messages";
import { formatCents } from "../../ui/money";

type Cart = Record<string, Record<string, number>>; // studentId → menuItemId → qty
const ACTIVE = new Set(["pending", "confirmed", "delivered"]);

export function DayOrder({ day, me }: { day: GuardianServiceDay; me: MeResponse }) {
  const navigate = useNavigate();
  const [cart, setCart] = useState<Cart>({});
  const [ordered, setOrdered] = useState<Map<string, string>>(new Map()); // studentId → checkoutId
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const keyRef = useRef<string | null>(null);

  useEffect(() => {
    apiFetch(`/api/v1/checkouts?serviceDate=${day.serviceDate}`, CheckoutListResponse).then(
      (res) => {
        const map = new Map<string, string>();
        for (const c of res.checkouts) for (const o of c.orders) if (ACTIVE.has(o.status)) map.set(o.studentId, c.id);
        setOrdered(map);
      },
      (err) => setError(errorMessage(err instanceof ApiError ? err.code : "internal_error")),
    );
  }, [day.serviceDate]);

  function change(studentId: string, menuItemId: string, delta: number) {
    keyRef.current = null;
    setCart((prev) => {
      const current = prev[studentId]?.[menuItemId] ?? 0;
      const qty = Math.min(10, Math.max(0, current + delta));
      return { ...prev, [studentId]: { ...prev[studentId], [menuItemId]: qty } };
    });
  }

  const price = new Map(day.items.map((i) => [i.menuItemId, i.priceCents]));
  const orders = Object.entries(cart)
    .map(([studentId, items]) => ({
      studentId,
      items: Object.entries(items)
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
        body: { serviceDate: day.serviceDate, orders },
        idempotencyKey: keyRef.current,
      });
      navigate(`/pedido/checkout/${checkout.id}`);
    } catch (err) {
      setError(errorMessage(err instanceof ApiError ? err.code : "internal_error"));
    } finally {
      setBusy(false);
    }
  }

  const cutoff = new Date(day.cutoffAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return (
    <section>
      <p>Pedidos até {cutoff}</p>
      {me.students.map((s) => (
        <article key={s.id}>
          <h2>{s.firstName}</h2>
          {ordered.has(s.id) ? (
            <p>
              Pedido já feito · <Link to={`/pedido/checkout/${ordered.get(s.id)}`}>Ver pedido</Link>
            </p>
          ) : (
            <ul>
              {day.items.map((item) => {
                const qty = cart[s.id]?.[item.menuItemId] ?? 0;
                return (
                  <li key={item.menuItemId}>
                    {item.name} — {formatCents(item.priceCents)}{" "}
                    <button type="button" aria-label={`Remover ${item.name} de ${s.firstName}`} onClick={() => change(s.id, item.menuItemId, -1)}>
                      −
                    </button>{" "}
                    {qty}{" "}
                    <button type="button" aria-label={`Adicionar ${item.name} para ${s.firstName}`} onClick={() => change(s.id, item.menuItemId, 1)}>
                      +
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </article>
      ))}
      {error && <p role="alert">{error}</p>}
      <button type="button" disabled={total === 0 || busy} onClick={pay}>
        Pagar {formatCents(total)}
      </button>
    </section>
  );
}
