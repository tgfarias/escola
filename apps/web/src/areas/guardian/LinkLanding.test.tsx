import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LinkLanding } from "./LinkLanding";

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

function renderAt(hash: string) {
  window.history.replaceState(null, "", `/l${hash}`);
  render(
    <MemoryRouter initialEntries={["/l"]}>
      <Routes>
        <Route path="/l" element={<LinkLanding />} />
        <Route path="/pedido" element={<p>tela de pedido</p>} />
        <Route path="/documentos" element={<p>tela de documentos</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("LinkLanding", () => {
  it("exchanges the token, clears the fragment and goes to the order screen", async () => {
    const fetchMock = mockApi({ "/api/v1/auth/exchange": { status: 200, body: { status: "ok", scope: "order" } } });
    renderAt("#tok-123456789012345678901234567890");
    await screen.findByText("tela de pedido");
    expect(window.location.hash).toBe("");
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.token).toBe("tok-123456789012345678901234567890");
    expect(body.deviceSecret.length).toBeGreaterThanOrEqual(43);
    expect(localStorage.getItem("deviceSecret")).toBe(body.deviceSecret);
  });

  it("goes to documents when the link has that scope", async () => {
    mockApi({ "/api/v1/auth/exchange": { status: 200, body: { status: "ok", scope: "documents" } } });
    renderAt("#tok-123456789012345678901234567890");
    await screen.findByText("tela de documentos");
  });

  it("asks for the code on a new device and continues after verifying", async () => {
    const fetchMock = mockApi({
      "/api/v1/auth/exchange": { status: 200, body: { status: "step_up_required", otpToken: "otp-token" } },
      "/api/v1/auth/otp/verify": { status: 200, body: { status: "ok", scope: "order" } },
    });
    renderAt("#tok-123456789012345678901234567890");
    const input = await screen.findByLabelText("Código de 6 dígitos");
    fireEvent.change(input, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    await screen.findByText("tela de pedido");
    const verifyCall = fetchMock.mock.calls.find((c) => c[0] === "/api/v1/auth/otp/verify")!;
    expect(JSON.parse((verifyCall[1] as RequestInit).body as string)).toEqual({ otpToken: "otp-token", code: "123456" });
  });

  it("shows the wrong-code message and lets the user retry", async () => {
    mockApi({
      "/api/v1/auth/exchange": { status: 200, body: { status: "step_up_required", otpToken: "otp-token" } },
      "/api/v1/auth/otp/verify": { status: 401, body: { error: { code: "otp_invalid", message: "x" } } },
    });
    renderAt("#tok-123456789012345678901234567890");
    fireEvent.change(await screen.findByLabelText("Código de 6 dígitos"), { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    await screen.findByText("Código incorreto. Confira e tente de novo.");
    expect(screen.getByLabelText("Código de 6 dígitos")).toBeTruthy();
  });

  it("explains an expired link", async () => {
    mockApi({ "/api/v1/auth/exchange": { status: 401, body: { error: { code: "invalid_token", message: "x" } } } });
    renderAt("#tok-123456789012345678901234567890");
    await screen.findByText("Este link expirou. Peça um novo pelo WhatsApp da escola.");
  });

  it("explains a missing token without calling the API", async () => {
    const fetchMock = mockApi({});
    renderAt("");
    await screen.findByText("Este link expirou. Peça um novo pelo WhatsApp da escola.");
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());
  });
});
