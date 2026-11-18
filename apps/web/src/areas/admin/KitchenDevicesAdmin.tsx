import { KitchenDeviceListResponse, PairingCodeResponse } from "@app-lanche/contracts";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { ApiError, apiFetch } from "../../app/api";
import { staffErrorMessage } from "../../ui/messages";

export function KitchenDevicesAdmin() {
  const [devices, setDevices] = useState<KitchenDeviceListResponse["devices"]>([]);
  const [code, setCode] = useState<PairingCodeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDevices((await apiFetch("/api/admin/v1/kds/devices", KitchenDeviceListResponse)).devices);
    } catch (err) {
      setError(staffErrorMessage(err instanceof ApiError ? err.code : "internal_error"));
    }
  }, []);

  useEffect(() => void load(), [load]);

  async function generate() {
    setError(null);
    try {
      setCode(await apiFetch("/api/admin/v1/kds/pairing-codes", PairingCodeResponse, { method: "POST", idempotencyKey: crypto.randomUUID() }));
      await load();
    } catch (err) {
      setError(staffErrorMessage(err instanceof ApiError ? err.code : "internal_error"));
    }
  }

  async function revoke(id: string) {
    if (!window.confirm("Revogar este tablet? Ele deixa de sincronizar na hora.")) return;
    try {
      await apiFetch(`/api/admin/v1/kds/devices/${id}/revoke`, z.undefined(), { method: "POST" });
      await load();
    } catch (err) {
      setError(staffErrorMessage(err instanceof ApiError ? err.code : "internal_error"));
    }
  }

  return (
    <section>
      <h2>Tablets da cozinha</h2>
      <button type="button" onClick={() => void generate()}>Gerar código de pareamento</button>
      {code && (
        <p>
          <strong>{code.code}</strong> — Digite este código no tablet da cozinha, em /kds. Vale até{" "}
          {new Date(code.expiresAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <ul>
        {devices.map((d) => (
          <li key={d.id}>
            Tablet de {new Date(d.createdAt).toLocaleDateString("pt-BR")} —{" "}
            {d.revokedAt ? "revogado" : d.paired ? "pareado" : "aguardando pareamento"}
            {!d.revokedAt && (
              <button type="button" onClick={() => void revoke(d.id)}>Revogar</button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
