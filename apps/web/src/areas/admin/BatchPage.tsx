import { BatchDetail, BatchSummary, DocumentDownloadResponse, RenderProgress, type BatchCounts } from "@app-lanche/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { z } from "zod";
import { ApiError, apiFetch } from "../../app/api";
import { formatInstantDate, formatIsoDate } from "../../ui/dates";
import { BATCH_STATUS_LABELS, DOCUMENT_STATUS_LABELS } from "./documentLabels";
import { useRequestKey } from "./useRequestKey";
import { useStaffErrors } from "./useStaffErrors";

/** Pausa entre chamadas de render enquanto o lote está em geração. */
export const RENDER_PAUSE_MS = 500;
/** Espera maior quando outra aba segura os arrendamentos restantes. */
export const RENDER_IDLE_MS = 2000;
/** Chamadas seguidas sem nenhum PDF novo (pronto ou com falha) antes de parar. */
export const RENDER_MAX_STALLED = 5;
const STALLED_MESSAGE = "A geração parou de avançar. Tente de novo.";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function BatchPage() {
  const { id } = useParams();
  const { error, setError, fail } = useStaffErrors();
  const [batch, setBatch] = useState<BatchDetail | null>(null);
  const [rendering, setRendering] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const alive = useRef(true);
  const publishKey = useRequestKey();

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const b = await apiFetch(`/api/admin/v1/document-batches/${id}`, BatchDetail);
      if (alive.current) setBatch(b);
      return b;
    } catch (err) {
      fail(err);
      return null;
    }
  }, [id, fail]);

  // Spec 8.3: a tela chama render em sequência; fechar a aba pausa, reabrir continua.
  const renderAll = useCallback(async (start: BatchCounts) => {
    setRendering(true);
    let done = start.rendered + start.failed;
    let stalled = 0;
    try {
      for (;;) {
        if (!alive.current) return;
        const p = await apiFetch(`/api/admin/v1/document-batches/${id}/render`, RenderProgress, { method: "POST" });
        if (!alive.current) return;
        setBatch((b) => (b ? { ...b, status: p.status, counts: p.counts } : b));
        if (p.status !== "rendering") break;
        const now = p.counts.rendered + p.counts.failed;
        stalled = now === done ? stalled + 1 : 0;
        done = now;
        if (stalled >= RENDER_MAX_STALLED) {
          setError(STALLED_MESSAGE);
          break;
        }
        await sleep(p.counts.pending === 0 ? RENDER_IDLE_MS : RENDER_PAUSE_MS);
      }
    } catch (err) {
      fail(err);
    } finally {
      if (alive.current) {
        setRendering(false);
        await load();
      }
    }
  }, [id, fail, load, setError]);

  useEffect(() => {
    void load().then((b) => {
      if (b?.status === "rendering") void renderAll(b.counts);
    });
  }, [load, renderAll]);

  async function download(documentId: string) {
    setError(null);
    try {
      const r = await apiFetch(`/api/admin/v1/documents/${documentId}/download`, DocumentDownloadResponse, { method: "POST" });
      window.open(r.url, "_blank", "noopener");
    } catch (err) {
      fail(err);
    }
  }

  async function discard(documentId: string) {
    if (!window.confirm("Descartar este documento? Ele não será publicado.")) return;
    setError(null);
    try {
      await apiFetch(`/api/admin/v1/documents/${documentId}/discard`, z.undefined(), { method: "POST" });
      await load();
    } catch (err) {
      // `request_rejected` é genérico na API; aqui ele só pode significar documento que não falhou.
      if (err instanceof ApiError && err.code === "request_rejected") setError("Só documentos com falha podem ser descartados.");
      else fail(err);
    }
  }

  const publish = () =>
    publishKey.once(async () => {
      if (!batch || !window.confirm(`Publicar e avisar ${batch.recipients} responsável(is) pelo WhatsApp?`)) return;
      setError(null);
      try {
        await apiFetch(`/api/admin/v1/document-batches/${id}/publish`, BatchSummary, { method: "POST", idempotencyKey: publishKey.keyFor(id) });
        publishKey.succeeded();
        await load();
        setStatus("Lote publicado. Os responsáveis serão avisados pelo WhatsApp.");
      } catch (err) {
        fail(err);
      }
    });

  if (!batch) return <main>{error ? <p role="alert">{error}</p> : <p>Carregando…</p>}</main>;
  const c = batch.counts;
  const canPublish = batch.status === "ready" && c.failed === 0 && c.rendered > 0;
  // Tudo descartado: o lote fica pronto sem nada para enviar.
  const nothingToPublish = batch.status === "ready" && c.failed === 0 && c.rendered === 0;

  return (
    <main>
      <p><Link to="/admin/documentos">Voltar aos documentos</Link></p>
      <h1>{batch.templateName} — versão {batch.templateVersion}</h1>
      <p>
        Emitido em {formatIsoDate(batch.issuedOn)} · {BATCH_STATUS_LABELS[batch.status]} · {c.rendered} de {c.total - c.discarded} PDFs prontos
        {c.failed > 0 ? ` · ${c.failed} com falha` : ""}
      </p>
      {rendering && <p role="status">Gerando PDFs… Mantenha esta página aberta.</p>}
      {status && <p role="status">{status}</p>}
      {error && <p role="alert">{error}</p>}
      {batch.status !== "published" && batch.unreachable > 0 && (
        <p>{batch.unreachable} documento(s) sem responsável vinculado não serão enviados</p>
      )}
      {batch.status === "published" ? (
        <p>
          Publicado em {formatInstantDate(batch.publishedAt!)}. Abriram: {batch.viewers} de {batch.recipients} responsáveis.
        </p>
      ) : nothingToPublish ? (
        <p>Nenhum documento para publicar.</p>
      ) : (
        <button type="button" disabled={!canPublish} onClick={() => void publish()}>Publicar e avisar os responsáveis</button>
      )}
      <table>
        <thead>
          <tr><th>Aluno</th><th>Turma</th><th>Responsável</th><th>Situação</th><th>Ações</th></tr>
        </thead>
        <tbody>
          {batch.documents.map((d) => (
            <tr key={d.id}>
              <td>{d.studentFirstName}</td>
              <td>{d.className}</td>
              <td>{d.guardianFirstName ?? "Todos"}</td>
              <td>{d.discarded ? "Descartado" : DOCUMENT_STATUS_LABELS[d.status]}{d.viewed ? " · aberto" : ""}</td>
              <td>
                {d.status === "rendered" && (
                  <button type="button" aria-label={`Baixar PDF de ${d.studentFirstName}`} onClick={() => void download(d.id)}>Baixar PDF</button>
                )}
                {d.status === "failed" && !d.discarded && batch.status !== "published" && (
                  <button type="button" aria-label={`Descartar documento de ${d.studentFirstName}`} onClick={() => void discard(d.id)}>Descartar</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
