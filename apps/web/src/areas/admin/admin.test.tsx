import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminHome } from "./AdminHome";
import { AdminLayout } from "./AdminLayout";
import { AdminLogin } from "./AdminLogin";
import { LOGO_ALT } from "../../theme/brand";

type Reply = { status: number; body: unknown };

function mockApi(replies: Record<string, Reply>) {
  const fn = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) => {
    const reply = replies[url];
    if (!reply) throw new Error(`unexpected request to ${url}`);
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin/login" element={<AdminLogin />} />
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<AdminHome />} />
          <Route path="alunos" element={<p>página de alunos</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

const ME = {
  status: 200,
  body: { id: "0193a000-0000-7000-8000-000000000001", email: "ana@escola.test", role: "secretaria", schoolName: "Escola Sol" },
};

const DASH = { status: 200, body: { period: "today", from: "2030-03-04", to: "2030-03-04", snacks: { paidOrders: 0, deliveredOrders: 0, notCollectedOrders: 0, counterSales: 0, topItems: [] }, documents: null, money: null } };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("admin area", () => {
  it("shows the school logo on the login card", () => {
    renderAt("/admin/login");
    expect(screen.getByRole("img", { name: LOGO_ALT })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Área da escola" })).toBeTruthy();
  });

  it("logs in with e-mail and code, then shows the school", async () => {
    mockApi({
      "/api/admin/v1/auth/otp/request": { status: 200, body: { otpToken: "otp-token" } },
      "/api/admin/v1/auth/otp/verify": { status: 200, body: { status: "ok", role: "secretaria" } },
      "/api/admin/v1/me": ME,
      "/api/admin/v1/dashboard?period=today": DASH,
    });
    renderAt("/admin/login");
    fireEvent.change(screen.getByLabelText("E-mail"), { target: { value: "ana@escola.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar código" }));
    fireEvent.change(await screen.findByLabelText("Código de 6 dígitos"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Entrar" }));
    await screen.findByRole("heading", { name: "Escola Sol" }, { timeout: 5000 });
  });

  it("shows the wrong-code message", async () => {
    mockApi({
      "/api/admin/v1/auth/otp/request": { status: 200, body: { otpToken: "otp-token" } },
      "/api/admin/v1/auth/otp/verify": { status: 401, body: { error: { code: "otp_invalid", message: "x" } } },
    });
    renderAt("/admin/login");
    fireEvent.change(screen.getByLabelText("E-mail"), { target: { value: "ana@escola.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar código" }));
    fireEvent.change(await screen.findByLabelText("Código de 6 dígitos"), { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Entrar" }));
    await screen.findByText("Código incorreto. Confira e tente de novo.");
  });

  it("shows the same neutral notice after requesting a code", async () => {
    mockApi({ "/api/admin/v1/auth/otp/request": { status: 200, body: { otpToken: "otp-token" } } });
    renderAt("/admin/login");
    fireEvent.change(screen.getByLabelText("E-mail"), { target: { value: "ninguem@escola.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar código" }));
    await screen.findByText("Se o e-mail estiver cadastrado, você receberá um código em instantes.");
  });

  it("requests a new code for the same e-mail and verifies with the new token", async () => {
    let n = 0;
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) => {
      if (url === "/api/admin/v1/auth/otp/request") {
        n += 1;
        return new Response(JSON.stringify({ otpToken: `otp-token-${n}` }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: { code: "otp_invalid", message: "x" } }), { status: 401 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAt("/admin/login");
    fireEvent.change(screen.getByLabelText("E-mail"), { target: { value: "ana@escola.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar código" }));
    fireEvent.change(await screen.findByLabelText("Código de 6 dígitos"), { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Entrar" }));
    await screen.findByText("Código incorreto. Confira e tente de novo.");
    fireEvent.click(screen.getByRole("button", { name: "Enviar novo código" }));
    await screen.findByText("Novo código enviado. Use só o último que chegar.");
    expect(screen.queryByText("Código incorreto. Confira e tente de novo.")).toBeNull();
    expect((screen.getByLabelText("Código de 6 dígitos") as HTMLInputElement).value).toBe("");
    fireEvent.change(screen.getByLabelText("Código de 6 dígitos"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Entrar" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    const requests = fetchMock.mock.calls.filter((c) => c[0] === "/api/admin/v1/auth/otp/request");
    expect(requests.map((c) => JSON.parse(String(c[1]?.body)).email)).toEqual(["ana@escola.test", "ana@escola.test"]);
    expect(JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body)).otpToken).toBe("otp-token-2");
  });

  it("sends anonymous visitors to the login", async () => {
    mockApi({ "/api/admin/v1/me": { status: 401, body: { error: { code: "unauthenticated", message: "x" } } } });
    renderAt("/admin");
    await screen.findByLabelText("E-mail");
  });

  it("fetches /me once for the layout and the home page, also when coming back to Início", async () => {
    const fetchMock = mockApi({ "/api/admin/v1/me": ME, "/api/admin/v1/dashboard?period=today": DASH });
    renderAt("/admin");
    await screen.findByRole("heading", { name: "Escola Sol" });
    fireEvent.click(screen.getByRole("link", { name: "Alunos e responsáveis" }));
    await screen.findByText("página de alunos");
    fireEvent.click(screen.getByRole("link", { name: "Início" }));
    await screen.findByRole("heading", { name: "Escola Sol" });
    expect(fetchMock.mock.calls.filter((c) => c[0] === "/api/admin/v1/me")).toHaveLength(1);
  });

  async function toCodeStep(verify?: Reply) {
    const fetchMock = mockApi({
      "/api/admin/v1/auth/otp/request": { status: 200, body: { otpToken: "otp-token" } },
      ...(verify ? { "/api/admin/v1/auth/otp/verify": verify } : {}),
    });
    renderAt("/admin/login");
    fireEvent.change(screen.getByLabelText("E-mail"), { target: { value: "  ana@escola.test  " } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar código" }));
    await screen.findByLabelText("Código de 6 dígitos");
    return fetchMock;
  }

  it("shows a staff-specific message when the code expired", async () => {
    await toCodeStep({ status: 401, body: { error: { code: "otp_expired", message: "x" } } });
    fireEvent.change(screen.getByLabelText("Código de 6 dígitos"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Entrar" }));
    await screen.findByText("Este código expirou. Peça um novo código.");
    expect(screen.queryByText(/Abra o link/)).toBeNull();
  });

  it("shows a staff-specific message after too many attempts", async () => {
    await toCodeStep({ status: 429, body: { error: { code: "otp_too_many_attempts", message: "x" } } });
    fireEvent.change(screen.getByLabelText("Código de 6 dígitos"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Entrar" }));
    await screen.findByText("Muitas tentativas. Aguarde alguns minutos e peça um novo código.");
  });

  it("lets staff go back to the e-mail step keeping the e-mail", async () => {
    await toCodeStep();
    fireEvent.click(screen.getByRole("button", { name: "Usar outro e-mail" }));
    expect(((await screen.findByLabelText("E-mail")) as HTMLInputElement).value).toBe("ana@escola.test");
  });

  it("sends the e-mail trimmed", async () => {
    const fetchMock = await toCodeStep();
    const call = fetchMock.mock.calls.find((c) => c[0] === "/api/admin/v1/auth/otp/request")!;
    expect(JSON.parse(call[1]!.body as string)).toEqual({ email: "ana@escola.test" });
  });
});
