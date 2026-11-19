import { AccountListResponse, SchoolSettings } from "@app-lanche/contracts";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { Alert, Button, Card, CardBody, CardHeader, Col, Form, FormGroup, Input, Label, Row, Table } from "reactstrap";
import { apiFetch } from "../../app/api";
import { PageTitle } from "../../theme/layout/PageTitle";
import { announce, StatusNotice } from "../../theme/notify";
import { StatusBadge } from "../../theme/StatusBadge";
import { formatCents } from "../../ui/money";
import { centsToInput, filterAccounts, formatDayTime, parseLimitCents } from "./accounts";
import { useAdminMe } from "./AdminLayout";
import { useStaffErrors } from "./useStaffErrors";

function DebtLimitCard({ canEdit, onSaved }: { canEdit: boolean; onSaved: () => void }) {
  const { error, setError, fail } = useStaffErrors();
  const [limit, setLimit] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    apiFetch("/api/admin/v1/school/settings", SchoolSettings).then((s) => {
      setLimit(s.debtLimitCents);
      setText(centsToInput(s.debtLimitCents));
    }, fail);
  }, [fail]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setStatus(null);
    const cents = parseLimitCents(text);
    if (cents === null) {
      setError("Informe um valor em reais, por exemplo 50,00.");
      return;
    }
    try {
      const saved = await apiFetch("/api/admin/v1/school/settings", SchoolSettings, { method: "PUT", body: { debtLimitCents: cents } });
      setLimit(saved.debtLimitCents);
      setStatus("Limite salvo.");
      announce("Limite salvo.");
      onSaved();
    } catch (err) {
      fail(err);
    }
  }

  return (
    <Card tag="section" className="main-card mb-3">
      <CardHeader tag="h2" className="h6 mb-0">Limite de débito</CardHeader>
      <CardBody>
        <StatusNotice message={status} />
        {error && <Alert color="danger" fade={false}>{error}</Alert>}
        {limit === null ? (
          <p className="mb-0">Carregando…</p>
        ) : canEdit ? (
          <Form onSubmit={save} className="d-flex gap-2 align-items-end flex-wrap">
            <FormGroup className="mb-0">
              <Label for="debt-limit">Cada responsável pode ficar devendo até (R$)</Label>
              <Input id="debt-limit" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} />
            </FormGroup>
            <Button color="primary" type="submit">Salvar limite</Button>
          </Form>
        ) : (
          <p className="mb-0">Cada responsável pode ficar devendo até {formatCents(limit)}.</p>
        )}
      </CardBody>
    </Card>
  );
}

export function AccountsAdmin() {
  const { me } = useAdminMe();
  const { error, fail } = useStaffErrors();
  const [data, setData] = useState<AccountListResponse | null>(null);
  const [query, setQuery] = useState("");
  const [onlyDebt, setOnlyDebt] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await apiFetch("/api/admin/v1/accounts", AccountListResponse));
    } catch (err) {
      fail(err);
    }
  }, [fail]);
  useEffect(() => void load(), [load]);

  const office = me?.role === "admin" || me?.role === "secretaria";
  const rows = data ? filterAccounts(data.accounts, { query, onlyDebt }) : [];

  return (
    <>
      <PageTitle
        heading="Contas"
        subheading="Saldos, débitos e pagamentos por Pix."
        icon="pe-7s-cash"
        actions={office ? <Link className="btn btn-primary" to="/admin/contas/lancar">Lançar no balcão</Link> : undefined}
      />
      {error && <Alert color="danger" fade={false}>{error}</Alert>}
      {data && data.overLimitSales.length > 0 && (
        <Alert color="warning" fade={false} data-testid="over-limit-alert">
          <p className="mb-1 fw-semibold">Lançamentos acima do limite de débito nos últimos 7 dias</p>
          <ul className="mb-0">
            {data.overLimitSales.map((s) => (
              <li key={s.saleId}>
                {formatDayTime(s.occurredAt)} · {s.studentFirstName} (conta de <Link to={`/admin/contas/${s.guardianId}`}>{s.guardianFirstName}</Link>) ·{" "}
                {formatCents(s.totalCents)}
              </li>
            ))}
          </ul>
        </Alert>
      )}
      <DebtLimitCard canEdit={me?.role === "admin"} onSaved={() => void load()} />
      <Card className="main-card mb-3">
        <CardBody>
          <Row className="g-2 mb-3">
            <Col md={8}>
              <Label for="accounts-query">Buscar responsável ou aluno</Label>
              <Input id="accounts-query" type="search" value={query} onChange={(e) => setQuery(e.target.value)} />
            </Col>
            <Col md={4} className="d-flex align-items-end">
              <FormGroup check className="mb-2">
                <Input id="accounts-debt" type="checkbox" checked={onlyDebt} onChange={(e) => setOnlyDebt(e.target.checked)} />
                <Label check for="accounts-debt">Só com débito</Label>
              </FormGroup>
            </Col>
          </Row>
          {!data ? (
            <p className="mb-0">Carregando…</p>
          ) : rows.length === 0 ? (
            <p className="mb-0">Nenhum responsável neste filtro.</p>
          ) : (
            <Table responsive hover striped className="mb-0">
              <thead>
                <tr><th>Responsável</th><th>Alunos</th><th>Saldo</th></tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.guardianId}>
                    <td><Link to={`/admin/contas/${a.guardianId}`}>{a.firstName}</Link></td>
                    <td>{a.students.join(", ") || "—"}</td>
                    <td>
                      {a.balanceCents < 0 ? (
                        <StatusBadge tone={a.balanceCents < -data.debtLimitCents ? "danger" : "warning"}>débito {formatCents(-a.balanceCents)}</StatusBadge>
                      ) : (
                        formatCents(a.balanceCents)
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
