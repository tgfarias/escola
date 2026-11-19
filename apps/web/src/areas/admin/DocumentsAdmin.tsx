import { BatchListResponse, Template, TemplateExampleListResponse, TemplateListResponse } from "@app-lanche/contracts";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Alert, Button, Card, CardBody, CardHeader, Table } from "reactstrap";
import { z } from "zod";
import { apiFetch } from "../../app/api";
import { PageTitle } from "../../theme/layout/PageTitle";
import { StatusBadge } from "../../theme/StatusBadge";
import { formatInstantDate } from "../../ui/dates";
import { BATCH_STATUS_LABELS, BATCH_STATUS_TONES, CATEGORY_LABELS } from "./documentLabels";
import { useRequestKey } from "./useRequestKey";
import { useStaffErrors } from "./useStaffErrors";

export function DocumentsAdmin() {
  const navigate = useNavigate();
  const { error, setError, fail } = useStaffErrors();
  const copyKey = useRequestKey();
  const [templates, setTemplates] = useState<TemplateListResponse["templates"] | null>(null);
  const [examples, setExamples] = useState<TemplateExampleListResponse["examples"]>([]);
  const [batches, setBatches] = useState<BatchListResponse["batches"]>([]);

  const load = useCallback(async () => {
    try {
      const [t, e, b] = await Promise.all([
        apiFetch("/api/admin/v1/document-templates", TemplateListResponse),
        apiFetch("/api/admin/v1/document-templates/examples", TemplateExampleListResponse),
        apiFetch("/api/admin/v1/document-batches", BatchListResponse),
      ]);
      setTemplates(t.templates);
      setExamples(e.examples);
      setBatches(b.batches);
    } catch (err) {
      fail(err);
    }
  }, [fail]);

  useEffect(() => void load(), [load]);

  const copyExample = (exampleKey: string) =>
    copyKey.once(async () => {
      setError(null);
      try {
        const body = { exampleKey };
        const t = await apiFetch("/api/admin/v1/document-templates/from-example", Template, { method: "POST", body, idempotencyKey: copyKey.keyFor(body) });
        copyKey.succeeded();
        navigate(`/admin/documentos/modelos/${t.id}`);
      } catch (err) {
        fail(err);
      }
    });

  async function archive(id: string, name: string) {
    if (!window.confirm(`Arquivar o modelo "${name}"? Ele deixa de aparecer para gerar documentos.`)) return;
    try {
      await apiFetch(`/api/admin/v1/document-templates/${id}/archive`, z.undefined(), { method: "POST" });
      await load();
    } catch (err) {
      fail(err);
    }
  }

  if (!templates) {
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

  return (
    <>
      <PageTitle
        heading="Documentos"
        subheading="Modelos e lotes de declarações, comunicados e autorizações."
        icon="pe-7s-news-paper"
        actions={<Link className="btn btn-primary" to="/admin/documentos/modelos/novo">Novo modelo</Link>}
      />
      {error && (
        <Alert color="danger" fade={false}>
          {error}
        </Alert>
      )}
      <Card tag="section" className="main-card mb-3">
        <CardHeader tag="h2" className="h6 mb-0">Modelos</CardHeader>
        <CardBody>
          {templates.length === 0 ? (
            <p>Nenhum modelo ainda. Comece por um exemplo pronto.</p>
          ) : (
            <Table responsive hover striped>
              <thead>
                <tr><th>Nome</th><th>Categoria</th><th>Versão</th><th>Atualizado em</th><th>Ações</th></tr>
              </thead>
              <tbody>
                {templates.map((t) => (
                  <tr key={t.id}>
                    <td>{t.name}</td>
                    <td>{CATEGORY_LABELS[t.category]}</td>
                    <td>{t.version}</td>
                    <td>{formatInstantDate(t.updatedAt)}</td>
                    <td>
                      <div className="d-flex flex-wrap gap-1">
                        <Link className="btn btn-sm btn-outline-primary" to={`/admin/documentos/modelos/${t.id}`}>Editar</Link>
                        <Link className="btn btn-sm btn-outline-primary" to={`/admin/documentos/gerar/${t.id}`}>Gerar</Link>
                        <Button size="sm" outline color="danger" type="button" aria-label={`Arquivar ${t.name}`} onClick={() => void archive(t.id, t.name)}>
                          Arquivar
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          <h3 className="h6 mt-4">Exemplos prontos</h3>
          <ul className="list-group">
            {examples.map((e) => (
              <li key={e.key} className="list-group-item d-flex align-items-center justify-content-between gap-2">
                <span>{e.name}</span>
                <Button size="sm" outline color="primary" type="button" aria-label={`Usar exemplo ${e.name}`} onClick={() => void copyExample(e.key)}>
                  Usar exemplo
                </Button>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
      <Card tag="section" className="main-card mb-3">
        <CardHeader tag="h2" className="h6 mb-0">Lotes</CardHeader>
        <CardBody>
          {batches.length === 0 ? (
            <p className="mb-0">Nenhum lote gerado.</p>
          ) : (
            <Table responsive hover striped className="mb-0">
              <thead>
                <tr><th>Modelo</th><th>Situação</th><th>Criado em</th><th>Documentos</th><th>Abriram</th><th><span className="visually-hidden">Ações</span></th></tr>
              </thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.id}>
                    <td>{b.templateName} (versão {b.templateVersion})</td>
                    <td>
                      <StatusBadge tone={BATCH_STATUS_TONES[b.status]}>{BATCH_STATUS_LABELS[b.status]}</StatusBadge>
                    </td>
                    <td>{formatInstantDate(b.createdAt)}</td>
                    <td>{b.counts.total - b.counts.discarded}</td>
                    <td>{b.status === "published" ? `${b.viewers} de ${b.recipients}` : "—"}</td>
                    <td className="text-end">
                      <Link className="btn btn-sm btn-outline-primary" to={`/admin/documentos/lotes/${b.id}`}>Abrir</Link>
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
