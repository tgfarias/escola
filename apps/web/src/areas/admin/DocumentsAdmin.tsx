import { BatchListResponse, Template, TemplateExampleListResponse, TemplateListResponse } from "@app-lanche/contracts";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { z } from "zod";
import { apiFetch } from "../../app/api";
import { formatInstantDate } from "../../ui/dates";
import { BATCH_STATUS_LABELS, CATEGORY_LABELS } from "./documentLabels";
import { useStaffErrors } from "./useStaffErrors";

export function DocumentsAdmin() {
  const navigate = useNavigate();
  const { error, fail } = useStaffErrors();
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

  async function copyExample(exampleKey: string) {
    try {
      const t = await apiFetch("/api/admin/v1/document-templates/from-example", Template, {
        method: "POST",
        body: { exampleKey },
        idempotencyKey: crypto.randomUUID(),
      });
      navigate(`/admin/documentos/modelos/${t.id}`);
    } catch (err) {
      fail(err);
    }
  }

  async function archive(id: string, name: string) {
    if (!window.confirm(`Arquivar o modelo "${name}"? Ele deixa de aparecer para gerar documentos.`)) return;
    try {
      await apiFetch(`/api/admin/v1/document-templates/${id}/archive`, z.undefined(), { method: "POST" });
      await load();
    } catch (err) {
      fail(err);
    }
  }

  if (!templates) return <main>{error ? <p role="alert">{error}</p> : <p>Carregando…</p>}</main>;

  return (
    <main>
      <p><Link to="/admin">Voltar</Link></p>
      <h1>Documentos</h1>
      {error && <p role="alert">{error}</p>}
      <section>
        <h2>Modelos</h2>
        <p><Link to="/admin/documentos/modelos/novo">Novo modelo</Link></p>
        {templates.length === 0 ? (
          <p>Nenhum modelo ainda. Comece por um exemplo pronto.</p>
        ) : (
          <table>
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
                    <Link to={`/admin/documentos/modelos/${t.id}`}>Editar</Link>{" "}
                    <Link to={`/admin/documentos/gerar/${t.id}`}>Gerar</Link>{" "}
                    <button type="button" aria-label={`Arquivar ${t.name}`} onClick={() => void archive(t.id, t.name)}>Arquivar</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <h3>Exemplos prontos</h3>
        <ul>
          {examples.map((e) => (
            <li key={e.key}>
              <span>{e.name}</span>{" "}
              <button type="button" aria-label={`Usar exemplo ${e.name}`} onClick={() => void copyExample(e.key)}>Usar exemplo</button>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2>Lotes</h2>
        {batches.length === 0 ? (
          <p>Nenhum lote gerado.</p>
        ) : (
          <table>
            <thead>
              <tr><th>Modelo</th><th>Situação</th><th>Criado em</th><th>Documentos</th><th>Abriram</th><th></th></tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.id}>
                  <td>{b.templateName} (versão {b.templateVersion})</td>
                  <td>{BATCH_STATUS_LABELS[b.status]}</td>
                  <td>{formatInstantDate(b.createdAt)}</td>
                  <td>{b.counts.total - b.counts.discarded}</td>
                  <td>{b.status === "published" ? `${b.viewers} de ${b.recipients}` : "—"}</td>
                  <td><Link to={`/admin/documentos/lotes/${b.id}`}>Abrir</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
