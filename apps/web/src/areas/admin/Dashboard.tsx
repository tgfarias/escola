import { DashboardResponse, type DashboardPeriod, type StaffRole } from "@app-lanche/contracts";
import { useEffect, useState, type ReactNode } from "react";
import { Alert, Button, ButtonGroup, Card, CardBody, CardHeader, Col, Row } from "reactstrap";
import { apiFetch } from "../../app/api";
import { formatCents } from "../../ui/money";
import { useStaffErrors } from "./useStaffErrors";

const PERIODS: { value: DashboardPeriod; label: string }[] = [
  { value: "today", label: "Hoje" },
  { value: "7d", label: "7 dias" },
  { value: "month", label: "Mês" },
];
const HIDDEN = "R$ ••••";
const br = (iso: string) => iso.split("-").reverse().join("/");

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="d-flex justify-content-between py-1 border-bottom">
      <span>{label}</span>
      <strong>{children}</strong>
    </div>
  );
}

/** Indicadores da página inicial (spec F5C, A.3). Valores em reais começam ocultos a cada montagem. */
export function Dashboard({ role }: { role: StaffRole }) {
  const { error, setError, fail } = useStaffErrors();
  const [period, setPeriod] = useState<DashboardPeriod>("today");
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [showValues, setShowValues] = useState(false);
  const office = role === "admin" || role === "secretaria";

  useEffect(() => {
    let active = true;
    apiFetch(`/api/admin/v1/dashboard?period=${period}`, DashboardResponse).then(
      (res) => {
        if (!active) return;
        setError(null);
        setData(res);
      },
      (err) => active && fail(err),
    );
    return () => {
      active = false;
    };
  }, [period, fail, setError]);

  const money = (cents: number) => (showValues ? formatCents(cents) : HIDDEN);
  const range = data && (data.from === data.to ? `Hoje (${br(data.to)})` : `De ${br(data.from)} a ${br(data.to)}`);

  return (
    <section aria-label="Indicadores">
      <div className="d-flex flex-wrap gap-2 align-items-center mb-3">
        <ButtonGroup aria-label="Período">
          {PERIODS.map((p) => (
            <Button key={p.value} color="primary" outline={p.value !== period} aria-pressed={p.value === period} onClick={() => setPeriod(p.value)}>
              {p.label}
            </Button>
          ))}
        </ButtonGroup>
        {office && (
          <Button color="secondary" outline aria-pressed={showValues} onClick={() => setShowValues((v) => !v)}>
            <i className={showValues ? "pe-7s-look me-1" : "pe-7s-shield me-1"} aria-hidden="true" />
            {showValues ? "Ocultar valores" : "Mostrar valores"}
          </Button>
        )}
        {range && <span className="text-muted">{range}</span>}
      </div>
      {error && (
        <Alert color="danger" fade={false}>
          {error}
        </Alert>
      )}
      {data && (
        <Row>
          <Col lg={4} className="mb-3">
            <Card className="main-card h-100">
              <CardHeader tag="h2" className="h6 mb-0">Lanches</CardHeader>
              <CardBody>
                <Stat label="Pedidos pagos">{data.snacks.paidOrders}</Stat>
                <Stat label="Entregues">{data.snacks.deliveredOrders}</Stat>
                <Stat label="Não retirados">{data.snacks.notCollectedOrders}</Stat>
                <Stat label="Lançamentos no balcão">{data.snacks.counterSales}</Stat>
                <h3 className="h6 mt-3">Mais pedidos</h3>
                {data.snacks.topItems.length === 0 ? (
                  <p className="text-muted mb-0">Nenhum item no período.</p>
                ) : (
                  <ol className="mb-0 ps-3">
                    {data.snacks.topItems.map((i) => (
                      <li key={i.name}>{`${i.name} — ${i.qty}`}</li>
                    ))}
                  </ol>
                )}
              </CardBody>
            </Card>
          </Col>
          {data.documents && (
            <Col lg={4} className="mb-3">
              <Card className="main-card h-100">
                <CardHeader tag="h2" className="h6 mb-0">Documentos</CardHeader>
                <CardBody>
                  <Stat label="Publicados">{data.documents.published}</Stat>
                  <Stat label="Abertos">
                    {data.documents.published === 0
                      ? "—"
                      : `${data.documents.viewed} (${Math.round((data.documents.viewed * 100) / data.documents.published)}%)`}
                  </Stat>
                  <Stat label="Lotes em geração">{data.documents.batchesRendering}</Stat>
                  <Stat label="Lotes com falha">{data.documents.batchesWithFailures}</Stat>
                </CardBody>
              </Card>
            </Col>
          )}
          {data.money && (
            <Col lg={4} className="mb-3">
              <Card className="main-card h-100">
                <CardHeader tag="h2" className="h6 mb-0">Valores</CardHeader>
                <CardBody>
                  <Stat label="Recebido por Pix">{money(data.money.pixReceivedCents)}</Stat>
                  <Stat label="Consumo no balcão">{money(data.money.counterCents)}</Stat>
                  <Stat label="Créditos em carteira">{money(data.money.creditsCents)}</Stat>
                  <Stat label="Débito em aberto">
                    {money(data.money.debtCents)}
                    <span className="fw-normal">{` · ${data.money.debtors} ${data.money.debtors === 1 ? "responsável" : "responsáveis"}`}</span>
                  </Stat>
                </CardBody>
              </Card>
            </Col>
          )}
        </Row>
      )}
    </section>
  );
}
