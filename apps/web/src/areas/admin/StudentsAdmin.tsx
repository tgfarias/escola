import { ClassListResponse, GuardianDetail, StudentListResponse, formatCpf } from "@app-lanche/contracts";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { z } from "zod";
import { apiFetch } from "../../app/api";
import { formatIsoDate } from "../../ui/dates";
import { filterStudents, studentLabel, type ClassRow, type StudentRow } from "./studentFilter";
import { useStaffErrors } from "./useStaffErrors";

export function StudentFilters(props: { classes: ClassRow[]; classId: string; query: string; onClass: (id: string) => void; onQuery: (q: string) => void }) {
  return (
    <div>
      <label htmlFor="filter-class">Turma</label>
      <select id="filter-class" value={props.classId} onChange={(e) => props.onClass(e.target.value)}>
        <option value="">Todas</option>
        {props.classes.map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>
      <label htmlFor="filter-query">Buscar por nome</label>
      <input id="filter-query" type="search" value={props.query} onChange={(e) => props.onQuery(e.target.value)} />
    </div>
  );
}

type FormProps = { onSaved: () => Promise<void>; onCancel: () => void; onError: (err: unknown) => void };

function StudentForm({ student, onSaved, onCancel, onError }: FormProps & { student: StudentRow }) {
  const [fullName, setFullName] = useState(student.fullName ?? "");
  const [birthDate, setBirthDate] = useState(student.birthDate ?? "");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
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
    <form onSubmit={submit}>
      <h2>{student.firstName} — {student.className}</h2>
      <label htmlFor="student-full-name">Nome completo</label>
      <input id="student-full-name" maxLength={200} value={fullName} onChange={(e) => setFullName(e.target.value)} />
      <label htmlFor="student-birth-date">Data de nascimento</label>
      <input id="student-birth-date" type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} />
      <button type="submit" disabled={busy}>Salvar</button>
      <button type="button" onClick={onCancel}>Cancelar</button>
    </form>
  );
}

function GuardianForm({ guardianId, onSaved, onCancel, onError }: FormProps & { guardianId: string }) {
  const [detail, setDetail] = useState<GuardianDetail | null>(null);
  const [fullName, setFullName] = useState("");
  const [cpf, setCpf] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiFetch(`/api/admin/v1/guardians/${guardianId}`, GuardianDetail).then((d) => {
      setDetail(d);
      setFullName(d.fullName ?? "");
      setCpf(d.cpf ? formatCpf(d.cpf) : "");
    }, onError);
  }, [guardianId, onError]);

  async function submit(event: FormEvent) {
    event.preventDefault();
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

  if (!detail) return <p>Carregando…</p>;
  return (
    <form onSubmit={submit}>
      <h2>Responsável: {detail.firstName}</h2>
      <label htmlFor="guardian-full-name">Nome completo do responsável</label>
      <input id="guardian-full-name" maxLength={200} value={fullName} onChange={(e) => setFullName(e.target.value)} />
      <label htmlFor="guardian-cpf">CPF</label>
      <input id="guardian-cpf" inputMode="numeric" autoComplete="off" maxLength={14} value={cpf} onChange={(e) => setCpf(e.target.value)} />
      <button type="submit" disabled={busy}>Salvar</button>
      <button type="button" onClick={onCancel}>Cancelar</button>
    </form>
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
    setStatus("Dados salvos.");
    await load();
  }

  if (!students) return <main>{error ? <p role="alert">{error}</p> : <p>Carregando…</p>}</main>;
  const visible = filterStudents(students, { classId, query });
  const formProps = { onSaved: saved, onCancel: () => setEditing(null), onError: fail };

  return (
    <main>
      <p><Link to="/admin">Voltar</Link></p>
      <h1>Alunos e responsáveis</h1>
      <StudentFilters classes={classes} classId={classId} query={query} onClass={setClassId} onQuery={setQuery} />
      {status && <p role="status">{status}</p>}
      {error && <p role="alert">{error}</p>}
      {editing?.kind === "student" && <StudentForm key={editing.student.id} student={editing.student} {...formProps} />}
      {editing?.kind === "guardian" && <GuardianForm key={editing.id} guardianId={editing.id} {...formProps} />}
      <table>
        <thead>
          <tr><th>Aluno</th><th>Turma</th><th>Nascimento</th><th>Responsáveis</th></tr>
        </thead>
        <tbody>
          {visible.map((s) => (
            <tr key={s.id}>
              <td>
                <span>{studentLabel(s)}</span>{" "}
                <button type="button" aria-label={`Editar aluno ${studentLabel(s)}`} onClick={() => edit({ kind: "student", student: s })}>Editar</button>
              </td>
              <td>{s.className}</td>
              <td>{s.birthDate ? formatIsoDate(s.birthDate) : "—"}</td>
              <td>
                {s.guardians.length === 0 ? (
                  <span>Nenhum responsável</span>
                ) : (
                  <ul>
                    {s.guardians.map((g) => (
                      <li key={g.id}>
                        {g.fullName ?? g.firstName} — {g.cpfMasked ?? "CPF não informado"}{" "}
                        <button type="button" aria-label={`Editar responsável ${g.firstName}`} onClick={() => edit({ kind: "guardian", id: g.id })}>Editar</button>
                      </li>
                    ))}
                  </ul>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
