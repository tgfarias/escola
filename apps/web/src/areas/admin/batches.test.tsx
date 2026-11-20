import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { staffErrorMessage } from "../../ui/messages";
import { BatchPage } from "./BatchPage";
import { GenerateBatch } from "./GenerateBatch";

type Reply = { status: number; body?: unknown };

/** Respostas por "MÉTODO url"; uma lista é consumida em ordem e a última se repete. */
function mockApi(replies: Record<string, Reply | Reply[]>) {
  const fn = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url, init) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    const entry = replies[key];
    if (!entry) throw new Error(`unexpected request ${key}`);
    const reply = Array.isArray(entry) ? (entry.length > 1 ? entry.shift()! : entry[0]!) : entry;
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
const [T1, B1, C1, C2, S1, S2, G1, D1, D2] = [U(1), U(2), U(3), U(4), U(5), U(6), U(7), U(8), U(9)];
const TEMPLATE = {
  id: T1, groupId: T1, version: 1, name: "Autorização de passeio", category: "autorizacao", updatedAt: "2026-11-18T13:00:00.000Z",
  bodyMd: "x", archived: false, latest: true,
  fields: [{ key: "destino", label: "Destino", type: "texto" }, { key: "data_passeio", label: "Data do passeio", type: "data" }],
};
const STUDENTS = {
  students: [
    { id: S1, externalCode: "A1", firstName: "Léo", fullName: "Leonardo Souza", birthDate: "2021-03-15", classId: C1, className: "Infantil 3A",
      guardians: [{ id: G1, firstName: "Ana", fullName: "Ana Paula Souza", phone: "+5511999990001", cpfMasked: null, financial: true }] },
    { id: S2, externalCode: "B1", firstName: "Caio", fullName: null, birthDate: null, classId: C2, className: "Infantil 4B", guardians: [] },
  ],
};
const CLASSES = { classes: [{ id: C1, name: "Infantil 3A", shift: "matutino" }, { id: C2, name: "Infantil 4B", shift: "matutino" }] };
const GENERATE: Record<string, Reply> = {
  [`GET /api/admin/v1/document-templates/${T1}`]: { status: 200, body: TEMPLATE },
  "GET /api/admin/v1/students": { status: 200, body: STUDENTS },
  "GET /api/admin/v1/classes": { status: 200, body: CLASSES },
};
const counts = (c: Partial<Record<"total" | "pending" | "rendering" | "rendered" | "failed" | "discarded", number>>) => ({
  total: 2, pending: 0, rendering: 0, rendered: 0, failed: 0, discarded: 0, ...c,
});
const summary = (status: string, c: ReturnType<typeof counts>) => ({
  id: B1, templateId: T1, templateName: "Autorização de passeio", templateVersion: 1, status,
  createdAt: "2026-11-18T13:00:00.000Z", publishedAt: status === "published" ? "2026-11-18T13:10:00.000Z" : null,
  counts: c, recipients: 1, viewers: 0,
});
const doc = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, studentId: S1, studentFirstName: id === D1 ? "Léo" : "Bia", className: "Infantil 3A", guardianId: null, guardianFirstName: null,
  status, discarded: false, viewed: false, ...extra,
});
const detail = (status: string, c: ReturnType<typeof counts>, docs: unknown[], extra: Record<string, unknown> = {}) => ({
  ...summary(status, c), issuedOn: "2026-11-18", fieldValues: {}, unreachable: 0, documents: docs, ...extra,
});

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin/documentos/gerar/:templateId" element={<GenerateBatch />} />
        <Route path="/admin/documentos/lotes/:id" element={<BatchPage />} />
        <Route path="/admin/login" element={<p>login</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Resposta só com promessas (sem stream), para os testes com relógio falso. */
function stubFetch(handler: (key: string) => { status: number; body?: unknown }) {
  const fn = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url, init) => {
    const { status, body } = handler(`${init?.method ?? "GET"} ${url}`);
    return { ok: status < 400, status, json: async () => body } as unknown as Response;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** Deixa o relógio falso andar `ms` e resolve as promessas pendentes, dentro de act. */
const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

describe("generate batch", () => {
  it("marks a class, fills the batch fields and creates the batch", async () => {
    const fn = mockApi({
      ...GENERATE,
      "POST /api/admin/v1/document-batches": { status: 200, body: summary("rendering", counts({ pending: 1, total: 1 })) },
      [`GET /api/admin/v1/document-batches/${B1}`]: { status: 200, body: detail("ready", counts({ total: 1, rendered: 1 }), [doc(D1, "rendered")]) },
      [`POST /api/admin/v1/document-batches/${B1}/render`]: { status: 200, body: { status: "ready", counts: counts({ total: 1, rendered: 1 }) } },
    });
    renderAt(`/admin/documentos/gerar/${T1}`);
    await screen.findByLabelText("Leonardo Souza — Infantil 3A");
    fireEvent.change(screen.getByLabelText("Turma"), { target: { value: C1 } });
    fireEvent.click(screen.getByRole("button", { name: "Marcar turma" }));
    expect((screen.getByLabelText("Leonardo Souza — Infantil 3A") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("1 aluno(s) marcado(s)")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Destino"), { target: { value: "Zoológico" } });
    fireEvent.change(screen.getByLabelText("Data do passeio"), { target: { value: "2026-12-05" } });
    fireEvent.click(screen.getByRole("button", { name: "Gerar documentos" }));
    await screen.findByText("Autorização de passeio — versão 1");
    const call = callOf(fn, "POST /api/admin/v1/document-batches")!;
    expect(call.body).toEqual({ templateId: T1, studentIds: [S1], fieldValues: { destino: "Zoológico", data_passeio: "2026-12-05" } });
    expect(call.headers["idempotency-key"]).toBeTruthy();
  });

  it("lists who lacks data, by name and variable label", async () => {
    mockApi({
      ...GENERATE,
      "POST /api/admin/v1/document-batches": {
        status: 422,
        body: {
          error: {
            code: "document_missing_data",
            message: "x",
            details: { missing: [{ studentId: S2, guardianId: null, variables: ["aluno.data_nascimento"] }, { studentId: S1, guardianId: G1, variables: ["responsavel.cpf"] }] },
          },
        },
      },
    });
    renderAt(`/admin/documentos/gerar/${T1}`);
    fireEvent.click(await screen.findByRole("button", { name: "Marcar todos" }));
    expect(screen.getByText("2 aluno(s) marcado(s)")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Destino"), { target: { value: "Zoo" } });
    fireEvent.change(screen.getByLabelText("Data do passeio"), { target: { value: "2026-12-05" } });
    fireEvent.click(screen.getByRole("button", { name: "Gerar documentos" }));
    await screen.findByText("Caio: Data de nascimento do aluno");
    expect(screen.getByText("Leonardo Souza (responsável Ana): CPF do responsável")).toBeTruthy();
  });
});

describe("generate batch: one request per action", () => {
  async function fill() {
    renderAt(`/admin/documentos/gerar/${T1}`);
    fireEvent.click(await screen.findByRole("button", { name: "Marcar todos" }));
    fireEvent.change(screen.getByLabelText("Destino"), { target: { value: "Zoo" } });
    fireEvent.change(screen.getByLabelText("Data do passeio"), { target: { value: "2026-12-05" } });
  }
  const keysOf = (fn: ReturnType<typeof mockApi>) =>
    fn.mock.calls.filter((c) => c[1]?.method === "POST" && c[0] === "/api/admin/v1/document-batches").map((c) => (c[1]!.headers as Record<string, string>)["idempotency-key"]);

  it("ignores a double click on Gerar documentos", async () => {
    const fn = mockApi({
      ...GENERATE,
      "POST /api/admin/v1/document-batches": { status: 200, body: summary("rendering", counts({ pending: 1, total: 1 })) },
      [`GET /api/admin/v1/document-batches/${B1}`]: { status: 200, body: detail("ready", counts({ total: 1, rendered: 1 }), [doc(D1, "rendered")]) },
    });
    await fill();
    const button = screen.getByRole("button", { name: "Gerar documentos" });
    fireEvent.click(button);
    fireEvent.click(button);
    await screen.findByText("Autorização de passeio — versão 1");
    expect(keysOf(fn)).toHaveLength(1);
  });

  it("retries with the same key and uses a new one when the input changes", async () => {
    const fn = mockApi({
      ...GENERATE,
      "POST /api/admin/v1/document-batches": { status: 500, body: { error: { code: "internal_error", message: "x" } } },
    });
    await fill();
    const button = screen.getByRole("button", { name: "Gerar documentos" });
    fireEvent.click(button);
    await screen.findByRole("alert");
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(keysOf(fn)).toHaveLength(2));
    fireEvent.change(screen.getByLabelText("Destino"), { target: { value: "Museu" } });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(keysOf(fn)).toHaveLength(3));
    const [a, b, c] = keysOf(fn);
    expect(b).toBe(a);
    expect(c).not.toBe(a);
  });

  it("lists a student's own missing data once, not once per guardian", async () => {
    const two = {
      students: [{ ...STUDENTS.students[0]!, guardians: [...STUDENTS.students[0]!.guardians, { id: U(20), firstName: "Rui", fullName: "Rui Souza", phone: "+5511999990002", cpfMasked: null, financial: false }] }],
    };
    mockApi({
      ...GENERATE,
      "GET /api/admin/v1/students": { status: 200, body: two },
      "POST /api/admin/v1/document-batches": {
        status: 422,
        body: {
          error: {
            code: "document_missing_data",
            message: "x",
            details: {
              missing: [
                { studentId: S1, guardianId: G1, variables: ["aluno.data_nascimento", "responsavel.cpf"] },
                { studentId: S1, guardianId: U(20), variables: ["aluno.data_nascimento"] },
              ],
            },
          },
        },
      },
    });
    await fill();
    fireEvent.click(screen.getByRole("button", { name: "Gerar documentos" }));
    await screen.findByText("Leonardo Souza: Data de nascimento do aluno");
    expect(screen.getByText("Leonardo Souza (responsável Ana): CPF do responsável")).toBeTruthy();
    expect(screen.getAllByRole("listitem").filter((li) => li.textContent?.includes("Data de nascimento"))).toHaveLength(1);
  });
});

describe("batch page", () => {
  it("renders until ready, then publishes after confirmation", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const fn = mockApi({
      [`GET /api/admin/v1/document-batches/${B1}`]: [
        { status: 200, body: detail("rendering", counts({ pending: 2 }), [doc(D1, "pending"), doc(D2, "pending")]) },
        { status: 200, body: detail("ready", counts({ rendered: 2 }), [doc(D1, "rendered"), doc(D2, "rendered")]) },
        { status: 200, body: detail("published", counts({ rendered: 2 }), [doc(D1, "rendered"), doc(D2, "rendered")]) },
      ],
      [`POST /api/admin/v1/document-batches/${B1}/render`]: [
        { status: 200, body: { status: "rendering", counts: counts({ pending: 1, rendered: 1 }) } },
        { status: 200, body: { status: "ready", counts: counts({ rendered: 2 }) } },
      ],
      [`POST /api/admin/v1/document-batches/${B1}/publish`]: { status: 200, body: summary("published", counts({ rendered: 2 })) },
    });
    renderAt(`/admin/documentos/lotes/${B1}`);
    const publish = await screen.findByRole("button", { name: "Publicar e avisar os responsáveis" });
    await waitFor(() => expect((publish as HTMLButtonElement).disabled).toBe(false), { timeout: 3000 });
    expect(fn.mock.calls.filter((c) => c[0] === `/api/admin/v1/document-batches/${B1}/render`)).toHaveLength(2);
    fireEvent.click(publish);
    fireEvent.click(publish);
    await screen.findByText("Lote publicado. Os responsáveis serão avisados pelo WhatsApp.");
    expect(screen.getByRole("status").textContent).toBe("Lote publicado. Os responsáveis serão avisados pelo WhatsApp.");
    expect(callOf(fn, `POST /api/admin/v1/document-batches/${B1}/publish`)!.headers["idempotency-key"]).toBeTruthy();
    expect(fn.mock.calls.filter((c) => c[0] === `/api/admin/v1/document-batches/${B1}/publish`)).toHaveLength(1);
  }, 10000);

  it("keeps the publish key across a failed attempt", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const fn = mockApi({
      [`GET /api/admin/v1/document-batches/${B1}`]: { status: 200, body: detail("ready", counts({ rendered: 2 }), [doc(D1, "rendered"), doc(D2, "rendered")]) },
      [`POST /api/admin/v1/document-batches/${B1}/publish`]: [
        { status: 500, body: { error: { code: "internal_error", message: "x" } } },
        { status: 200, body: summary("published", counts({ rendered: 2 })) },
      ],
    });
    renderAt(`/admin/documentos/lotes/${B1}`);
    fireEvent.click(await screen.findByRole("button", { name: "Publicar e avisar os responsáveis" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Publicar e avisar os responsáveis" }));
    await screen.findByText("Lote publicado. Os responsáveis serão avisados pelo WhatsApp.");
    const keys = fn.mock.calls.filter((c) => c[0] === `/api/admin/v1/document-batches/${B1}/publish`).map((c) => (c[1]!.headers as Record<string, string>)["idempotency-key"]);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  it("explains a refused discard and keeps the generic message for other screens", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mockApi({
      [`GET /api/admin/v1/document-batches/${B1}`]: { status: 200, body: detail("ready", counts({ rendered: 1, failed: 1 }), [doc(D1, "rendered"), doc(D2, "failed")]) },
      [`POST /api/admin/v1/documents/${D2}/discard`]: { status: 400, body: { error: { code: "request_rejected", message: "x" } } },
    });
    renderAt(`/admin/documentos/lotes/${B1}`);
    fireEvent.click(await screen.findByRole("button", { name: "Descartar documento de Bia" }));
    await screen.findByText("Só documentos com falha podem ser descartados.");
    expect(staffErrorMessage("request_rejected")).not.toMatch(/descart/i);
  });

  it("warns about documents that reach no guardian", async () => {
    mockApi({
      [`GET /api/admin/v1/document-batches/${B1}`]: { status: 200, body: detail("ready", counts({ rendered: 2 }), [doc(D1, "rendered"), doc(D2, "rendered")], { unreachable: 1 }) },
    });
    renderAt(`/admin/documentos/lotes/${B1}`);
    await screen.findByText("1 documento(s) sem responsável vinculado não serão enviados");
  });

  it("says there is nothing to publish when every document was discarded", async () => {
    mockApi({
      [`GET /api/admin/v1/document-batches/${B1}`]: {
        status: 200,
        body: detail("ready", counts({ discarded: 2 }), [doc(D1, "failed", { discarded: true }), doc(D2, "failed", { discarded: true })]),
      },
    });
    renderAt(`/admin/documentos/lotes/${B1}`);
    await screen.findByText("Nenhum documento para publicar.");
    expect(screen.queryByRole("button", { name: "Publicar e avisar os responsáveis" })).toBeNull();
  });

  it("downloads a PDF for printing and discards a failed document", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const fn = mockApi({
      [`GET /api/admin/v1/document-batches/${B1}`]: { status: 200, body: detail("ready", counts({ rendered: 1, failed: 1 }), [doc(D1, "rendered"), doc(D2, "failed")]) },
      [`POST /api/admin/v1/documents/${D1}/download`]: { status: 200, body: { url: "/api/v1/files?t=abc", expiresAt: "2026-11-18T13:05:00.000Z" } },
      [`POST /api/admin/v1/documents/${D2}/discard`]: { status: 204 },
    });
    renderAt(`/admin/documentos/lotes/${B1}`);
    expect(((await screen.findByRole("button", { name: "Publicar e avisar os responsáveis" })) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Baixar PDF de Léo" }));
    await waitFor(() => expect(open).toHaveBeenCalledWith("/api/v1/files?t=abc", "_blank", "noopener"));
    fireEvent.click(screen.getByRole("button", { name: "Descartar documento de Bia" }));
    await waitFor(() => expect(callOf(fn, `POST /api/admin/v1/documents/${D2}/discard`)).toBeTruthy());
  });

  it("keeps calling render while the batch is rendering, even with nothing pending", async () => {
    const fn = mockApi({
      [`GET /api/admin/v1/document-batches/${B1}`]: [
        { status: 200, body: detail("rendering", counts({ pending: 1 }), [doc(D1, "pending"), doc(D2, "rendered")]) },
        { status: 200, body: detail("ready", counts({ rendered: 2 }), [doc(D1, "rendered"), doc(D2, "rendered")]) },
      ],
      [`POST /api/admin/v1/document-batches/${B1}/render`]: [
        // Another tab holds the last lease: nothing pending here, yet the batch is still rendering.
        { status: 200, body: { status: "rendering", counts: counts({ rendering: 1, rendered: 1 }) } },
        { status: 200, body: { status: "ready", counts: counts({ rendered: 2 }) } },
      ],
    });
    renderAt(`/admin/documentos/lotes/${B1}`);
    const publish = await screen.findByRole("button", { name: "Publicar e avisar os responsáveis" });
    await waitFor(() => expect((publish as HTMLButtonElement).disabled).toBe(false), { timeout: 5000 });
    expect(fn.mock.calls.filter((c) => c[0] === `/api/admin/v1/document-batches/${B1}/render`)).toHaveLength(2);
  }, 10000);
});

describe("render loop", () => {
  const RENDER = `POST /api/admin/v1/document-batches/${B1}/render`;
  const renders = (fn: ReturnType<typeof stubFetch>) => fn.mock.calls.filter((c) => `${c[1]?.method ?? "GET"} ${c[0]}` === RENDER).length;
  const rendering = detail("rendering", counts({ total: 3, pending: 3 }), [doc(D1, "pending"), doc(D2, "pending")]);

  it("waits about 500 ms between calls while the batch renders", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let rendered = 0;
    const fn = stubFetch((key) => {
      if (key === RENDER) {
        rendered += 1;
        return { status: 200, body: { status: "rendering", counts: counts({ total: 3, pending: 3 - rendered, rendered }) } };
      }
      return { status: 200, body: rendering };
    });
    renderAt(`/admin/documentos/lotes/${B1}`);
    await tick(0);
    expect(renders(fn)).toBe(1);
    await tick(499);
    expect(renders(fn)).toBe(1);
    await tick(1);
    expect(renders(fn)).toBe(2);
  });

  it("stops after 5 calls without progress and says so", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fn = stubFetch((key) =>
      key === RENDER ? { status: 200, body: { status: "rendering", counts: counts({ total: 3, pending: 1, rendering: 2 }) } } : { status: 200, body: rendering },
    );
    renderAt(`/admin/documentos/lotes/${B1}`);
    await tick(0);
    for (let i = 0; i < 10; i += 1) await tick(2000);
    expect(renders(fn)).toBe(5);
    expect(screen.getByRole("alert").textContent).toBe("A geração parou de avançar. Tente de novo.");
    expect(screen.queryByText("Gerando PDFs… Mantenha esta página aberta.")).toBeNull();
  });

  it("does not call render again after the page is closed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let rendered = 0;
    const fn = stubFetch((key) => {
      if (key === RENDER) {
        rendered += 1;
        return { status: 200, body: { status: "rendering", counts: counts({ total: 3, pending: 3 - rendered, rendered }) } };
      }
      return { status: 200, body: rendering };
    });
    renderAt(`/admin/documentos/lotes/${B1}`);
    await tick(0);
    expect(renders(fn)).toBe(1);
    cleanup();
    await tick(5000);
    expect(renders(fn)).toBe(1);
  });
});

describe("batch page look", () => {
  it("shows the batch and each document's situation as badges", async () => {
    mockApi({
      [`GET /api/admin/v1/document-batches/${B1}`]: {
        status: 200,
        body: detail("ready", counts({ rendered: 1, failed: 1 }), [doc(D1, "rendered"), doc(D2, "failed")]),
      },
    });
    renderAt(`/admin/documentos/lotes/${B1}`);
    expect(await screen.findByRole("heading", { level: 1, name: "Autorização de passeio — versão 1" })).toBeTruthy();
    expect(screen.getByText("Pronto para publicar").className).toContain("text-bg-warning");
    expect(screen.getByText("Pronto").className).toContain("text-bg-success");
    expect(screen.getByText("Falhou").className).toContain("text-bg-danger");
  });
});
