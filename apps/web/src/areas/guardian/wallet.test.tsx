import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TopupPage } from "./TopupPage";
import { WalletPage } from "./WalletPage";

type Reply = { status: number; body?: unknown };
/** Respostas por "MÉTODO url"; uma lista é consumida em ordem e o último item se repete; status 0 = rede caiu. */
function mockApi(replies: Record<string, Reply | Reply[]>) {
  const fn = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url, init) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    const entry = replies[key];
    if (!entry) throw new Error(`unexpected request ${key}`);
    const reply = Array.isArray(entry) ? (entry.length > 1 ? entry.shift()! : entry[0]!) : entry;
    if (reply.status === 0) throw new TypeError("offline");
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
const ok = (body: unknown): Reply => ({ status: 200, body });
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const TOPUP = U(7);

function renderAt(path: string, from?: string) {
  render(
    <MemoryRouter initialEntries={from ? [from, path] : [path]} initialIndex={from ? 1 : 0}>
      <Routes>
        <Route path="/carteira" element={<WalletPage />} />
        <Route path="/carteira/recarga/:id" element={<TopupPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const WALLET = {
  balanceCents: -1350,
  debtLimitCents: 5000,
  financialFor: ["Bia", "Léo"],
  entries: [
    { id: U(1), kind: "counter_charge", amountCents: -900, createdAt: "2030-05-10T12:00:00.000Z", saleId: U(2), studentFirstName: "Léo", overLimit: false, voided: false },
    { id: U(3), kind: "topup_credit", amountCents: 2000, createdAt: "2030-05-09T12:00:00.000Z", saleId: null, studentFirstName: null, overLimit: false, voided: false },
  ],
  otherSales: [{ id: U(4), studentFirstName: "Léo", occurredAt: "2030-05-08T12:00:00.000Z", totalCents: 450, voided: false }],
};
const view = (status: string, pix: string | null) => ({
  id: TOPUP,
  status,
  amountCents: 1350,
  createdAt: "2030-05-10T12:01:00.000Z",
  paidAt: status === "paid" ? "2030-05-10T12:03:00.000Z" : null,
  balanceCents: status === "paid" ? 0 : -1350,
  payment: { status: status === "paid" ? "paid" : "pending", amountCents: 1350, pixCopyPaste: pix, pixQrPngBase64: null, expiresAt: "2030-05-10T13:01:00.000Z" },
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("guardian wallet", () => {
  it("highlights the debt, lists counter entries and other guardians' sales", async () => {
    mockApi({ "GET /api/v1/wallet": ok(WALLET) });
    renderAt("/carteira");
    expect(await screen.findByText("Débito: R$ 13,50")).toBeTruthy();
    expect(screen.getByText(/Lanche no balcão — Léo/)).toBeTruthy();
    expect(screen.getByText(/Recarga por Pix/)).toBeTruthy();
    expect(screen.getByText("Lanches lançados na conta de outro responsável")).toBeTruthy();
  });

  it("pays the debt with an idempotent request and opens the Pix", async () => {
    const fn = mockApi({
      "GET /api/v1/wallet": ok(WALLET),
      "POST /api/v1/topups": ok(view("pending_payment", "00020101FAKEx")),
      [`GET /api/v1/topups/${TOPUP}`]: ok(view("pending_payment", "00020101FAKEx")),
    });
    renderAt("/carteira");
    fireEvent.click(await screen.findByRole("button", { name: "Pagar débito (R$ 13,50)" }));
    expect(((await screen.findByLabelText("Código Pix")) as HTMLTextAreaElement).value).toBe("00020101FAKEx");
    const post = fn.mock.calls.find((c) => c[1]?.method === "POST")!;
    expect(JSON.parse(post[1]!.body as string)).toEqual({ purpose: "debt" });
    expect((post[1]!.headers as Record<string, string>)["idempotency-key"]).toBeTruthy();
  });

  it("validates free credits between R$ 10,00 and R$ 1.000,00", async () => {
    const fn = mockApi({ "GET /api/v1/wallet": ok({ ...WALLET, balanceCents: 500 }), "POST /api/v1/topups": ok(view("pending_payment", "x")), [`GET /api/v1/topups/${TOPUP}`]: ok(view("pending_payment", "x")) });
    renderAt("/carteira");
    const input = await screen.findByLabelText("Valor (R$ 10,00 a R$ 1.000,00)");
    expect(screen.queryByRole("button", { name: /Pagar débito/ })).toBeNull();
    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Adicionar créditos" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Informe um valor entre R$ 10,00 e R$ 1.000,00.");
    expect(fn.mock.calls.some((c) => c[1]?.method === "POST")).toBe(false);
    fireEvent.change(input, { target: { value: "25,50" } });
    fireEvent.click(screen.getByRole("button", { name: "Adicionar créditos" }));
    await waitFor(() => expect(fn.mock.calls.some((c) => c[1]?.method === "POST")).toBe(true));
    const post = fn.mock.calls.find((c) => c[1]?.method === "POST")!;
    expect(JSON.parse(post[1]!.body as string)).toEqual({ purpose: "credit", amountCents: 2550 });
  });

  it("shows the confirmation with the new balance once paid", async () => {
    mockApi({ [`GET /api/v1/topups/${TOPUP}`]: ok(view("paid", "x")) });
    renderAt(`/carteira/recarga/${TOPUP}`);
    expect(await screen.findByText("Pagamento confirmado! Saldo: R$ 0,00")).toBeTruthy();
  });

  it("announces the status, shows the expiry and stops polling once paid, retrying after a server error", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const fn = mockApi({
        [`GET /api/v1/topups/${TOPUP}`]: [ok(view("pending_payment", "00020101FAKEx")), { status: 503, body: { error: { code: "internal_error", message: "x" } } }, ok(view("paid", "x"))],
      });
      renderAt(`/carteira/recarga/${TOPUP}`);
      const status = await screen.findByRole("status");
      expect(status.textContent).toContain("Aguardando o pagamento…");
      const until = new Date("2030-05-10T13:01:00.000Z").toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
      expect(screen.getByText(`Vale até ${until}`)).toBeTruthy();
      await vi.advanceTimersByTimeAsync(3000);
      expect(await screen.findByRole("alert")).toBeTruthy();
      await vi.advanceTimersByTimeAsync(3000);
      await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Pagamento confirmado! Saldo: R$ 0,00"));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fn.mock.calls.filter((c) => c[0] === `/api/v1/topups/${TOPUP}`)).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reuses the idempotency key after a failed POST", async () => {
    const fn = mockApi({
      "GET /api/v1/wallet": ok(WALLET),
      "POST /api/v1/topups": [{ status: 0 }, ok(view("pending_payment", "00020101FAKEx"))],
      [`GET /api/v1/topups/${TOPUP}`]: ok(view("pending_payment", "00020101FAKEx")),
    });
    renderAt("/carteira");
    fireEvent.click(await screen.findByRole("button", { name: "Pagar débito (R$ 13,50)" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Pagar débito (R$ 13,50)" }));
    await screen.findByLabelText("Código Pix");
    const keys = fn.mock.calls.filter((c) => c[1]?.method === "POST").map((c) => (c[1]!.headers as Record<string, string>)["idempotency-key"]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });

  it("shows Voltar only when there is in-app history", async () => {
    mockApi({ "GET /api/v1/wallet": ok(WALLET) });
    renderAt("/carteira");
    await screen.findByText("Débito: R$ 13,50");
    expect(screen.queryByRole("button", { name: "Voltar" })).toBeNull();
    cleanup();
    renderAt("/carteira", "/pedido");
    await screen.findByText("Débito: R$ 13,50");
    expect(screen.getByRole("button", { name: "Voltar" })).toBeTruthy();
  });
});
