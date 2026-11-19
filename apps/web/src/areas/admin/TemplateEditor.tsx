import {
  DocumentCategory,
  TEMPLATE_VARIABLE_LABELS,
  TEMPLATE_VARIABLES,
  Template,
  type DocumentField,
  type TemplateInput,
} from "@app-lanche/contracts";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { ApiError, apiFetch, apiFetchBlob } from "../../app/api";
import { staffErrorMessage } from "../../ui/messages";
import { CATEGORY_LABELS } from "./documentLabels";
import { useRequestKey } from "./useRequestKey";
import { useStaffErrors } from "./useStaffErrors";

const DUPLICATE_KEYS = "Chaves de campo repetidas.";
const hasDuplicateKeys = (fields: DocumentField[]) => new Set(fields.map((f) => f.key)).size !== fields.length;

const EMPTY: TemplateInput = { name: "", category: "declaracao", bodyMd: "", fields: [] };

export function TemplateEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { error, setError, fail } = useStaffErrors();
  const [loaded, setLoaded] = useState<Template | null>(null);
  const [draft, setDraft] = useState<TemplateInput | null>(id ? null : EMPTY);
  const [invalid, setInvalid] = useState<string[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const body = useRef<HTMLTextAreaElement>(null);
  const saveKey = useRequestKey();
  const savedVersion = (location.state as { savedVersion?: number } | null)?.savedVersion;

  useEffect(() => {
    if (!id) return;
    apiFetch(`/api/admin/v1/document-templates/${id}`, Template).then((t) => {
      setLoaded(t);
      setDraft({ name: t.name, category: t.category, bodyMd: t.bodyMd, fields: t.fields });
    }, fail);
  }, [id, fail]);

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  if (!draft) return <main>{error ? <p role="alert">{error}</p> : <p>Carregando…</p>}</main>;

  // A prévia mostra o rascunho de quando foi pedida: qualquer mudança a descarta (o efeito acima libera a URL).
  const update = (patch: Partial<TemplateInput>) => {
    setPreview(null);
    setDraft((d) => (d ? { ...d, ...patch } : d));
  };
  const updateField = (i: number, patch: Partial<DocumentField>) =>
    update({ fields: draft.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) });

  function insert(variable: string) {
    const el = body.current;
    const text = `{{${variable}}}`;
    const start = el?.selectionStart ?? draft!.bodyMd.length;
    const end = el?.selectionEnd ?? start;
    update({ bodyMd: draft!.bodyMd.slice(0, start) + text + draft!.bodyMd.slice(end) });
  }

  function handle(err: unknown) {
    if (err instanceof ApiError && err.code === "document_template_invalid") {
      const variables = err.details?.variables;
      setInvalid(Array.isArray(variables) ? variables.map(String) : []);
      setError(staffErrorMessage(err.code));
      return;
    }
    fail(err);
  }

  /** Chave repetida: a API recusaria com validation_failed; aqui a mensagem diz o que corrigir. */
  function refuseDuplicateKeys(): boolean {
    if (!hasDuplicateKeys(draft!.fields)) return false;
    setInvalid([]);
    setError(DUPLICATE_KEYS);
    return true;
  }

  async function showPreview() {
    if (refuseDuplicateKeys()) return;
    setBusy(true);
    setError(null);
    setInvalid([]);
    try {
      const blob = await apiFetchBlob("/api/admin/v1/document-templates/preview", { method: "POST", body: draft });
      setPreview(URL.createObjectURL(blob));
    } catch (err) {
      handle(err);
    } finally {
      setBusy(false);
    }
  }

  function save(event: FormEvent) {
    event.preventDefault();
    if (refuseDuplicateKeys()) return;
    void saveKey.once(async () => {
      setBusy(true);
      setError(null);
      setInvalid([]);
      try {
        const url = loaded ? `/api/admin/v1/document-templates/${loaded.id}/versions` : "/api/admin/v1/document-templates";
        const saved = await apiFetch(url, Template, { method: "POST", body: draft, idempotencyKey: saveKey.keyFor({ url, draft }) });
        saveKey.succeeded();
        navigate(`/admin/documentos/modelos/${saved.id}`, { replace: true, state: { savedVersion: saved.version } });
      } catch (err) {
        handle(err);
      } finally {
        setBusy(false);
      }
    });
  }

  return (
    <main>
      <p><Link to="/admin/documentos">Voltar aos documentos</Link></p>
      <h1>{loaded ? `${loaded.name} — versão ${loaded.version}` : "Novo modelo"}</h1>
      {savedVersion !== undefined && <p role="status">Versão {savedVersion} salva.</p>}
      {loaded && !loaded.latest && <p>Esta não é a versão mais recente do modelo.</p>}
      {error && (
        <div role="alert">
          <p>{error}</p>
          {invalid.length > 0 && <ul>{invalid.map((v) => <li key={v}>{v}</li>)}</ul>}
        </div>
      )}
      <form onSubmit={save}>
        <label htmlFor="template-name">Nome</label>
        <input id="template-name" required maxLength={120} value={draft.name} onChange={(e) => update({ name: e.target.value })} />
        <label htmlFor="template-category">Categoria</label>
        <select id="template-category" value={draft.category} onChange={(e) => update({ category: DocumentCategory.parse(e.target.value) })}>
          {DocumentCategory.options.map((c) => (
            <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
          ))}
        </select>

        <fieldset>
          <legend>Variáveis (clique para inserir no texto)</legend>
          {TEMPLATE_VARIABLES.map((v) => (
            <button key={v} type="button" title={`{{${v}}}`} onClick={() => insert(v)}>{TEMPLATE_VARIABLE_LABELS[v]}</button>
          ))}
          {draft.fields.filter((f) => f.key && f.label).map((f) => (
            <button key={f.key} type="button" title={`{{campo.${f.key}}}`} onClick={() => insert(`campo.${f.key}`)}>Campo: {f.label}</button>
          ))}
        </fieldset>

        <label htmlFor="template-body">Texto do modelo</label>
        <p>Use # e ## para títulos, **negrito**, listas com - ou 1. e tabelas com |.</p>
        <textarea id="template-body" ref={body} rows={16} required value={draft.bodyMd} onChange={(e) => update({ bodyMd: e.target.value })} />

        <fieldset>
          <legend>Campos preenchidos ao gerar (até 10)</legend>
          {draft.fields.map((f, i) => (
            <div key={i}>
              <label htmlFor={`field-key-${i}`}>Chave</label>
              <input id={`field-key-${i}`} required pattern="[a-z][a-z0-9_]{0,29}" value={f.key} onChange={(e) => updateField(i, { key: e.target.value })} />
              <label htmlFor={`field-label-${i}`}>Rótulo</label>
              <input id={`field-label-${i}`} required maxLength={80} value={f.label} onChange={(e) => updateField(i, { label: e.target.value })} />
              <label htmlFor={`field-type-${i}`}>Tipo</label>
              <select id={`field-type-${i}`} value={f.type} onChange={(e) => updateField(i, { type: e.target.value === "data" ? "data" : "texto" })}>
                <option value="texto">Texto</option>
                <option value="data">Data</option>
              </select>
              <button type="button" onClick={() => update({ fields: draft.fields.filter((_, j) => j !== i) })}>Remover campo</button>
            </div>
          ))}
          {draft.fields.length < 10 && (
            <button type="button" onClick={() => update({ fields: [...draft.fields, { key: "", label: "", type: "texto" }] })}>Adicionar campo</button>
          )}
        </fieldset>

        <button type="button" disabled={busy} onClick={() => void showPreview()}>Ver prévia</button>
        <button type="submit" disabled={busy}>Salvar</button>
      </form>
      {preview && <iframe title="Prévia do PDF" src={preview} width="100%" height="600" />}
    </main>
  );
}
