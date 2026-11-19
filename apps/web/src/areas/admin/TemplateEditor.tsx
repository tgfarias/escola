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
import { Alert, Button, Card, CardBody, CardHeader, Col, Form, FormGroup, Input, Label, Row } from "reactstrap";
import { ApiError, apiFetch, apiFetchBlob } from "../../app/api";
import { PageTitle } from "../../theme/layout/PageTitle";
import { announce, StatusNotice } from "../../theme/notify";
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

  const savedMessage = savedVersion !== undefined ? `Versão ${savedVersion} salva.` : null;
  useEffect(() => {
    if (savedMessage) announce(savedMessage);
  }, [savedMessage]);

  if (!draft) {
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
    <>
      <PageTitle
        heading={loaded ? `${loaded.name} — versão ${loaded.version}` : "Novo modelo"}
        icon="pe-7s-note2"
        actions={<Link className="btn btn-outline-secondary" to="/admin/documentos">Voltar aos documentos</Link>}
      />
      <StatusNotice message={savedMessage} />
      {loaded && !loaded.latest && <div className="alert alert-warning">Esta não é a versão mais recente do modelo.</div>}
      {error && (
        <Alert color="danger" fade={false}>
          <p className="mb-0">{error}</p>
          {invalid.length > 0 && <ul className="mt-2 mb-0">{invalid.map((v) => <li key={v}>{v}</li>)}</ul>}
        </Alert>
      )}
      <Card className="main-card mb-3">
        <CardBody>
          <Form onSubmit={save}>
            <Row className="g-2">
              <Col md={8}>
                <FormGroup>
                  <Label for="template-name">Nome</Label>
                  <Input id="template-name" required maxLength={120} value={draft.name} onChange={(e) => update({ name: e.target.value })} />
                </FormGroup>
              </Col>
              <Col md={4}>
                <FormGroup>
                  <Label for="template-category">Categoria</Label>
                  <Input id="template-category" type="select" value={draft.category} onChange={(e) => update({ category: DocumentCategory.parse(e.target.value) })}>
                    {DocumentCategory.options.map((c) => (
                      <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
                    ))}
                  </Input>
                </FormGroup>
              </Col>
            </Row>

            <fieldset className="mb-3">
              <legend className="fs-6">Variáveis (clique para inserir no texto)</legend>
              <div className="d-flex flex-wrap gap-2">
                {TEMPLATE_VARIABLES.map((v) => (
                  <Button key={v} size="sm" outline color="primary" type="button" title={`{{${v}}}`} onClick={() => insert(v)}>
                    {TEMPLATE_VARIABLE_LABELS[v]}
                  </Button>
                ))}
                {draft.fields.filter((f) => f.key && f.label).map((f) => (
                  <Button key={f.key} size="sm" outline color="secondary" type="button" title={`{{campo.${f.key}}}`} onClick={() => insert(`campo.${f.key}`)}>
                    Campo: {f.label}
                  </Button>
                ))}
              </div>
            </fieldset>

            <FormGroup>
              <Label for="template-body">Texto do modelo</Label>
              <p className="small mb-2">Use # e ## para títulos, **negrito**, listas com - ou 1. e tabelas com |.</p>
              <Input id="template-body" type="textarea" className="font-monospace" innerRef={body} rows={16} required value={draft.bodyMd} onChange={(e) => update({ bodyMd: e.target.value })} />
            </FormGroup>

            <fieldset className="mb-3">
              <legend className="fs-6">Campos preenchidos ao gerar (até 10)</legend>
              {draft.fields.map((f, i) => (
                <Row key={i} className="g-2 align-items-end mb-2">
                  <Col md={3}>
                    <Label for={`field-key-${i}`}>Chave</Label>
                    <Input id={`field-key-${i}`} required pattern="[a-z][a-z0-9_]{0,29}" value={f.key} onChange={(e) => updateField(i, { key: e.target.value })} />
                  </Col>
                  <Col md={4}>
                    <Label for={`field-label-${i}`}>Rótulo</Label>
                    <Input id={`field-label-${i}`} required maxLength={80} value={f.label} onChange={(e) => updateField(i, { label: e.target.value })} />
                  </Col>
                  <Col md={3}>
                    <Label for={`field-type-${i}`}>Tipo</Label>
                    <Input id={`field-type-${i}`} type="select" value={f.type} onChange={(e) => updateField(i, { type: e.target.value === "data" ? "data" : "texto" })}>
                      <option value="texto">Texto</option>
                      <option value="data">Data</option>
                    </Input>
                  </Col>
                  <Col md={2}>
                    <Button outline color="danger" type="button" className="w-100" onClick={() => update({ fields: draft.fields.filter((_, j) => j !== i) })}>
                      Remover campo
                    </Button>
                  </Col>
                </Row>
              ))}
              {draft.fields.length < 10 && (
                <Button outline color="secondary" type="button" onClick={() => update({ fields: [...draft.fields, { key: "", label: "", type: "texto" }] })}>
                  Adicionar campo
                </Button>
              )}
            </fieldset>

            <div className="d-flex gap-2">
              <Button outline color="secondary" type="button" disabled={busy} onClick={() => void showPreview()}>Ver prévia</Button>
              <Button color="primary" type="submit" disabled={busy}>Salvar</Button>
            </div>
          </Form>
        </CardBody>
      </Card>
      {preview && (
        <Card className="main-card mb-3">
          <CardHeader tag="h2" className="h6 mb-0">Prévia</CardHeader>
          <CardBody className="p-0">
            <iframe title="Prévia do PDF" src={preview} width="100%" height="600" className="d-block border-0" />
          </CardBody>
        </Card>
      )}
    </>
  );
}
