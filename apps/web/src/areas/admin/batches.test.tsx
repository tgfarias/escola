import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
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
      guardians: [{ id: G1, firstName: "Ana", fullName: "Ana Paula Souza", phone: "+5511999990001", cpfMasked: null }] },
    { id: S2, externalCode: "B1", firstName: "Caio", fullName: null, birthDate: null, classId: C2, className: "Infantil 4B", guardians: [] },
  ],
};
const CLASSES = { classes: [{ id: C1, name: "Infantil 3A" }, { id: C2, name: "Infantil 4B" }] };
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
const detail = (status: string, c: ReturnType<typeof counts>, docs: unknown[]) => ({ ...summary(status, c), issuedOn: "2026-11-18", fieldValues: {}, documents: docs });

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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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
    await waitFor(() => expect((publish as HTMLButtonElement).disabled).toBe(false));
    expect(fn.mock.calls.filter((c) => c[0] === `/api/admin/v1/document-batches/${B1}/render`)).toHaveLength(2);
    fireEvent.click(publish);
    await screen.findByText("Lote publicado. Os responsáveis serão avisados pelo WhatsApp.");
    expect(callOf(fn, `POST /api/admin/v1/document-batches/${B1}/publish`)!.headers["idempotency-key"]).toBeTruthy();
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
