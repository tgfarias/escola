import { useState } from "react";
import { Alert, Button, Card, CardBody, CardHeader, Input, Label, Nav, NavItem, NavLink, Table } from "reactstrap";
import { StatusBadge } from "../../theme/StatusBadge";
import { canSell, cartLines, cartTotal, filterRoster, MAX_QTY, OVER_LIMIT_TEXT, setQty, type Cart, type RosterItem, type RosterRow, type SaleLine } from "../../ui/counter";
import { formatCents } from "../../ui/money";
import type { CounterSaleRow } from "./db";

const STATUS: Record<CounterSaleRow["status"], { tone: "warning" | "success" | "danger"; label: string }> = {
  pending: { tone: "warning", label: "pendente" },
  accepted: { tone: "success", label: "enviado" },
  rejected: { tone: "danger", label: "recusado" },
};

export type CounterViewProps = {
  roster: RosterRow[];
  items: RosterItem[];
  limitCents: number;
  sales: CounterSaleRow[];
  /** Dia local de hoje: o servidor recusa estornar lançamento de outro dia, então o "Desfazer" some. */
  today: string;
  onSell: (studentId: string, lines: SaleLine[]) => Promise<void>;
  onUndo: (saleId: string) => Promise<void>;
};

export function CounterView({ roster, items, limitCents, sales, today, onSell, onUndo }: CounterViewProps) {
  const [query, setQuery] = useState("");
  const [className, setClassName] = useState<string | null>(null);
  const [studentId, setStudentId] = useState<string | null>(null);
  const [cart, setCart] = useState<Cart>({});
  const [busy, setBusy] = useState(false);

  const classes = [...new Set(roster.map((r) => r.className))].sort((a, b) => a.localeCompare(b));
  const visible = filterRoster(roster, { query, className }).sort((a, b) => a.firstName.localeCompare(b.firstName));
  const student = roster.find((r) => r.studentId === studentId) ?? null;
  const lines = cartLines(cart, items);
  const total = cartTotal(cart, items);
  const after = (student?.balanceCents ?? 0) - total;
  const overLimit = !!student?.guardianId && total > 0 && !canSell(student.balanceCents, total, limitCents);
  const allowed = !!student?.guardianId && lines.length > 0 && lines.length <= 10 && canSell(student.balanceCents, total, limitCents);

  function choose(id: string) {
    setStudentId(id);
    setCart({});
  }

  async function sell() {
    if (!student || !allowed) return;
    setBusy(true);
    try {
      await onSell(student.studentId, lines);
      setCart({});
      setStudentId(null);
      setQuery("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="kds-counter">
      <Card className="main-card mb-3">
        <CardHeader tag="h2" className="h6 mb-0">
          Aluno
        </CardHeader>
        <CardBody>
          <Label for="kds-counter-search">Buscar aluno</Label>
          <Input id="kds-counter-search" data-testid="kds-counter-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} />
          <div role="group" aria-label="Filtrar por turma" className="my-2">
            <Nav pills>
              <NavItem>
                <NavLink tag="button" type="button" active={className === null} aria-pressed={className === null} onClick={() => setClassName(null)}>
                  Todas as turmas
                </NavLink>
              </NavItem>
              {classes.map((c) => (
                <NavItem key={c}>
                  <NavLink tag="button" type="button" active={className === c} aria-pressed={className === c} onClick={() => setClassName(c)}>
                    {c}
                  </NavLink>
                </NavItem>
              ))}
            </Nav>
          </div>
          <ul className="kds-grid">
            {visible.map((r) => (
              <li key={r.studentId}>
                <button
                  type="button"
                  className={r.studentId === studentId ? "kds-card is-delivered" : "kds-card"}
                  data-testid={`kds-counter-student-${r.studentId}`}
                  aria-pressed={r.studentId === studentId}
                  onClick={() => choose(r.studentId)}
                >
                  <span className="kds-card__name">{r.firstName}</span>
                  <span className="kds-card__class">{r.className}</span>
                  {r.guardianId ? <span>Saldo: {formatCents(r.balanceCents)}</span> : <span>Sem responsável financeiro</span>}
                </button>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>

      {student && (
        <Card className="main-card mb-3">
          <CardHeader tag="h2" className="h6 mb-0">
            Lançamento para {student.firstName}
          </CardHeader>
          <CardBody>
            <p className="mb-1">{student.guardianFirstName ? `Conta de ${student.guardianFirstName}` : "Sem responsável financeiro: peça à secretaria"}</p>
            {student.restrictions && (
              <p>
                <span className="badge text-bg-warning">Restrição: {student.restrictions}</span>
              </p>
            )}
            <Table responsive className="mb-3">
              <tbody>
                {items.map((i) => {
                  const qty = cart[i.id] ?? 0;
                  return (
                    <tr key={i.id}>
                      <td>{i.name}</td>
                      <td>{formatCents(i.priceCents)}</td>
                      <td className="text-end text-nowrap">
                        <Button
                          color="light"
                          type="button"
                          aria-label={`Menos ${i.name}`}
                          data-testid={`kds-counter-item-${i.id}-minus`}
                          disabled={qty === 0}
                          onClick={() => setCart(setQty(cart, i.id, qty - 1))}
                        >
                          −
                        </Button>{" "}
                        <span className="fs-5 px-2" aria-live="polite">
                          {qty}
                        </span>{" "}
                        <Button
                          color="light"
                          type="button"
                          aria-label={`Mais ${i.name}`}
                          data-testid={`kds-counter-item-${i.id}-plus`}
                          disabled={qty >= MAX_QTY}
                          onClick={() => setCart(setQty(cart, i.id, qty + 1))}
                        >
                          +
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
            <dl className="row mb-3">
              <dt className="col-6">Total</dt>
              <dd className="col-6 text-end">{formatCents(total)}</dd>
              <dt className="col-6">Saldo atual</dt>
              <dd className="col-6 text-end">{formatCents(student.balanceCents)}</dd>
              <dt className="col-6">Saldo depois</dt>
              <dd className="col-6 text-end" data-testid="kds-counter-balance-after">
                {formatCents(after)}
              </dd>
            </dl>
            {overLimit && (
              <p role="alert" className="text-danger fw-semibold" data-testid="kds-counter-over-limit">
                {OVER_LIMIT_TEXT}
              </p>
            )}
            <Button color="primary" size="lg" type="button" data-testid="kds-counter-submit" disabled={!allowed || busy} onClick={() => void sell()}>
              Lançar
            </Button>
          </CardBody>
        </Card>
      )}

      <Card className="main-card mb-3">
        <CardHeader tag="h2" className="h6 mb-0">
          Lançamentos de hoje
        </CardHeader>
        <CardBody>
          {sales.length === 0 ? (
            <p className="mb-0">Nenhum lançamento hoje neste tablet.</p>
          ) : (
            <Table responsive hover striped className="mb-0">
              <tbody>
                {sales.map((s) => (
                  <tr key={s.saleId} data-testid={`kds-counter-sale-${s.saleId}`}>
                    <td>{s.studentFirstName}</td>
                    <td>{s.lines.map((l) => `${l.qty}x ${l.name}`).join(", ")}</td>
                    <td>{formatCents(s.totalCents)}</td>
                    <td>
                      <StatusBadge tone={s.voided ? "secondary" : STATUS[s.status].tone}>{s.voided ? "estornado" : STATUS[s.status].label}</StatusBadge>
                    </td>
                    <td className="text-end">
                      {!s.voided && s.status !== "rejected" && s.serviceDate === today && (
                        <Button
                          size="sm"
                          outline
                          color="danger"
                          type="button"
                          data-testid={`kds-counter-undo-${s.saleId}`}
                          onClick={() => {
                            if (window.confirm(`Desfazer o lançamento de ${s.studentFirstName}?`)) void onUndo(s.saleId);
                          }}
                        >
                          Desfazer
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
      {roster.length === 0 && (
        <Alert color="secondary" fade={false}>
          Sem lista de alunos.
        </Alert>
      )}
    </div>
  );
}
