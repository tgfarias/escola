import { MenuItem, MenuItemListResponse } from "@app-lanche/contracts";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, apiFetch } from "../../app/api";
import { staffErrorMessage } from "../../ui/messages";
import { formatCents, parsePriceToCents } from "../../ui/money";

export function MenuAdmin() {
  const [items, setItems] = useState<MenuItem[]>([]);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const keyRef = useRef<string | null>(null);

  useEffect(() => {
    apiFetch("/api/admin/v1/menu-items", MenuItemListResponse).then(
      (res) => setItems(res.items),
      (err) => setError(staffErrorMessage(err instanceof ApiError ? err.code : "internal_error")),
    );
  }, []);

  async function add(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const priceCents = parsePriceToCents(price);
    if (priceCents === null) {
      setError("Preço inválido.");
      return;
    }
    setBusy(true);
    keyRef.current ??= crypto.randomUUID();
    try {
      const created = await apiFetch("/api/admin/v1/menu-items", MenuItem, {
        method: "POST",
        body: { name: name.trim(), priceCents },
        idempotencyKey: keyRef.current,
      });
      keyRef.current = null;
      setItems((prev) => [...prev, created]);
      setName("");
      setPrice("");
    } catch (err) {
      setError(staffErrorMessage(err instanceof ApiError ? err.code : "internal_error"));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(item: MenuItem) {
    setError(null);
    try {
      const updated = await apiFetch(`/api/admin/v1/menu-items/${item.id}`, MenuItem, {
        method: "PATCH",
        body: { active: !item.active },
      });
      setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
    } catch (err) {
      setError(staffErrorMessage(err instanceof ApiError ? err.code : "internal_error"));
    }
  }

  return (
    <section>
      <h2>Cardápio</h2>
      <ul>
        {items.map((i) => (
          <li key={i.id}>
            <span>{`${i.name} — ${formatCents(i.priceCents)}${i.active ? "" : " (inativo)"}`}</span>{" "}
            <button type="button" onClick={() => toggle(i)}>
              {i.active ? "Desativar" : "Ativar"}
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={add}>
        <h3>Novo item</h3>
        <label htmlFor="menu-name">Nome</label>
        <input id="menu-name" required maxLength={80} value={name} onChange={(e) => {
            keyRef.current = null;
            setName(e.target.value);
          }} />
        <label htmlFor="menu-price">Preço (R$)</label>
        <input id="menu-price" required inputMode="decimal" value={price} onChange={(e) => {
            keyRef.current = null;
            setPrice(e.target.value);
          }} />
        <button type="submit" disabled={busy}>Adicionar</button>
      </form>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
