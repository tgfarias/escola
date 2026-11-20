import { GuardianServiceDayListResponse, MeResponse } from "@app-lanche/contracts";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ApiError, apiFetch } from "../../app/api";
import { errorMessage } from "../../ui/messages";
import { formatCents } from "../../ui/money";
import { DayOrder } from "./DayOrder";
import { GuardianPending, GuardianShell } from "./GuardianShell";

export function OrderHome() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [days, setDays] = useState<GuardianServiceDayListResponse["serviceDays"] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fail = (err: unknown) => setError(errorMessage(err instanceof ApiError ? err.code : "internal_error"));
    apiFetch("/api/v1/me", MeResponse).then(setMe, fail);
    apiFetch("/api/v1/service-days", GuardianServiceDayListResponse).then((r) => {
      setDays(r.serviceDays);
      setSelected(r.serviceDays[0]?.serviceDate ?? null);
    }, fail);
  }, []);

  if (error || !me || !days) return <GuardianPending error={error} />;
  const day = days.find((d) => d.serviceDate === selected);

  return (
    <GuardianShell>
      <h1>Olá, {me.guardian.firstName}</h1>
      <section className="g-card d-flex flex-wrap align-items-center justify-content-between gap-2">
        <span className="fw-semibold">Saldo na carteira: {formatCents(me.walletBalanceCents)}</span>
        <span className="d-flex gap-2">
          <Link className="btn btn-outline-primary btn-sm" to="/carteira">Minha carteira</Link>
          <Link className="btn btn-outline-primary btn-sm" to="/documentos">Documentos</Link>
        </span>
      </section>
      {days.length === 0 ? (
        <p className="g-card g-muted">Nenhum dia aberto para pedidos no momento.</p>
      ) : (
        <>
          <label className="form-label d-block mb-3">
            Dia
            <select className="form-select form-select-lg mt-1" value={selected ?? ""} onChange={(e) => setSelected(e.target.value)}>
              {days.map((d) => (
                <option key={d.serviceDate} value={d.serviceDate}>
                  {d.serviceDate.split("-").reverse().join("/")}
                </option>
              ))}
            </select>
          </label>
          {day && <DayOrder key={day.serviceDate} day={day} me={me} />}
        </>
      )}
    </GuardianShell>
  );
}
