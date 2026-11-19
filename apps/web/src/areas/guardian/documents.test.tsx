import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentsPage } from "./DocumentsPage";

type Reply = { status: number; body: unknown };

function mockApi(replies: Record<string, Reply>) {
  const fn = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url, init) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    const reply = replies[key];
    if (!reply) throw new Error(`unexpected request ${key}`);
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const D1 = "00000000-0000-4000-8000-000000000001";
const DOCS = {
  documents: [
    { id: D1, title: "Autorização de passeio", category: "autorizacao", studentFirstName: "Léo", publishedAt: "2026-11-18T13:10:00.000Z", viewed: false },
  ],
};

function renderPage() {
  render(
    <MemoryRouter initialEntries={["/documentos"]}>
      <Routes>
        <Route path="/documentos" element={<DocumentsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("guardian documents page", () => {
  it("lists published documents and opens one by a signed URL", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const fn = mockApi({
      "GET /api/v1/documents": { status: 200, body: DOCS },
      [`POST /api/v1/documents/${D1}/download`]: { status: 200, body: { url: "https://storage.test/signed", expiresAt: "2026-11-18T13:15:00.000Z" } },
    });
    renderPage();
    await screen.findByText("Autorização de passeio");
    expect(screen.getByText("novo")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Abrir Autorização de passeio de Léo" }));
    await waitFor(() => expect(open).toHaveBeenCalledWith("https://storage.test/signed", "_blank", "noopener"));
    expect(screen.getByRole("link", { name: "Se o PDF não abriu, toque aqui" }).getAttribute("href")).toBe("https://storage.test/signed");
    expect(screen.queryByText("novo")).toBeNull();
    expect(fn.mock.calls.find((c) => c[0] === `/api/v1/documents/${D1}/download`)![1]!.method).toBe("POST");
  });

  it("explains an empty list", async () => {
    mockApi({ "GET /api/v1/documents": { status: 200, body: { documents: [] } } });
    renderPage();
    await screen.findByText("Nenhum documento publicado por enquanto.");
  });

  it("asks to open the link again when the session expired", async () => {
    mockApi({ "GET /api/v1/documents": { status: 401, body: { error: { code: "unauthenticated", message: "x" } } } });
    renderPage();
    await screen.findByText("Sua sessão expirou. Abra o link novamente.");
  });
});
