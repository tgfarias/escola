import { ClassListResponse, GuardianDetail, StudentListResponse, formatCpf } from "@app-lanche/contracts";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Alert, Button, Card, CardBody, Col, Form, FormGroup, Input, Label, Row, Table } from "reactstrap";
import { z } from "zod";
import { ApiError, apiFetch } from "../../app/api";
import { PageTitle } from "../../theme/layout/PageTitle";
import { announce, StatusNotice } from "../../theme/notify";
import { StatusBadge } from "../../theme/StatusBadge";
import { formatIsoDate } from "../../ui/dates";
import { filterStudents, studentLabel, type ClassRow, type StudentRow } from "./studentFilter";
import { useStaffErrors } from "./useStaffErrors";

export function StudentFilters(props: { classes: ClassRow[]; classId: string; query: string; onClass: (id: string) => void; onQuery: (q: string) => void }) {
  return (
    <Row className="g-2 mb-3">
      <Col md={4}>
        <Label for="filter-class">Turma</Label>
        <Input id="filter-class" type="select" value={props.classId} onChange={(e) => props.onClass(e.target.value)}>
          <option value="">Todas</option>
          {props.classes.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </Input>
      </Col>
      <Col md={8}>
        <Label for="filter-query">Buscar por nome</Label>
        <Input id="filter-query" type="search" value={props.query} onChange={(e) => props.onQuery(e.target.value)} />
      </Col>
    </Row>
  );
}

type FormProps = { onSubmit: () => void; onSaved: () => Promise<void>; onCancel: () => void; onError: (err: unknown) => void };

/** Só dígitos, no máximo 11; formatado quando completo. Colar "CPF 111.444.777-35 " não perde dígito. */
function cpfInput(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 11);
  return digits.length === 11 ? formatCpf(digits) : digits;
}

function StudentForm({ student, onSubmit, onSaved, onCancel, onError }: FormProps & { student: StudentRow }) {
  const [fullName, setFullName] = useState(student.fullName ?? "");
  const [birthDate, setBirthDate] = useState(student.birthDate ?? "");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit();
    setBusy(true);
    try {
      await apiFetch(`/api/admin/v1/students/${student.id}`, z.undefined(), {
        method: "PUT",
        body: { fullName: fullName.trim() || null, birthDate: birthDate || null },
      });
      await onSaved();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="main-card mb-3">
      <CardBody>
        <Form onSubmit={submit}>
          <h2 className="h6">{student.firstName} — {student.className}</h2>
          <Row className="g-2">
            <Col md={8}>
              <FormGroup>
                <Label for="student-full-name">Nome completo</Label>
                <Input id="student-full-name" maxLength={200} value={fullName} onChange={(e) => setFullName(e.target.value)} />
              </FormGroup>
            </Col>
            <Col md={4}>
              <FormGroup>
                <Label for="student-birth-date">Data de nascimento</Label>
                <Input id="student-birth-date" type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} />
              </FormGroup>
            </Col>
          </Row>
          <div className="d-flex gap-2">
            <Button color="primary" type="submit" disabled={busy}>Salvar</Button>
            <Button color="secondary" outline type="button" onClick={onCancel}>Cancelar</Button>
          </div>
        </Form>
      </CardBody>
    </Card>
  );
}

function GuardianForm({ guardianId, onSubmit, onSaved, onCancel, onError }: FormProps & { guardianId: string }) {
  const [detail, setDetail] = useState<GuardianDetail | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [fullName, setFullName] = useState("");
  const [cpf, setCpf] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiFetch(`/api/admin/v1/guardians/${guardianId}`, GuardianDetail).then(
      (d) => {
        setDetail(d);
        setFullName(d.fullName ?? "");
        setCpf(d.cpf ? formatCpf(d.cpf) : "");
      },
      (err: unknown) => {
        // Sessão vencida segue para o login; o resto vira a mensagem do próprio formulário.
        if (err instanceof ApiError && err.status === 401) onError(err);
        else setLoadFailed(true);
      },
    );
  }, [guardianId, onError]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit();
    setBusy(true);
    try {
      await apiFetch(`/api/admin/v1/guardians/${guardianId}`, z.undefined(), {
        method: "PUT",
        body: { fullName: fullName.trim() || null, cpf: cpf.trim() || null },
      });
      await onSaved();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  if (loadFailed) {
    return (
      <Alert color="danger" fade={false}>
        Não foi possível carregar o responsável.
      </Alert>
    );
  }
  if (!detail) return <p>Carregando…</p>;
  return (
    <Card className="main-card mb-3">
      <CardBody>
        <Form onSubmit={submit}>
          <h2 className="h6">Responsável: {detail.firstName}</h2>
          <Row className="g-2">
            <Col md={8}>
              <FormGroup>
                <Label for="guardian-full-name">Nome completo do responsável</Label>
                <Input id="guardian-full-name" maxLength={200} value={fullName} onChange={(e) => setFullName(e.target.value)} />
              </FormGroup>
            </Col>
            <Col md={4}>
              <FormGroup>
                <Label for="guardian-cpf">CPF</Label>
                <Input id="guardian-cpf" inputMode="numeric" autoComplete="off" value={cpf} onChange={(e) => setCpf(cpfInput(e.target.value))} />
              </FormGroup>
            </Col>
          </Row>
          <div className="d-flex gap-2">
            <Button color="primary" type="submit" disabled={busy}>Salvar</Button>
            <Button color="secondary" outline type="button" onClick={onCancel}>Cancelar</Button>
          </div>
        </Form>
      </CardBody>
    </Card>
  );
}

export function StudentsAdmin() {
  const { error, setError, fail } = useStaffErrors();
  const [students, setStudents] = useState<StudentRow[] | null>(null);
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [classId, setClassId] = useState("");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<{ kind: "student"; student: StudentRow } | { kind: "guardian"; id: string } | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([
        apiFetch("/api/admin/v1/students", StudentListResponse),
        apiFetch("/api/admin/v1/classes", ClassListResponse),
      ]);
      setStudents(s.students);
      setClasses(c.classes);
    } catch (err) {
      fail(err);
    }
  }, [fail]);

  useEffect(() => void load(), [load]);

  function edit(next: typeof editing) {
    setStatus(null);
    setError(null);
    setEditing(next);
  }

  async function saved() {
    setEditing(null);
    setError(null);
    setStatus("Dados salvos.");
    announce("Dados salvos.");
    await load();
  }

  async function makeFinancial(studentId: string, guardianId: string) {
    setStatus(null);
    setError(null);
    try {
      await apiFetch(`/api/admin/v1/students/${studentId}/financial-guardian`, z.undefined(), { method: "PUT", body: { guardianId } });
      setStatus("Responsável financeiro alterado.");
      announce("Responsável financeiro alterado.");
      await load();
    } catch (err) {
      fail(err);
    }
  }

  if (!students) {
    return (
      <div>
        {error ? (
          <Alert color="danger" fade={false}>
            {error}
          </Alert>
        ) : (
          <p>Carregando…</p>
        )}
      </div>
    );
  }
  const visible = filterStudents(students, { classId, query });
  const formProps = {
    onSubmit: () => {
      setStatus(null);
      setError(null);
    },
    onSaved: saved,
    onCancel: () => {
      setEditing(null);
      setError(null);
    },
    onError: fail,
  };

  return (
    <>
      <PageTitle heading="Alunos e responsáveis" subheading="Nome completo, nascimento e CPF usados nos documentos; responsável financeiro de cada aluno." icon="pe-7s-users" />
      <StatusNotice message={status} />
      {error && (
        <Alert color="danger" fade={false}>
          {error}
        </Alert>
      )}
      {editing?.kind === "student" && <StudentForm key={editing.student.id} student={editing.student} {...formProps} />}
      {editing?.kind === "guardian" && <GuardianForm key={editing.id} guardianId={editing.id} {...formProps} />}
      <Card className="main-card mb-3">
        <CardBody>
          <StudentFilters classes={classes} classId={classId} query={query} onClass={setClassId} onQuery={setQuery} />
          <Table responsive hover striped className="mb-0">
            <thead>
              <tr><th>Aluno</th><th>Turma</th><th>Nascimento</th><th>Responsáveis</th></tr>
            </thead>
            <tbody>
              {visible.map((s) => (
                <tr key={s.id}>
                  <td>
                    <span>{studentLabel(s)}</span>{" "}
                    <Button size="sm" color="link" type="button" aria-label={`Editar aluno ${studentLabel(s)}`} onClick={() => edit({ kind: "student", student: s })}>
                      Editar
                    </Button>
                  </td>
                  <td>{s.className}</td>
                  <td>{s.birthDate ? formatIsoDate(s.birthDate) : "—"}</td>
                  <td>
                    {s.guardians.length === 0 ? (
                      <span>Nenhum responsável</span>
                    ) : (
                      <ul className="list-unstyled mb-0">
                        {s.guardians.map((g) => (
                          <li key={g.id}>
                            {g.fullName ?? g.firstName} — {g.cpfMasked ?? "CPF não informado"}{" "}
                            <Button size="sm" color="link" type="button" aria-label={`Editar responsável ${g.firstName}`} onClick={() => edit({ kind: "guardian", id: g.id })}>
                              Editar
                            </Button>
                            {g.financial ? (
                              <StatusBadge tone="success">financeiro</StatusBadge>
                            ) : (
                              <Button
                                size="sm"
                                color="link"
                                type="button"
                                aria-label={`Tornar ${g.firstName} responsável financeiro de ${studentLabel(s)}`}
                                onClick={() => void makeFinancial(s.id, g.id)}
                              >
                                Tornar financeiro
                              </Button>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </CardBody>
      </Card>
    </>
  );
}
