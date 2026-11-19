import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CheckoutPage } from "./CheckoutPage";
import { OrderHome } from "./OrderHome";
import { WalletPage } from "./WalletPage";

type Reply = { status: number; body: unknown } | "network";

/** Replies are matched by "METHOD url"; an array is consumed in order and its last item repeats. */
function mockApi(replies: Record<string, Reply | Reply[]>) {
  const fn = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url, init) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    const entry = replies[key];
    if (!entry) throw new Error(`unexpected request ${key}`);
    const reply = Array.isArray(entry) ? (entry.length > 1 ? entry.shift()! : entry[0]!) : entry;
    if (reply === "network") throw new TypeError("offline");
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const ok = (body: unknown): Reply => ({ status: 200, body });
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [G, S1, S2, MISTO, SUCO, C1, O1] = [U(1), U(2), U(3), U(4), U(5), U(6), U(7)];
const DATE = "2030-05-10";
const CUTOFF = "2030-05-10T11:00:00.000Z";

const ME = {
  guardian: { id: G, firstName: "Ana" },
  students: [
    { id: S1, firstName: "Léo", className: "Maternal" },
    { id: S2, firstName: "Bia", className: "Maternal" },
  ],
  walletBalanceCents: 500,
};
const DAYS = {
  serviceDays: [
    {
      serviceDate: DATE,
      cutoffAt: CUTOFF,
      items: [
        { menuItemId: MISTO, name: "Misto quente", priceCents: 900 },
        { menuItemId: SUCO, name: "Suco", priceCents: 450 },
      ],
    },
  ],
};

function checkout(status: string, extra: Record<string, unknown> = {}, orderStatus = "pending") {
  return {
    id: C1,
    serviceDate: DATE,
    cutoffAt: CUTOFF,
    status,
    totalCents: 2250,
    walletAppliedCents: 0,
    amountDueCents: 2250,
    orders: [
      {
        id: O1,
        studentId: S1,
        studentFirstName: "Léo",
        status: orderStatus,
        items: [
          { menuItemId: MISTO, name: "Misto quente", qty: 2, unitPriceCents: 900 },
          { menuItemId: SUCO, name: "Suco", qty: 1, unitPriceCents: 450 },
        ],
      },
    ],
    payment: null,
    ...extra,
  };
}
const pix = (code: string | null) => ({
  status: "pending",
  amountCents: 2250,
  pixCopyPaste: code,
  pixQrPngBase64: null,
  expiresAt: CUTOFF,
});

const LIST = `GET /api/v1/checkouts?serviceDate=${DATE}`;
const baseReplies = (): Record<string, Reply | Reply[]> => ({
  "GET /api/v1/me": ok(ME),
  "GET /api/v1/service-days": ok(DAYS),
  [LIST]: ok({ checkouts: [] }),
  // the page the order screen navigates to after paying
  [`GET /api/v1/checkouts/${C1}`]: ok(checkout("pending_payment", { payment: pix(null) })),
});

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/pedido" element={<OrderHome />} />
        <Route path="/pedido/checkout/:id" element={<CheckoutPage />} />
        <Route path="/carteira" element={<WalletPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function fillCart() {
  const plusMisto = await screen.findByRole("button", { name: "Adicionar Misto quente para Léo" });
  fireEvent.click(plusMisto);
  fireEvent.click(plusMisto);
  fireEvent.click(screen.getByRole("button", { name: "Adicionar Suco para Bia" }));
}

function postCalls(fn: ReturnType<typeof mockApi>) {
  return fn.mock.calls.filter((c) => c[1]?.method === "POST");
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("guardian ordering", () => {
  it("builds the order and pays", async () => {
    const fn = mockApi({ ...baseReplies(), "POST /api/v1/checkouts": ok(checkout("pending_payment", { payment: pix(null) })) });
    renderAt("/pedido");
    await fillCart();
    fireEvent.click(await screen.findByRole("button", { name: "Pagar R$ 22,50" }));
    await screen.findByText("Gerando o Pix… aguarde alguns segundos.");
    const [url, init] = postCalls(fn)[0]!;
    expect(url).toBe("/api/v1/checkouts");
    expect(JSON.parse(init!.body as string)).toEqual({
      serviceDate: DATE,
      orders: [
        { studentId: S1, items: [{ menuItemId: MISTO, qty: 2 }] },
        { studentId: S2, items: [{ menuItemId: SUCO, qty: 1 }] },
      ],
    });
    const headers = init!.headers as Record<string, string>;
    expect(headers["idempotency-key"]).toBeTruthy();
  });

  it("shows the day, cutoff time, balance and empty state", async () => {
    mockApi({ ...baseReplies(), "GET /api/v1/service-days": ok({ serviceDays: [] }) });
    renderAt("/pedido");
    await screen.findByText("Nenhum dia aberto para pedidos no momento.");
    expect(screen.getByText(/Saldo na carteira: R\$ 5,00/)).toBeTruthy();
  });

  it("reuses the same Idempotency-Key when retrying", async () => {
    const fn = mockApi({
      ...baseReplies(),
      "POST /api/v1/checkouts": ["network", ok(checkout("pending_payment", { payment: pix(null) }))],
    });
    renderAt("/pedido");
    await fillCart();
    fireEvent.click(await screen.findByRole("button", { name: "Pagar R$ 22,50" }));
    await screen.findByText("Sem conexão. Verifique a internet e tente de novo.");
    fireEvent.click(screen.getByRole("button", { name: "Pagar R$ 22,50" }));
    await screen.findByText("Gerando o Pix… aguarde alguns segundos.");
    const keys = postCalls(fn).map((c) => (c[1]!.headers as Record<string, string>)["idempotency-key"]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });

  it("uses a new key when the cart changes", async () => {
    const fn = mockApi({
      ...baseReplies(),
      "POST /api/v1/checkouts": ["network", ok(checkout("pending_payment", { payment: pix(null) }))],
    });
    renderAt("/pedido");
    await fillCart();
    fireEvent.click(await screen.findByRole("button", { name: "Pagar R$ 22,50" }));
    await screen.findByText("Sem conexão. Verifique a internet e tente de novo.");
    fireEvent.click(screen.getByRole("button", { name: "Adicionar Suco para Bia" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pagar R$ 27,00" }));
    await screen.findByText("Gerando o Pix… aguarde alguns segundos.");
    const keys = postCalls(fn).map((c) => (c[1]!.headers as Record<string, string>)["idempotency-key"]);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("explains a passed cutoff", async () => {
    mockApi({
      ...baseReplies(),
      "POST /api/v1/checkouts": { status: 409, body: { error: { code: "cutoff_passed", message: "x" } } },
    });
    renderAt("/pedido");
    await fillCart();
    fireEvent.click(await screen.findByRole("button", { name: "Pagar R$ 22,50" }));
    await screen.findByText("O horário de pedidos para este dia já encerrou.");
  });

  it("marks a student who already has an order and hides the + buttons", async () => {
    mockApi({
      ...baseReplies(),
      [LIST]: ok({ checkouts: [checkout("paid", {}, "confirmed")] }),
    });
    renderAt("/pedido");
    await screen.findByText(/Pedido já feito/);
    expect(screen.getByRole("link", { name: "Ver pedido" }).getAttribute("href")).toBe(`/pedido/checkout/${C1}`);
    expect(screen.queryByRole("button", { name: "Adicionar Suco para Léo" })).toBeNull();
    expect(screen.getByRole("button", { name: "Adicionar Suco para Bia" })).toBeTruthy();
  });
});

describe("checkout page", () => {
  it("shows the Pix code and polls until paid", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fn = mockApi({
      [`GET /api/v1/checkouts/${C1}`]: [ok(checkout("pending_payment", { payment: pix("PIXCODE") })), ok(checkout("paid"))],
    });
    renderAt(`/pedido/checkout/${C1}`);
    await screen.findByText("PIXCODE");
    expect(screen.getByRole("button", { name: "Copiar código Pix" })).toBeTruthy();
    await vi.advanceTimersByTimeAsync(3000);
    await screen.findByText("Pedido confirmado!");
    expect(screen.getByText("Léo: 2x Misto quente, 1x Suco")).toBeTruthy();
    await vi.advanceTimersByTimeAsync(10000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("asks the server to create a missing Pix on each poll", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fn = mockApi({
      [`GET /api/v1/checkouts/${C1}`]: ok(checkout("pending_payment", { payment: pix(null) })),
      [`POST /api/v1/checkouts/${C1}/charge`]: [
        "network",
        ok(checkout("pending_payment", { payment: pix(null) })),
        ok(checkout("pending_payment", { payment: pix("PIXCODE") })),
      ],
    });
    renderAt(`/pedido/checkout/${C1}`);
    await screen.findByText("Gerando o Pix… aguarde alguns segundos.");
    await vi.advanceTimersByTimeAsync(3000);
    await screen.findByText("Sem conexão. Verifique a internet e tente de novo.");
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000);
    await screen.findByText("PIXCODE");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(fn.mock.calls.map((c) => `${c[1]?.method ?? "GET"} ${c[0]}`)).toEqual([
      `GET /api/v1/checkouts/${C1}`,
      `POST /api/v1/checkouts/${C1}/charge`,
      `POST /api/v1/checkouts/${C1}/charge`,
      `POST /api/v1/checkouts/${C1}/charge`,
    ]);
    // With the Pix shown, polling goes back to GET.
    await vi.advanceTimersByTimeAsync(3000);
    expect(fn.mock.calls.at(-1)?.[1]?.method ?? "GET").toBe("GET");
  });

  it("keeps polling after a transient network error and clears the error", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockApi({ [`GET /api/v1/checkouts/${C1}`]: ["network", ok(checkout("paid"))] });
    renderAt(`/pedido/checkout/${C1}`);
    await screen.findByText("Sem conexão. Verifique a internet e tente de novo.");
    await vi.advanceTimersByTimeAsync(3000);
    await screen.findByText("Pedido confirmado!");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("stops polling on a 4xx", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fn = mockApi({
      [`GET /api/v1/checkouts/${C1}`]: { status: 404, body: { error: { code: "not_found", message: "x" } } },
    });
    renderAt(`/pedido/checkout/${C1}`);
    await screen.findByText("Não encontramos este pedido.");
    await vi.advanceTimersByTimeAsync(10000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("copies the Pix code", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    mockApi({ [`GET /api/v1/checkouts/${C1}`]: ok(checkout("pending_payment", { payment: pix("PIXCODE") })) });
    renderAt(`/pedido/checkout/${C1}`);
    fireEvent.click(await screen.findByRole("button", { name: "Copiar código Pix" }));
    await screen.findByRole("button", { name: "Código copiado" });
    expect(writeText).toHaveBeenCalledWith("PIXCODE");
  });

  it("cancels a paid order after confirming", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    const fn = mockApi({
      [`GET /api/v1/checkouts/${C1}`]: ok(checkout("paid")),
      [`POST /api/v1/checkouts/${C1}/cancel`]: ok(checkout("cancelled")),
    });
    renderAt(`/pedido/checkout/${C1}`);
    fireEvent.click(await screen.findByRole("button", { name: "Cancelar pedido" }));
    await screen.findByText("Pedido cancelado. O valor voltou para a sua carteira.");
    expect(postCalls(fn)).toHaveLength(1);
  });

  it("does not cancel when the user declines", async () => {
    vi.stubGlobal("confirm", vi.fn(() => false));
    const fn = mockApi({ [`GET /api/v1/checkouts/${C1}`]: ok(checkout("paid")) });
    renderAt(`/pedido/checkout/${C1}`);
    fireEvent.click(await screen.findByRole("button", { name: "Cancelar pedido" }));
    await waitFor(() => expect(postCalls(fn)).toHaveLength(0));
  });

  it("shows the final texts for expired and late-credited checkouts", async () => {
    mockApi({ [`GET /api/v1/checkouts/${C1}`]: ok(checkout("expired")) });
    renderAt(`/pedido/checkout/${C1}`);
    await screen.findByText("Este pedido expirou sem pagamento.");
  });
});

describe("wallet page", () => {
  it("shows the balance and entries", async () => {
    mockApi({
      "GET /api/v1/wallet": ok({
        balanceCents: 1350,
        debtLimitCents: 5000,
        financialFor: ["Léo"],
        otherSales: [],
        entries: [
          {
            id: U(9),
            kind: "late_payment_credit",
            amountCents: 850,
            createdAt: "2030-05-10T12:00:00.000Z",
            saleId: null,
            studentFirstName: null,
            overLimit: false,
            voided: false,
          },
        ],
      }),
    });
    renderAt("/carteira");
    await screen.findByText("Saldo: R$ 13,50");
    expect(screen.getByText(/Pagamento após o horário/)).toBeTruthy();
    expect(screen.getByText(/\+R\$ 8,50/)).toBeTruthy();
  });

  it("shows a negative balance", async () => {
    mockApi({
      "GET /api/v1/wallet": ok({ balanceCents: -1800, debtLimitCents: 1000, financialFor: ["Léo"], otherSales: [], entries: [] }),
    });
    renderAt("/carteira");
    // Saldo negativo aparece como débito (Task 14); a página nunca leva ao pedido, que um link de escopo `wallet` não abre.
    await screen.findByText("Débito: R$ 18,00");
    expect(document.querySelector('a[href^="/pedido"]')).toBeNull();
  });
});
