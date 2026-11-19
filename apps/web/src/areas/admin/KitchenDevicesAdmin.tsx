import { KitchenDeviceListResponse, PairingCodeResponse } from "@app-lanche/contracts";
import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Card, CardBody, CardHeader, Table } from "reactstrap";
import { z } from "zod";
import { ApiError, apiFetch } from "../../app/api";
import { StatusBadge } from "../../theme/StatusBadge";
import { staffErrorMessage } from "../../ui/messages";

/** `onLoaded`: chamado uma vez quando a primeira carga termina (a página inicial rola de novo até a âncora pedida). */
export function KitchenDevicesAdmin({ onLoaded }: { onLoaded?: () => void }) {
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

  useEffect(() => void load().finally(() => onLoaded?.()), [load, onLoaded]);

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
    <Card tag="section" id="tablets" className="main-card mb-3">
      <CardHeader tag="h2" className="h6 mb-0">
        Tablets da cozinha
      </CardHeader>
      <CardBody>
        <Button color="primary" type="button" onClick={() => void generate()}>
          Gerar código de pareamento
        </Button>
        {code && (
          <div className="border rounded bg-light p-3 my-3">
            <p className="mb-0">
              <strong className="fs-4 font-monospace">{code.code}</strong> — Digite este código no tablet da cozinha, em /kds. Vale até{" "}
              {new Date(code.expiresAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}.
            </p>
          </div>
        )}
        {error && (
          <Alert color="danger" fade={false} className="mt-3">
            {error}
          </Alert>
        )}
        {devices.length === 0 ? (
          <p className="mt-3 mb-0">Nenhum tablet cadastrado.</p>
        ) : (
          <Table responsive hover striped className="mt-3 mb-0">
            <thead>
              <tr>
                <th>Tablet</th>
                <th>Situação</th>
                <th>
                  <span className="visually-hidden">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d.id}>
                  <td>Tablet de {new Date(d.createdAt).toLocaleDateString("pt-BR")}</td>
                  <td>
                    <StatusBadge tone={d.revokedAt ? "secondary" : d.paired ? "success" : "warning"}>
                      {d.revokedAt ? "revogado" : d.paired ? "pareado" : "aguardando pareamento"}
                    </StatusBadge>
                  </td>
                  <td className="text-end">
                    {!d.revokedAt && (
                      <Button size="sm" outline color="danger" type="button" onClick={() => void revoke(d.id)}>
                        Revogar
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </CardBody>
    </Card>
  );
}
