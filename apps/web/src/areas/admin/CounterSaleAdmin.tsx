import { CounterRosterResponse, CounterSaleResult } from "@app-lanche/contracts";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { Alert, Button, Card, CardBody, Col, FormGroup, Input, Label, Row, Table } from "reactstrap";
import { ApiError, apiFetch } from "../../app/api";
import { PageTitle } from "../../theme/layout/PageTitle";
import { announce, StatusNotice } from "../../theme/notify";
import { canSell, cartLines, cartTotal, filterRoster, MAX_QTY, rosterRows, setQty, type Cart } from "../../ui/counter";
import { formatCents } from "../../ui/money";
import { useRequestKey } from "./useRequestKey";
import { useStaffErrors } from "./useStaffErrors";

/** Lançamento online da secretaria: acima do limite só com confirmação explícita (spec F5B). */
export function CounterSaleAdmin() {
  const { error, setError, fail } = useStaffErrors();
  const [roster, setRoster] = useState<CounterRosterResponse | null>(null);
  const [query, setQuery] = useState("");
  const [studentId, setStudentId] = useState("");
  const [cart, setCart] = useState<Cart>({});
  const [status, setStatus] = useState<string | null>(null);
  // Uma chave por corpo: a venda simples e a confirmada acima do limite. Repetir depois de uma resposta perdida
  // reaproveita a chave de cada uma e o servidor não lança duas vezes.
  const request = useRequestKey();
  const confirmed = useRequestKey();

  const load = useCallback(async () => {
    try {
      setRoster(await apiFetch("/api/admin/v1/counter/roster", CounterRosterResponse));
    } catch (err) {
      fail(err);
    }
  }, [fail]);
  useEffect(() => void load(), [load]);

  if (!roster) return error ? <Alert color="danger" fade={false}>{error}</Alert> : <p>Carregando…</p>;
  const rows = rosterRows(roster, []);
  const visible = filterRoster(rows, { query, className: null }).sort((a, b) => a.firstName.localeCompare(b.firstName));
  const student = rows.find((r) => r.studentId === studentId) ?? null;
  const lines = cartLines(cart, roster.items);
  const total = cartTotal(cart, roster.items);
  const after = (student?.balanceCents ?? 0) - total;
  const overLimit = !!student?.guardianId && total > 0 && !canSell(student.balanceCents, total, roster.debtLimitCents);

  async function submit(allowOverLimit: boolean): Promise<void> {
    if (!student?.guardianId || lines.length === 0) return;
    const body = { studentId: student.studentId, items: lines.map(({ menuItemId, qty }) => ({ menuItemId, qty })), ...(allowOverLimit ? { allowOverLimit: true } : {}) };
    setError(null);
    try {
      const key = (allowOverLimit ? confirmed : request).keyFor(body);
      const r = await apiFetch("/api/admin/v1/counter-sales", CounterSaleResult, { method: "POST", body, idempotencyKey: key });
      request.succeeded();
      confirmed.succeeded();
      const message = `Lançado para ${student.firstName}: ${formatCents(r.totalCents)}. Saldo de ${student.guardianFirstName}: ${formatCents(r.balanceCents)}.`;
      setStatus(message);
      announce(message);
      setCart({});
      setStudentId("");
      await load();
    } catch (err) {
      const limitHit = err instanceof ApiError && err.code === "insufficient_balance";
      if (!allowOverLimit && limitHit && window.confirm(`O saldo de ${student.guardianFirstName} passa do limite de débito (${formatCents(roster!.debtLimitCents)}). Lançar mesmo assim?`)) {
        await submit(true);
        return;
      }
      fail(err);
    }
  }

  return (
    <>
      <PageTitle
        heading="Lançar no balcão"
        subheading="Lançamento na conta do responsável financeiro do aluno."
        icon="pe-7s-cash"
        actions={<Link className="btn btn-outline-secondary" to="/admin/contas">Voltar</Link>}
      />
      <StatusNotice message={status} />
      {error && <Alert color="danger" fade={false}>{error}</Alert>}
      <Card className="main-card mb-3">
        <CardBody>
          <Row className="g-2">
            <Col md={6}>
              <FormGroup>
                <Label for="counter-query">Buscar aluno</Label>
                <Input id="counter-query" type="search" value={query} onChange={(e) => setQuery(e.target.value)} />
              </FormGroup>
            </Col>
            <Col md={6}>
              <FormGroup>
                <Label for="counter-student">Aluno</Label>
                <Input id="counter-student" type="select" value={studentId} onChange={(e) => { setStudentId(e.target.value); setCart({}); }}>
                  <option value="">Escolha…</option>
                  {visible.map((r) => (
                    <option key={r.studentId} value={r.studentId}>
                      {r.firstName} — {r.className} {r.guardianFirstName ? `(conta de ${r.guardianFirstName})` : "(sem responsável financeiro)"}
                    </option>
                  ))}
                </Input>
              </FormGroup>
            </Col>
          </Row>
          {student && (
            <>
              <Table responsive className="mb-3">
                <tbody>
                  {roster.items.map((i) => (
                    <tr key={i.id}>
                      <td><Label for={`qty-${i.id}`} className="mb-0">Quantidade de {i.name}</Label></td>
                      <td>{formatCents(i.priceCents)}</td>
                      <td style={{ width: "8rem" }}>
                        <Input id={`qty-${i.id}`} type="number" min={0} max={MAX_QTY} value={cart[i.id] ?? 0} onChange={(e) => setCart(setQty(cart, i.id, Number(e.target.value)))} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <p className="mb-1">Total: {formatCents(total)} · Saldo atual: {formatCents(student.balanceCents)} · Saldo depois: {formatCents(after)}</p>
              {!student.guardianId && <p className="text-danger">Este aluno não tem responsável financeiro. Defina um em "Alunos e responsáveis".</p>}
              {overLimit && <p className="text-danger">Passa do limite de débito: será pedida confirmação.</p>}
              <Button color="primary" type="button" disabled={!student.guardianId || lines.length === 0} onClick={() => void request.once(() => submit(false))}>
                Lançar
              </Button>
            </>
          )}
        </CardBody>
      </Card>
    </>
  );
}
