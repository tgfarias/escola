import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { staffErrorMessage } from "../../ui/messages";
import { AdminLayout } from "./AdminLayout";

type Reply = { status: number; body?: unknown };

/** Respostas por "MÉTODO url"; pedido sem resposta cai como falha de rede. */
function mockApi(replies: Record<string, Reply>) {
  const fn = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url, init) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    const reply = replies[key];
    if (!reply) throw new TypeError(`offline: ${key}`);
    return reply.status === 204 ? new Response(null, { status: 204 }) : new Response(JSON.stringify(reply.body), { status: reply.status });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const me = (role: string): Reply => ({
  status: 200,
  body: { id: "0193a000-0000-7000-8000-000000000001", email: "ana@escola.test", role, schoolName: "Escola Sol" },
});

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin/login" element={<p>tela de login</p>} />
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<p>página inicial</p>} />
          <Route path="alunos" element={<p>página de alunos</p>} />
          <Route path="documentos/*" element={<p>página de documentos</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

const menu = () => within(screen.getByRole("navigation", { name: "Menu principal" }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("admin layout", () => {
  it("shows the school, the user and the whole menu to the office, highlighting the current page", async () => {
    mockApi({ "GET /api/admin/v1/me": me("secretaria") });
    renderAt("/admin/documentos/lotes/0193a000-0000-7000-8000-000000000009");
    await screen.findByText("Escola Sol");
    expect(screen.getByText("ana@escola.test")).toBeTruthy();
    expect(screen.getByText("Secretaria")).toBeTruthy();
    expect(menu().getAllByRole("link").map((a) => a.textContent)).toEqual([
      "Início",
      "Alunos e responsáveis",
      "Cardápio",
      "Dias de serviço",
      "Documentos",
      "Tablets da cozinha",
    ]);
    expect(menu().getByRole("link", { name: "Documentos" }).getAttribute("aria-current")).toBe("page");
    expect(menu().getByRole("link", { name: "Início" }).getAttribute("aria-current")).toBeNull();
    expect(menu().getByRole("link", { name: "Cardápio" }).getAttribute("href")).toBe("/admin#cardapio");
    expect(menu().getByRole("link", { name: "Dias de serviço" }).getAttribute("href")).toBe("/admin#dias");
    expect(menu().getByRole("link", { name: "Tablets da cozinha" }).getAttribute("href")).toBe("/admin#tablets");
    expect(screen.getByText("página de documentos")).toBeTruthy();
  });

  it("shows only the home page to the kitchen", async () => {
    mockApi({ "GET /api/admin/v1/me": me("cozinha") });
    renderAt("/admin");
    await screen.findByText("Cozinha");
    expect(menu().getAllByRole("link").map((a) => a.textContent)).toEqual(["Início"]);
  });

  it("sends visitors without a session to the login", async () => {
    mockApi({ "GET /api/admin/v1/me": { status: 401, body: { error: { code: "unauthenticated", message: "x" } } } });
    renderAt("/admin/alunos");
    await screen.findByText("tela de login");
  });

  it("shows other /me failures once, above the page", async () => {
    mockApi({ "GET /api/admin/v1/me": { status: 500, body: { error: { code: "internal_error", message: "x" } } } });
    renderAt("/admin/alunos");
    expect((await screen.findByRole("alert")).textContent).toBe(staffErrorMessage("internal_error"));
    expect(screen.getByText("página de alunos")).toBeTruthy();
  });

  it("logs out and returns to the login", async () => {
    const fn = mockApi({ "GET /api/admin/v1/me": me("admin"), "POST /api/admin/v1/auth/logout": { status: 204 } });
    renderAt("/admin");
    await screen.findByText("Administração");
    fireEvent.click(screen.getByRole("button", { name: "Sair" }));
    await screen.findByText("tela de login");
    expect(fn.mock.calls.some((c) => c[0] === "/api/admin/v1/auth/logout" && c[1]?.method === "POST")).toBe(true);
  });

  it("stays and explains when the logout cannot reach the server", async () => {
    mockApi({ "GET /api/admin/v1/me": me("admin") });
    renderAt("/admin");
    await screen.findByText("Administração");
    fireEvent.click(screen.getByRole("button", { name: "Sair" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Sem conexão. Verifique a internet e tente de novo.");
    expect(screen.getByText("página inicial")).toBeTruthy();
  });
});
