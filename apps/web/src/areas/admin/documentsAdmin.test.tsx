import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentsAdmin } from "./DocumentsAdmin";
import { TemplateEditor } from "./TemplateEditor";

type Reply = { status: number; body?: unknown; raw?: () => Response };

function mockApi(replies: Record<string, Reply>) {
  const fn = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url, init) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    const reply = replies[key];
    if (!reply) throw new Error(`unexpected request ${key}`);
    if (reply.raw) return reply.raw();
    return reply.status === 204 ? new Response(null, { status: 204 }) : new Response(JSON.stringify(reply.body), { status: reply.status });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function callOf(fn: ReturnType<typeof mockApi>, key: string) {
  const call = fn.mock.calls.find((c) => `${c[1]?.method ?? "GET"} ${c[0]}` === key);
  return call && { headers: call[1]!.headers as Record<string, string>, body: JSON.parse((call[1]!.body as string | undefined) ?? "null") as unknown };
}

const U = (n: number) => `0193a000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const [T1, T2, T3, B1] = [U(1), U(2), U(3), U(4)];
const SUMMARY = { id: T1, groupId: T1, version: 2, name: "Autorização de passeio", category: "autorizacao", updatedAt: "2026-11-18T13:00:00.000Z" };
const TEMPLATE = { ...SUMMARY, bodyMd: "# Oi\n\n{{aluno.primeiro_nome}}", fields: [], archived: false, latest: true };
const COUNTS = { total: 3, pending: 0, rendering: 0, rendered: 3, failed: 0, discarded: 0 };
const BATCH = { id: B1, templateId: T1, templateName: "Autorização de passeio", templateVersion: 2, status: "published", createdAt: "2026-11-18T13:00:00.000Z", publishedAt: "2026-11-18T13:10:00.000Z", counts: COUNTS, recipients: 3, viewers: 2 };
const LIST: Record<string, Reply> = {
  "GET /api/admin/v1/document-templates": { status: 200, body: { templates: [SUMMARY] } },
  "GET /api/admin/v1/document-templates/examples": { status: 200, body: { examples: [{ key: "declaracao-matricula", name: "Declaração de matrícula", category: "declaracao" }] } },
  "GET /api/admin/v1/document-batches": { status: 200, body: { batches: [BATCH] } },
};

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin/documentos" element={<DocumentsAdmin />} />
        <Route path="/admin/documentos/modelos/novo" element={<TemplateEditor />} />
        <Route path="/admin/documentos/modelos/:id" element={<TemplateEditor />} />
        <Route path="/admin/login" element={<p>login</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("documents admin", () => {
  it("lists templates, examples and batches with how many guardians opened", async () => {
    mockApi(LIST);
    renderAt("/admin/documentos");
    await screen.findByText("Autorização de passeio");
    expect(screen.getByText("Autorização")).toBeTruthy();
    expect(screen.getByText("Declaração de matrícula")).toBeTruthy();
    expect(screen.getByText("Autorização de passeio (versão 2)")).toBeTruthy();
    expect(screen.getByText("Publicado")).toBeTruthy();
    expect(screen.getByText("2 de 3")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Gerar" }).getAttribute("href")).toBe(`/admin/documentos/gerar/${T1}`);
  });

  it("copies an example and opens it in the editor", async () => {
    const fn = mockApi({
      ...LIST,
      "POST /api/admin/v1/document-templates/from-example": { status: 200, body: { ...TEMPLATE, id: T2, groupId: T2, version: 1, name: "Declaração de matrícula" } },
      [`GET /api/admin/v1/document-templates/${T2}`]: { status: 200, body: { ...TEMPLATE, id: T2, groupId: T2, version: 1, name: "Declaração de matrícula" } },
    });
    renderAt("/admin/documentos");
    fireEvent.click(await screen.findByRole("button", { name: "Usar exemplo Declaração de matrícula" }));
    await waitFor(() => expect((screen.getByLabelText("Nome") as HTMLInputElement).value).toBe("Declaração de matrícula"));
    const call = callOf(fn, "POST /api/admin/v1/document-templates/from-example")!;
    expect(call.body).toEqual({ exampleKey: "declaracao-matricula" });
    expect(call.headers["idempotency-key"]).toBeTruthy();
  });

  it("archives a template after confirmation", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const fn = mockApi({ ...LIST, [`POST /api/admin/v1/document-templates/${T1}/archive`]: { status: 204 } });
    renderAt("/admin/documentos");
    fireEvent.click(await screen.findByRole("button", { name: "Arquivar Autorização de passeio" }));
    await waitFor(() => expect(callOf(fn, `POST /api/admin/v1/document-templates/${T1}/archive`)).toBeTruthy());
  });
});

describe("template editor", () => {
  it("inserts variables at the cursor, declares a field and saves a new template", async () => {
    const fn = mockApi({
      "POST /api/admin/v1/document-templates": { status: 200, body: { ...TEMPLATE, id: T2, groupId: T2, version: 1 } },
      [`GET /api/admin/v1/document-templates/${T2}`]: { status: 200, body: { ...TEMPLATE, id: T2, groupId: T2, version: 1 } },
    });
    renderAt("/admin/documentos/modelos/novo");
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Passeio" } });
    fireEvent.change(screen.getByLabelText("Categoria"), { target: { value: "autorizacao" } });
    const body = screen.getByLabelText("Texto do modelo") as HTMLTextAreaElement;
    fireEvent.change(body, { target: { value: "Autorizo " } });
    body.setSelectionRange(9, 9);
    fireEvent.click(screen.getByRole("button", { name: "Nome completo do aluno" }));
    expect(body.value).toBe("Autorizo {{aluno.nome_completo}}");
    fireEvent.click(screen.getByRole("button", { name: "Adicionar campo" }));
    fireEvent.change(screen.getByLabelText("Chave"), { target: { value: "destino" } });
    fireEvent.change(screen.getByLabelText("Rótulo"), { target: { value: "Destino" } });
    body.setSelectionRange(body.value.length, body.value.length);
    fireEvent.click(screen.getByRole("button", { name: "Campo: Destino" }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await screen.findByText("Versão 1 salva.");
    expect(callOf(fn, "POST /api/admin/v1/document-templates")!.body).toEqual({
      name: "Passeio",
      category: "autorizacao",
      bodyMd: "Autorizo {{aluno.nome_completo}}{{campo.destino}}",
      fields: [{ key: "destino", label: "Destino", type: "texto" }],
    });
  });

  it("marks the invalid variables the server reports", async () => {
    mockApi({
      "POST /api/admin/v1/document-templates": {
        status: 422,
        body: { error: { code: "document_template_invalid", message: "x", details: { variables: ["{{aluno.apelido}}"] } } },
      },
    });
    renderAt("/admin/documentos/modelos/novo");
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "X" } });
    fireEvent.change(screen.getByLabelText("Texto do modelo"), { target: { value: "{{aluno.apelido}}" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await screen.findByText("O modelo usa variáveis que não existem. Corrija as marcadas abaixo.");
    expect(screen.getByRole("listitem").textContent).toBe("{{aluno.apelido}}");
  });

  it("previews the PDF of the draft", async () => {
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:preview") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const fn = mockApi({
      [`GET /api/admin/v1/document-templates/${T1}`]: { status: 200, body: TEMPLATE },
      "POST /api/admin/v1/document-templates/preview": { status: 200, raw: () => new Response("%PDF-1.7", { status: 200 }) },
    });
    renderAt(`/admin/documentos/modelos/${T1}`);
    await waitFor(() => expect((screen.getByLabelText("Nome") as HTMLInputElement).value).toBe("Autorização de passeio"));
    fireEvent.click(screen.getByRole("button", { name: "Ver prévia" }));
    const frame = await screen.findByTitle("Prévia do PDF");
    expect(frame.getAttribute("src")).toBe("blob:preview");
    expect(callOf(fn, "POST /api/admin/v1/document-templates/preview")!.body).toMatchObject({ name: "Autorização de passeio", bodyMd: TEMPLATE.bodyMd });
  });

  it("saves an edit as a new version and explains a stale one", async () => {
    const fn = mockApi({
      [`GET /api/admin/v1/document-templates/${T1}`]: { status: 200, body: TEMPLATE },
      [`POST /api/admin/v1/document-templates/${T1}/versions`]: { status: 200, body: { ...TEMPLATE, id: T3, version: 3 } },
      [`GET /api/admin/v1/document-templates/${T3}`]: { status: 200, body: { ...TEMPLATE, id: T3, version: 3 } },
    });
    renderAt(`/admin/documentos/modelos/${T1}`);
    await waitFor(() => expect((screen.getByLabelText("Nome") as HTMLInputElement).value).toBe("Autorização de passeio"));
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Passeio ao zoo" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await screen.findByText("Versão 3 salva.");
    expect(callOf(fn, `POST /api/admin/v1/document-templates/${T1}/versions`)!.body).toMatchObject({ name: "Passeio ao zoo" });

    cleanup();
    mockApi({
      [`GET /api/admin/v1/document-templates/${T1}`]: { status: 200, body: TEMPLATE },
      [`POST /api/admin/v1/document-templates/${T1}/versions`]: { status: 409, body: { error: { code: "document_template_outdated", message: "x" } } },
    });
    renderAt(`/admin/documentos/modelos/${T1}`);
    await waitFor(() => expect((screen.getByLabelText("Nome") as HTMLInputElement).value).toBe("Autorização de passeio"));
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await screen.findByText("Este modelo foi alterado por outra pessoa. Recarregue a página para editar a versão mais recente.");
  });
});
