import { ImportStudentsResponse, StaffMeResponse } from "@app-lanche/contracts";
import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { ApiError, apiFetch } from "../../app/api";
import { staffErrorMessage } from "../../ui/messages";
import { MenuAdmin } from "./MenuAdmin";
import { ServiceDaysAdmin } from "./ServiceDaysAdmin";

export function AdminHome() {
  const navigate = useNavigate();
  const [me, setMe] = useState<StaffMeResponse | null>(null);
  const [csv, setCsv] = useState("");
  const [result, setResult] = useState<ImportStudentsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiFetch("/api/admin/v1/me", StaffMeResponse).then(setMe, (err) => {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        navigate("/admin/login", { replace: true });
      } else {
        setError(staffErrorMessage(err instanceof ApiError ? err.code : "internal_error"));
      }
    });
  }, [navigate]);

  async function loadFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) setCsv(await file.text());
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(
        await apiFetch("/api/admin/v1/import/students", ImportStudentsResponse, {
          method: "POST",
          body: { csv },
        }),
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        navigate("/admin/login", { replace: true });
        return;
      }
      setError(staffErrorMessage(err instanceof ApiError ? err.code : "internal_error"));
    } finally {
      setBusy(false);
    }
  }

  if (!me) return <main>{error ? <p role="alert">{error}</p> : <p>Carregando…</p>}</main>;

  return (
    <main>
      <h1>{me.schoolName}</h1>
      <section>
        <h2>Importar alunos e responsáveis</h2>
        <p>
          Colunas: <code>codigo_aluno, primeiro_nome, turma, responsavel_nome, responsavel_telefone</code>.
          Um aluno com dois responsáveis ocupa duas linhas.
        </p>
        <form onSubmit={submit}>
          <label htmlFor="file">Arquivo CSV</label>
          <input id="file" type="file" accept=".csv,text/csv" onChange={loadFile} />
          <label htmlFor="csv">Conteúdo do CSV</label>
          <textarea id="csv" rows={8} required value={csv} onChange={(e) => setCsv(e.target.value)} />
          <button type="submit" disabled={busy}>Importar</button>
        </form>
        {error && <p role="alert">{error}</p>}
        {result?.applied && (
          <p role="status">
            Importação concluída: {result.classes} turmas, {result.students} alunos, {result.guardians} responsáveis.
          </p>
        )}
        {result && !result.applied && (
          <div role="alert">
            <p>Nada foi importado. Corrija as linhas abaixo e envie de novo.</p>
            <ul>
              {result.errors.map((e) => (
                <li key={`${e.line}-${e.message}`}>Linha {e.line}: {e.message}</li>
              ))}
            </ul>
          </div>
        )}
      </section>
      {(me.role === "admin" || me.role === "secretaria") && (
        <>
          <MenuAdmin />
          <ServiceDaysAdmin />
        </>
      )}
    </main>
  );
}
