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
import { ApiError, apiFetch } from "../../app/api";
import { staffErrorMessage } from "../../ui/messages";
import { StudentFilters } from "./StudentsAdmin";
import { filterStudents, studentLabel, type ClassRow, type StudentRow } from "./studentFilter";
import { useStaffErrors } from "./useStaffErrors";

const label = (v: string) => TEMPLATE_VARIABLE_LABELS[v as TemplateVariable] ?? v;

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

  if (!template) return <main>{error ? <p role="alert">{error}</p> : <p>Carregando…</p>}</main>;

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

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMissing([]);
    try {
      const batch = await apiFetch("/api/admin/v1/document-batches", BatchSummary, {
        method: "POST",
        body: { templateId: template!.id, studentIds: [...selected], fieldValues: values },
        idempotencyKey: crypto.randomUUID(),
      });
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
  }

  return (
    <main>
      <p><Link to="/admin/documentos">Voltar aos documentos</Link></p>
      <h1>Gerar: {template.name}</h1>
      {error && (
        <div role="alert">
          <p>{error}</p>
          {missing.length > 0 && (
            <ul>
              {missing.map((m) => (
                <li key={`${m.studentId}-${m.guardianId}`}>
                  {nameOf(m.studentId)}
                  {m.guardianId ? ` (responsável ${guardianOf(m.guardianId)})` : ""}: {m.variables.map(label).join(", ")}
                </li>
              ))}
            </ul>
          )}
          {missing.length > 0 && <p><Link to="/admin/alunos">Abrir Alunos e responsáveis</Link></p>}
        </div>
      )}
      <form onSubmit={submit}>
        <section>
          <h2>Alunos</h2>
          <StudentFilters classes={classes} classId={classId} query={query} onClass={setClassId} onQuery={setQuery} />
          <button type="button" disabled={classId === ""} onClick={() => mark(students.filter((s) => s.classId === classId).map((s) => s.id), true)}>Marcar turma</button>
          <button type="button" onClick={() => mark(students.map((s) => s.id), true)}>Marcar todos</button>
          <button type="button" onClick={() => setSelected(new Set())}>Desmarcar todos</button>
          <p>{selected.size} aluno(s) marcado(s)</p>
          <ul>
            {visible.map((s) => (
              <li key={s.id}>
                <input id={`pick-${s.id}`} type="checkbox" checked={selected.has(s.id)} onChange={(e) => mark([s.id], e.target.checked)} />
                <label htmlFor={`pick-${s.id}`}>{studentLabel(s)} — {s.className}</label>
              </li>
            ))}
          </ul>
        </section>
        {template.fields.length > 0 && (
          <section>
            <h2>Campos do lote</h2>
            {template.fields.map((f) => (
              <div key={f.key}>
                <label htmlFor={`value-${f.key}`}>{f.label}</label>
                <input
                  id={`value-${f.key}`}
                  type={f.type === "data" ? "date" : "text"}
                  required
                  maxLength={200}
                  value={values[f.key] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                />
              </div>
            ))}
          </section>
        )}
        <button type="submit" disabled={busy || selected.size === 0}>Gerar documentos</button>
      </form>
    </main>
  );
}
