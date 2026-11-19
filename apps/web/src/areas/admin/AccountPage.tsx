import { AccountStatementResponse, CounterVoidResult, PaymentRequestResponse, TopupView } from "@app-lanche/contracts";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { Alert, Button, Card, CardBody, CardHeader, Form, FormGroup, Input, Label, Table } from "reactstrap";
import { apiFetch } from "../../app/api";
import { PageTitle } from "../../theme/layout/PageTitle";
import { announce, StatusNotice } from "../../theme/notify";
import { StatusBadge } from "../../theme/StatusBadge";
import { formatCents, parsePriceToCents } from "../../ui/money";
import { entryLabel } from "../../ui/walletLabels";
import { centsToInput, formatDayTime } from "./accounts";
import { useAdminMe } from "./AdminLayout";
import { PixPanel } from "./PixPanel";
import { useRequestKey } from "./useRequestKey";
import { useStaffErrors } from "./useStaffErrors";

export function AccountPage() {
  const { guardianId } = useParams();
  const { me } = useAdminMe();
  const { error, setError, fail } = useStaffErrors();
  const [data, setData] = useState<AccountStatementResponse | null>(null);
  const [amount, setAmount] = useState("");
  const [topup, setTopup] = useState<TopupView | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const qr = useRequestKey();
  const link = useRequestKey();
  const voiding = useRequestKey(); // só o guarda de clique: o estorno é naturalmente idempotente, sem chave

  const load = useCallback(async () => {
    try {
      const d = await apiFetch(`/api/admin/v1/guardians/${guardianId}/statement`, AccountStatementResponse);
      setData(d);
      setAmount((current) => current || (d.balanceCents < 0 ? centsToInput(-d.balanceCents) : ""));
    } catch (err) {
      fail(err);
    }
  }, [guardianId, fail]);
  useEffect(() => void load(), [load]);

  const office = me?.role === "admin" || me?.role === "secretaria";
  function done(message: string) {
    setStatus(message);
    announce(message);
  }

  async function generateQr(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const cents = parsePriceToCents(amount);
    if (cents === null) {
      setError("Informe um valor em reais, por exemplo 13,50.");
      return;
    }
    const body = { amountCents: cents };
    await qr.once(async () => {
      try {
        setTopup(await apiFetch(`/api/admin/v1/guardians/${guardianId}/topups`, TopupView, { method: "POST", body, idempotencyKey: qr.keyFor(body) }));
        qr.succeeded();
      } catch (err) {
        fail(err);
      }
    });
  }

  async function sendLink() {
    setError(null);
    await link.once(async () => {
      try {
        const r = await apiFetch(`/api/admin/v1/guardians/${guardianId}/payment-requests`, PaymentRequestResponse, {
          method: "POST",
          idempotencyKey: link.keyFor({ guardianId, balance: data?.balanceCents }),
        });
        link.succeeded();
        done(`Link de pagamento de ${formatCents(r.amountDueCents)} enviado para o WhatsApp do responsável.`);
      } catch (err) {
        fail(err);
      }
    });
  }

  async function voidSale(saleId: string) {
    await voiding.once(async () => {
      if (!window.confirm("Estornar este lançamento? O valor volta para a conta.")) return;
      setError(null);
      try {
        await apiFetch(`/api/admin/v1/counter-sales/${saleId}/void`, CounterVoidResult, { method: "POST" });
        done("Lançamento estornado.");
        await load();
      } catch (err) {
        fail(err);
      }
    });
  }

  if (!data) return error ? <Alert color="danger" fade={false}>{error}</Alert> : <p>Carregando…</p>;
  const debt = data.balanceCents < 0;

  return (
    <>
      <PageTitle
        heading={`Conta de ${data.guardian.firstName}`}
        subheading="Extrato e pagamentos por Pix."
        icon="pe-7s-cash"
        actions={<Link className="btn btn-outline-secondary" to="/admin/contas">Voltar</Link>}
      />
      <StatusNotice message={status} />
      {error && <Alert color="danger" fade={false}>{error}</Alert>}
      <Card className="main-card mb-3">
        <CardBody>
          <p className="fs-5 mb-1">
            {debt ? <strong className="text-danger">Débito: {formatCents(-data.balanceCents)}</strong> : <>Saldo: {formatCents(data.balanceCents)}</>}
          </p>
          <p className="mb-3">Limite de débito da escola: {formatCents(data.debtLimitCents)}.</p>
          {debt && (
            <Button color="primary" outline type="button" onClick={() => void sendLink()}>
              Enviar link de pagamento por WhatsApp
            </Button>
          )}
        </CardBody>
      </Card>
      <Card tag="section" className="main-card mb-3">
        <CardHeader tag="h2" className="h6 mb-0">Pagamento por Pix na tela</CardHeader>
        <CardBody>
          <Form onSubmit={generateQr} className="d-flex gap-2 align-items-end flex-wrap">
            <FormGroup className="mb-0">
              <Label for="pix-amount">Valor do Pix (R$)</Label>
              <Input id="pix-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </FormGroup>
            <Button color="primary" type="submit">Gerar QR de pagamento</Button>
          </Form>
          {topup && (
            <PixPanel
              initial={topup}
              onPaid={() => {
                done("Pagamento recebido.");
                void load();
              }}
            />
          )}
        </CardBody>
      </Card>
      <Card tag="section" className="main-card mb-3">
        <CardHeader tag="h2" className="h6 mb-0">Extrato</CardHeader>
        <CardBody>
          {data.entries.length === 0 ? (
            <p className="mb-0">Nenhum lançamento.</p>
          ) : (
            <Table responsive hover striped className="mb-0">
              <thead>
                <tr><th>Data</th><th>Lançamento</th><th>Valor</th><th>Situação</th><th><span className="visually-hidden">Ações</span></th></tr>
              </thead>
              <tbody>
                {data.entries.map((e) => (
                  <tr key={e.id}>
                    <td>{formatDayTime(e.createdAt)}</td>
                    <td>{entryLabel(e.kind, e.studentFirstName)}</td>
                    <td>{e.amountCents > 0 ? "+" : ""}{formatCents(e.amountCents)}</td>
                    <td>
                      {e.overLimit && <StatusBadge tone="danger">acima do limite</StatusBadge>}{" "}
                      {e.kind === "counter_charge" && e.voided && <StatusBadge tone="secondary">estornado</StatusBadge>}
                    </td>
                    <td className="text-end">
                      {office && e.kind === "counter_charge" && !e.voided && e.saleId && (
                        <Button size="sm" outline color="danger" type="button" aria-label={`Estornar lançamento de ${e.studentFirstName ?? ""}`} onClick={() => void voidSale(e.saleId!)}>
                          Estornar
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
    </>
  );
}
