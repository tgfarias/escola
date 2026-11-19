import {
  BatchSummary,
  ClassListResponse,
  MissingDataDetails,
  StudentListResponse,
  TEMPLATE_VARIABLE_LABELS,
  Template,
  type TemplateVariable,
} from "@app-lanche/contracts";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Alert, Button, Card, CardBody, CardHeader, Form, FormGroup, Input, Label } from "reactstrap";
import { ApiError, apiFetch } from "../../app/api";
import { PageTitle } from "../../theme/layout/PageTitle";
import { staffErrorMessage } from "../../ui/messages";
import { StudentFilters } from "./StudentsAdmin";
import { filterStudents, studentLabel, type ClassRow, type StudentRow } from "./studentFilter";
import { useRequestKey } from "./useRequestKey";
import { useStaffErrors } from "./useStaffErrors";

const label = (v: string) => TEMPLATE_VARIABLE_LABELS[v as TemplateVariable] ?? v;

type MissingLine = { key: string; studentId: string; guardianId: string | null; variables: string[] };

/**
 * Uma linha por aluno com as variáveis dele (sem repetir por responsável) e uma por responsável com as `responsavel.*`.
 * Aluno sem responsável (guardianId null) fica numa linha sem sufixo.
 */
export function missingLines(missing: MissingDataDetails["missing"]): MissingLine[] {
  const lines: MissingLine[] = [];
  for (const studentId of [...new Set(missing.map((m) => m.studentId))]) {
    const entries = missing.filter((m) => m.studentId === studentId);
    const own = [...new Set(entries.flatMap((m) => (m.guardianId === null ? m.variables : m.variables.filter((v) => !v.startsWith("responsavel.")))))];
    if (own.length > 0) lines.push({ key: `${studentId}-`, studentId, guardianId: null, variables: own });
    for (const m of entries) {
      if (m.guardianId === null) continue;
      const guardianVars = m.variables.filter((v) => v.startsWith("responsavel."));
      if (guardianVars.length > 0) lines.push({ key: `${studentId}-${m.guardianId}`, studentId, guardianId: m.guardianId, variables: guardianVars });
    }
  }
  return lines;
}

export function GenerateBatch() {
  const { templateId } = useParams();
  const navigate = useNavigate();
  const { error, setError, fail } = useStaffErrors();
  const [template, setTemplate] = useState<Template | null>(null);
  const [students, setStudents] = useState<StudentRow[]>([]);
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [classId, setClassId] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [values, setValues] = useState<Record<string, string>>({});
  const [missing, setMissing] = useState<MissingDataDetails["missing"]>([]);
  const [busy, setBusy] = useState(false);
  const createKey = useRequestKey();

  useEffect(() => {
    Promise.all([
      apiFetch(`/api/admin/v1/document-templates/${templateId}`, Template),
      apiFetch("/api/admin/v1/students", StudentListResponse),
      apiFetch("/api/admin/v1/classes", ClassListResponse),
    ]).then(([t, s, c]) => {
      setTemplate(t);
      setStudents(s.students);
      setClasses(c.classes);
    }, fail);
  }, [templateId, fail]);

  if (!template) {
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
  const mark = (ids: string[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  const nameOf = (id: string) => {
    const s = students.find((x) => x.id === id);
    return s ? studentLabel(s) : id;
  };
  const guardianOf = (id: string) => students.flatMap((s) => s.guardians).find((g) => g.id === id)?.firstName ?? id;

  function submit(event: FormEvent) {
    event.preventDefault();
    void createKey.once(async () => {
      setBusy(true);
      setError(null);
      setMissing([]);
      const body = { templateId: template!.id, studentIds: [...selected], fieldValues: values };
      try {
        const batch = await apiFetch("/api/admin/v1/document-batches", BatchSummary, { method: "POST", body, idempotencyKey: createKey.keyFor(body) });
        createKey.succeeded();
        navigate(`/admin/documentos/lotes/${batch.id}`);
      } catch (err) {
        if (err instanceof ApiError && err.code === "document_missing_data") {
          setMissing(MissingDataDetails.safeParse(err.details).data?.missing ?? []);
          setError(staffErrorMessage(err.code));
        } else {
          fail(err);
        }
      } finally {
        setBusy(false);
      }
    });
  }

  return (
    <>
      <PageTitle
        heading={`Gerar: ${template.name}`}
        icon="pe-7s-news-paper"
        actions={<Link className="btn btn-outline-secondary" to="/admin/documentos">Voltar aos documentos</Link>}
      />
      {error && (
        <Alert color="danger" fade={false}>
          <p className="mb-0">{error}</p>
          {missing.length > 0 && (
            <ul className="mt-2 mb-0">
              {missingLines(missing).map((m) => (
                <li key={m.key}>
                  {nameOf(m.studentId)}
                  {m.guardianId ? ` (responsável ${guardianOf(m.guardianId)})` : ""}: {m.variables.map(label).join(", ")}
                </li>
              ))}
            </ul>
          )}
          {missing.length > 0 && (
            <p className="mt-2 mb-0">
              <Link className="alert-link" to="/admin/alunos">Abrir Alunos e responsáveis</Link>
            </p>
          )}
        </Alert>
      )}
      <Form onSubmit={submit}>
        <Card tag="section" className="main-card mb-3">
          <CardHeader tag="h2" className="h6 mb-0">Alunos</CardHeader>
          <CardBody>
            <StudentFilters classes={classes} classId={classId} query={query} onClass={setClassId} onQuery={setQuery} />
            <div className="d-flex flex-wrap gap-2 mb-2">
              <Button size="sm" outline color="primary" type="button" disabled={classId === ""} onClick={() => mark(students.filter((s) => s.classId === classId).map((s) => s.id), true)}>
                Marcar turma
              </Button>
              <Button size="sm" outline color="primary" type="button" onClick={() => mark(students.map((s) => s.id), true)}>
                Marcar todos
              </Button>
              <Button size="sm" outline color="secondary" type="button" onClick={() => setSelected(new Set())}>
                Desmarcar todos
              </Button>
            </div>
            <p>{selected.size} aluno(s) marcado(s)</p>
            <ul className="list-unstyled mb-0">
              {visible.map((s) => (
                <li key={s.id}>
                  <FormGroup check>
                    <Input id={`pick-${s.id}`} type="checkbox" checked={selected.has(s.id)} onChange={(e) => mark([s.id], e.target.checked)} />
                    <Label check for={`pick-${s.id}`}>{studentLabel(s)} — {s.className}</Label>
                  </FormGroup>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
        {template.fields.length > 0 && (
          <Card tag="section" className="main-card mb-3">
            <CardHeader tag="h2" className="h6 mb-0">Campos do lote</CardHeader>
            <CardBody>
              {template.fields.map((f) => (
                <FormGroup key={f.key}>
                  <Label for={`value-${f.key}`}>{f.label}</Label>
                  <Input
                    id={`value-${f.key}`}
                    type={f.type === "data" ? "date" : "text"}
                    required
                    maxLength={200}
                    value={values[f.key] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  />
                </FormGroup>
              ))}
            </CardBody>
          </Card>
        )}
        <Button color="primary" size="lg" type="submit" disabled={busy || selected.size === 0}>
          Gerar documentos
        </Button>
      </Form>
    </>
  );
}
