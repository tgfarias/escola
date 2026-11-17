import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminHome } from "./AdminHome";
import { AdminLogin } from "./AdminLogin";

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
        <Route path="/admin" element={<AdminHome />} />
      </Routes>
    </MemoryRouter>,
  );
}

const ME = {
  status: 200,
  body: { id: "0193a000-0000-7000-8000-000000000001", email: "ana@escola.test", role: "secretaria", schoolName: "Escola Sol" },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("admin area", () => {
  it("logs in with e-mail and code, then shows the school", async () => {
    mockApi({
      "/api/admin/v1/auth/otp/request": { status: 200, body: { otpToken: "otp-token" } },
      "/api/admin/v1/auth/otp/verify": { status: 200, body: { status: "ok", role: "secretaria" } },
      "/api/admin/v1/me": ME,
    });
    renderAt("/admin/login");
    fireEvent.change(screen.getByLabelText("E-mail"), { target: { value: "ana@escola.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar código" }));
    fireEvent.change(await screen.findByLabelText("Código de 6 dígitos"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Entrar" }));
    await screen.findByText("Escola Sol");
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

  it("sends anonymous visitors to the login", async () => {
    mockApi({ "/api/admin/v1/me": { status: 401, body: { error: { code: "unauthenticated", message: "x" } } } });
    renderAt("/admin");
    await screen.findByLabelText("E-mail");
  });

  it("imports a CSV and shows the totals", async () => {
    const fetchMock = mockApi({
      "/api/admin/v1/me": ME,
      "/api/admin/v1/import/students": {
        status: 200,
        body: { applied: true, errors: [], classes: 2, students: 30, guardians: 41 },
      },
    });
    renderAt("/admin");
    fireEvent.change(await screen.findByLabelText("Conteúdo do CSV"), { target: { value: "a,b\n1,2" } });
    fireEvent.click(screen.getByRole("button", { name: "Importar" }));
    await screen.findByText("Importação concluída: 2 turmas, 30 alunos, 41 responsáveis.");
    const call = fetchMock.mock.calls.find((c) => c[0] === "/api/admin/v1/import/students")!;
    expect(JSON.parse(call[1]!.body as string)).toEqual({ csv: "a,b\n1,2" });
  });

  it("lists the line errors when the import is refused", async () => {
    mockApi({
      "/api/admin/v1/me": ME,
      "/api/admin/v1/import/students": {
        status: 200,
        body: { applied: false, errors: [{ line: 5, message: "telefone inválido" }], classes: 0, students: 0, guardians: 0 },
      },
    });
    renderAt("/admin");
    fireEvent.change(await screen.findByLabelText("Conteúdo do CSV"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Importar" }));
    await screen.findByText("Nada foi importado. Corrija as linhas abaixo e envie de novo.");
    await screen.findByText("Linha 5: telefone inválido");
  });

  it("tells staff without permission that they have no access", async () => {
    mockApi({
      "/api/admin/v1/me": ME,
      "/api/admin/v1/import/students": { status: 403, body: { error: { code: "insufficient_scope", message: "x" } } },
    });
    renderAt("/admin");
    fireEvent.change(await screen.findByLabelText("Conteúdo do CSV"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Importar" }));
    await screen.findByText("Você não tem acesso a esta área.");
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

  it("sends staff to the login when the import answers 401", async () => {
    mockApi({
      "/api/admin/v1/me": ME,
      "/api/admin/v1/import/students": { status: 401, body: { error: { code: "unauthenticated", message: "x" } } },
    });
    renderAt("/admin");
    fireEvent.change(await screen.findByLabelText("Conteúdo do CSV"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Importar" }));
    await screen.findByLabelText("E-mail");
  });

  it("sends the e-mail trimmed", async () => {
    const fetchMock = await toCodeStep();
    const call = fetchMock.mock.calls.find((c) => c[0] === "/api/admin/v1/auth/otp/request")!;
    expect(JSON.parse(call[1]!.body as string)).toEqual({ email: "ana@escola.test" });
  });
});
