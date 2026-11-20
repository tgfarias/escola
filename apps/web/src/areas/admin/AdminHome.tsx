import { ImportStudentsResponse } from "@app-lanche/contracts";
import { useState, type ChangeEvent, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { Alert, Button, Card, CardBody, CardHeader, Form, FormGroup, Input, Label } from "reactstrap";
import { ApiError, apiFetch } from "../../app/api";
import { PageTitle } from "../../theme/layout/PageTitle";
import { announce, StatusNotice } from "../../theme/notify";
import { staffErrorMessage } from "../../ui/messages";
import { useAdminMe } from "./AdminLayout";

const LEGACY_ANCHORS: Record<string, string> = {
  "#cardapio": "/admin/lanche/cardapio",
  "#dias": "/admin/lanche/dias",
  "#tablets": "/admin/lanche/tablets",
};

export function AdminHome() {
  const navigate = useNavigate();
  const { hash } = useLocation();
  const { me, meFailed } = useAdminMe();
  const [csv, setCsv] = useState("");
  const [result, setResult] = useState<ImportStudentsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function loadFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) setCsv(await file.text());
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    setResult(null);
    try {
      const res = await apiFetch("/api/admin/v1/import/students", ImportStudentsResponse, {
        method: "POST",
        body: { csv },
      });
      setResult(res);
      if (res.applied) {
        const message = `Importação concluída: ${res.classes} turmas, ${res.students} alunos, ${res.guardians} responsáveis.`;
        setNotice(message);
        announce(message);
      }
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

  if (LEGACY_ANCHORS[hash]) return <Navigate to={LEGACY_ANCHORS[hash]} replace />;

  // O AdminLayout busca /me e mostra o erro dessa busca; aqui só falta esperar.
  if (!me) return meFailed ? null : <p>Carregando…</p>;

  return (
    <>
      <PageTitle heading={me.schoolName} subheading="Início" icon="pe-7s-home" />
      <Card tag="section" id="importar" className="main-card mb-3">
        <CardHeader tag="h2" className="h6 mb-0">
          Importar alunos e responsáveis
        </CardHeader>
        <CardBody>
          <p>
            Colunas: <code>codigo_aluno, primeiro_nome, turma, responsavel_nome, responsavel_telefone</code>.
            Opcionais (para documentos):{" "}
            <code>nome_completo, data_nascimento, responsavel_nome_completo, responsavel_cpf</code>.
            Um aluno com dois responsáveis ocupa duas linhas.
          </p>
          <Form onSubmit={submit}>
            <FormGroup>
              <Label for="file">Arquivo CSV</Label>
              <Input id="file" type="file" accept=".csv,text/csv" onChange={loadFile} />
            </FormGroup>
            <FormGroup>
              <Label for="csv">Conteúdo do CSV</Label>
              <Input id="csv" type="textarea" rows={8} required value={csv} onChange={(e) => setCsv(e.target.value)} />
            </FormGroup>
            <Button color="primary" type="submit" disabled={busy}>
              Importar
            </Button>
          </Form>
          {error && (
            <Alert color="danger" fade={false} className="mt-3">
              {error}
            </Alert>
          )}
          <StatusNotice message={notice} />
          {result && !result.applied && (
            <Alert color="danger" fade={false} className="mt-3">
              <p>Nada foi importado. Corrija as linhas abaixo e envie de novo.</p>
              <ul className="mb-0">
                {result.errors.map((e) => (
                  <li key={`${e.line}-${e.message}`}>Linha {e.line}: {e.message}</li>
                ))}
              </ul>
            </Alert>
          )}
        </CardBody>
      </Card>
    </>
  );
}
