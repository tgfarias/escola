import {
  ManifestResponse,
  MenuItemListResponse,
  ServiceDay as ServiceDaySchema,
  ServiceDayListResponse,
  type MenuItem,
  type ServiceDay,
} from "@app-lanche/contracts";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError, apiFetch } from "../../app/api";
import { staffErrorMessage } from "../../ui/messages";
import { formatCents } from "../../ui/money";

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

export function ServiceDaysAdmin() {
  const [days, setDays] = useState<ServiceDay[]>([]);
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [date, setDate] = useState("");
  const [cutoff, setCutoff] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fail = (err: unknown) => setError(staffErrorMessage(err instanceof ApiError ? err.code : "internal_error"));

  const reload = useCallback(
    () => apiFetch("/api/admin/v1/service-days", ServiceDayListResponse).then((res) => setDays(res.serviceDays), fail),
    [],
  );

  useEffect(() => {
    void reload();
    apiFetch("/api/admin/v1/menu-items", MenuItemListResponse).then((res) => setMenu(res.items), fail);
  }, [reload]);

  function toggleItem(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`/api/admin/v1/service-days/${date}`, ServiceDaySchema, {
        method: "PUT",
        body: {
          ...(cutoff ? { cutoffTime: cutoff } : {}),
          items: [...selected].map((menuItemId) => ({ menuItemId })),
        },
      });
      await reload();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function close(day: ServiceDay) {
    if (!window.confirm("Fechar o dia? Os pedidos não pagos expiram e o romaneio fica congelado.")) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const manifest = await apiFetch(`/api/admin/v1/service-days/${day.serviceDate}/close`, ManifestResponse, {
        method: "POST",
      });
      setNotice(`Dia fechado: ${manifest.totals.orders} pedidos.`);
      await reload();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>Dias de serviço</h2>
      <ul>
        {days.map((d) => (
          <li key={d.serviceDate}>
            <span>
              {formatDate(d.serviceDate)} · corte {formatTime(d.cutoffAt)} · {d.status === "open" ? "Aberto" : "Fechado"}
            </span>
            <ul>
              {d.items.map((i) => (
                <li key={i.menuItemId}>{`${i.name} — ${formatCents(i.priceCents)}`}</li>
              ))}
            </ul>
            {d.status === "open" && (
              <button type="button" disabled={busy} onClick={() => close(d)}>
                Fechar dia
              </button>
            )}
          </li>
        ))}
      </ul>
      <form onSubmit={save}>
        <h3>Abrir dia</h3>
        <label htmlFor="day-date">Data</label>
        <input id="day-date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
        <label htmlFor="day-cutoff">Horário de corte (opcional)</label>
        <input id="day-cutoff" type="time" value={cutoff} onChange={(e) => setCutoff(e.target.value)} />
        <fieldset>
          <legend>Itens</legend>
          {menu
            .filter((i) => i.active)
            .map((i) => (
              <label key={i.id}>
                <input type="checkbox" checked={selected.has(i.id)} onChange={() => toggleItem(i.id)} />
                {i.name}
              </label>
            ))}
        </fieldset>
        <button type="submit" disabled={busy || selected.size === 0}>Salvar dia</button>
      </form>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
