import { GuardianServiceDayListResponse, MeResponse } from "@app-lanche/contracts";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ApiError, apiFetch } from "../../app/api";
import { errorMessage } from "../../ui/messages";
import { formatCents } from "../../ui/money";
import { DayOrder } from "./DayOrder";

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

  if (error) return <main><p role="alert">{error}</p></main>;
  if (!me || !days) return <main><p>Carregando…</p></main>;
  const day = days.find((d) => d.serviceDate === selected);

  return (
    <main>
      <h1>Olá, {me.guardian.firstName}</h1>
      <p>
        Saldo na carteira: {formatCents(me.walletBalanceCents)} · <Link to="/carteira">Minha carteira</Link>
      </p>
      {days.length === 0 ? (
        <p>Nenhum dia aberto para pedidos no momento.</p>
      ) : (
        <>
          <label>
            Dia{" "}
            <select value={selected ?? ""} onChange={(e) => setSelected(e.target.value)}>
              {days.map((d) => (
                <option key={d.serviceDate} value={d.serviceDate}>
                  {d.serviceDate.split("-").reverse().join("/")}
                </option>
              ))}
            </select>
          </label>
          {day && <DayOrder day={day} me={me} />}
        </>
      )}
    </main>
  );
}
