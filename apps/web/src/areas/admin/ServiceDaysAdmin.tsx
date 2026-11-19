import {
  ManifestResponse,
  MenuItemListResponse,
  ServiceDay as ServiceDaySchema,
  ServiceDayListResponse,
  type MenuItem,
  type ServiceDay,
} from "@app-lanche/contracts";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Alert, Button, Card, CardBody, CardHeader, Col, Form, FormGroup, Input, Label, Row, Table } from "reactstrap";
import { ApiError, apiFetch } from "../../app/api";
import { announce, StatusNotice } from "../../theme/notify";
import { StatusBadge } from "../../theme/StatusBadge";
import { staffErrorMessage } from "../../ui/messages";
import { formatCents } from "../../ui/money";

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

/** `onLoaded`: chamado uma vez quando a primeira carga termina (a página inicial rola de novo até a âncora pedida). */
export function ServiceDaysAdmin({ onLoaded }: { onLoaded?: () => void }) {
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
    void Promise.allSettled([
      reload(),
      apiFetch("/api/admin/v1/menu-items", MenuItemListResponse).then((res) => setMenu(res.items), fail),
    ]).then(() => onLoaded?.());
  }, [reload, onLoaded]);

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
      const message = `Dia fechado: ${manifest.totals.orders} pedidos.`;
      setNotice(message);
      announce(message);
      await reload();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card tag="section" id="dias" className="main-card mb-3">
      <CardHeader tag="h2" className="h6 mb-0">
        Dias de serviço
      </CardHeader>
      <CardBody>
        {days.length === 0 ? (
          <p>Nenhum dia de serviço aberto.</p>
        ) : (
          <Table responsive hover striped className="mb-4">
            <thead>
              <tr>
                <th>Data</th>
                <th>Corte</th>
                <th>Situação</th>
                <th>Itens</th>
                <th>
                  <span className="visually-hidden">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.serviceDate}>
                  <td>{formatDate(d.serviceDate)}</td>
                  <td>{formatTime(d.cutoffAt)}</td>
                  <td>
                    <StatusBadge tone={d.status === "open" ? "success" : "secondary"}>
                      {d.status === "open" ? "Aberto" : "Fechado"}
                    </StatusBadge>
                  </td>
                  <td>
                    <ul className="list-unstyled mb-0">
                      {d.items.map((i) => (
                        <li key={i.menuItemId}>{`${i.name} — ${formatCents(i.priceCents)}`}</li>
                      ))}
                    </ul>
                  </td>
                  <td className="text-end">
                    {d.status === "open" && (
                      <Button size="sm" outline color="danger" type="button" disabled={busy} onClick={() => close(d)}>
                        Fechar dia
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <Form onSubmit={save}>
          <h3 className="h6">Abrir dia</h3>
          <Row className="g-2">
            <Col md={4}>
              <FormGroup>
                <Label for="day-date">Data</Label>
                <Input id="day-date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
              </FormGroup>
            </Col>
            <Col md={4}>
              <FormGroup>
                <Label for="day-cutoff">Horário de corte (opcional)</Label>
                <Input id="day-cutoff" type="time" value={cutoff} onChange={(e) => setCutoff(e.target.value)} />
              </FormGroup>
            </Col>
          </Row>
          <fieldset className="mb-3">
            <legend className="fs-6">Itens</legend>
            {menu
              .filter((i) => i.active)
              .map((i) => (
                <FormGroup check inline key={i.id}>
                  <Label check>
                    <Input type="checkbox" checked={selected.has(i.id)} onChange={() => toggleItem(i.id)} /> {i.name}
                  </Label>
                </FormGroup>
              ))}
          </fieldset>
          <Button color="primary" type="submit" disabled={busy || selected.size === 0}>
            Salvar dia
          </Button>
        </Form>
        {error && (
          <Alert color="danger" fade={false} className="mt-3">
            {error}
          </Alert>
        )}
        <StatusNotice message={notice} />
      </CardBody>
    </Card>
  );
}
