import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountPage } from "./AccountPage";
import { AccountsAdmin } from "./AccountsAdmin";
import { CounterSaleAdmin } from "./CounterSaleAdmin";

type Reply = { status: number; body?: unknown };

/** Respostas por "MÉTODO url"; uma lista é consumida em ordem e o último item se repete. */
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
const calls = (fn: ReturnType<typeof mockApi>, key: string) => fn.mock.calls.filter((c) => `${c[1]?.method ?? "GET"} ${c[0]}` === key);
const bodyOf = (fn: ReturnType<typeof mockApi>, key: string, n = 0) => JSON.parse(calls(fn, key)[n]![1]!.body as string);

const U = (n: number) => `0193a000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const [ANA, BRUNO, CARLA, LEO, MISTO, SALE, TOPUP] = [U(1), U(2), U(3), U(4), U(5), U(6), U(7)];

function renderAt(path: string, role = "secretaria") {
  const me = { id: U(99), email: "equipe@escola.test", role, schoolName: "Escola Sol" };
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<Outlet context={{ me, meFailed: false }} />}>
          <Route path="/admin/contas" element={<AccountsAdmin />} />
          <Route path="/admin/contas/lancar" element={<CounterSaleAdmin />} />
          <Route path="/admin/contas/:guardianId" element={<AccountPage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

const ACCOUNTS = {
  debtLimitCents: 5000,
  accounts: [
    { guardianId: ANA, firstName: "Ana", students: ["Bia", "Léo"], balanceCents: -6200 },
    { guardianId: BRUNO, firstName: "Bruno", students: ["Caio"], balanceCents: -900 },
    { guardianId: CARLA, firstName: "Carla", students: ["Duda"], balanceCents: 3000 },
  ],
  overLimitSales: [{ saleId: SALE, guardianId: ANA, guardianFirstName: "Ana", studentFirstName: "Bia", occurredAt: "2031-11-05T12:00:00.000Z", totalCents: 1800 }],
};
const SETTINGS = { status: 200, body: { debtLimitCents: 5000 } };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AccountsAdmin", () => {
  it("lists debts first, filters and warns about over-limit sales", async () => {
    mockApi({ "GET /api/admin/v1/accounts": { status: 200, body: ACCOUNTS }, "GET /api/admin/v1/school/settings": SETTINGS });
    renderAt("/admin/contas");
    expect(await screen.findByText("débito R$ 62,00")).toBeTruthy();
    expect(within(screen.getByTestId("over-limit-alert")).getByText(/Bia/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Só com débito"));
    expect(screen.queryByText("Carla")).toBeNull();
    fireEvent.change(screen.getByLabelText("Buscar responsável ou aluno"), { target: { value: "caio" } });
    const table = within(screen.getByRole("table"));
    expect(table.queryByText("Ana")).toBeNull();
    expect(table.getByText("Bruno")).toBeTruthy();
    expect(screen.getByText("Cada responsável pode ficar devendo até R$ 50,00.")).toBeTruthy();
  });

  it("lets an admin change the debt limit", async () => {
    const fn = mockApi({
      "GET /api/admin/v1/accounts": { status: 200, body: ACCOUNTS },
      "GET /api/admin/v1/school/settings": SETTINGS,
      "PUT /api/admin/v1/school/settings": { status: 200, body: { debtLimitCents: 8000 } },
    });
    renderAt("/admin/contas", "admin");
    const input = await screen.findByLabelText("Cada responsável pode ficar devendo até (R$)");
    expect((input as HTMLInputElement).value).toBe("50,00");
    fireEvent.change(input, { target: { value: "80" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar limite" }));
    await waitFor(() => expect(calls(fn, "PUT /api/admin/v1/school/settings")).toHaveLength(1));
    expect(bodyOf(fn, "PUT /api/admin/v1/school/settings")).toEqual({ debtLimitCents: 8000 });
  });
});

const STATEMENT = {
  guardian: { id: ANA, firstName: "Ana" },
  balanceCents: -1350,
  debtLimitCents: 5000,
  entries: [
    { id: U(11), kind: "counter_charge", amountCents: -900, createdAt: "2031-11-05T12:00:00.000Z", saleId: SALE, studentFirstName: "Bia", overLimit: true, voided: false },
    { id: U(12), kind: "counter_charge", amountCents: -450, createdAt: "2031-11-05T11:00:00.000Z", saleId: U(13), studentFirstName: "Léo", overLimit: false, voided: true },
  ],
};
const TOPUP_VIEW = {
  id: TOPUP,
  status: "pending_payment",
  amountCents: 1350,
  createdAt: "2031-11-05T12:01:00.000Z",
  paidAt: null,
  balanceCents: -1350,
  payment: { status: "pending", amountCents: 1350, pixCopyPaste: "00020101FAKEcharge", pixQrPngBase64: null, expiresAt: "2031-11-05T13:01:00.000Z" },
};

describe("AccountPage", () => {
  it("shows the statement and voids a counter sale after confirmation", async () => {
    vi.stubGlobal("confirm", () => true);
    const fn = mockApi({
      [`GET /api/admin/v1/guardians/${ANA}/statement`]: { status: 200, body: STATEMENT },
      [`POST /api/admin/v1/counter-sales/${SALE}/void`]: { status: 200, body: { saleId: SALE, balanceCents: -450 } },
    });
    renderAt(`/admin/contas/${ANA}`);
    expect(await screen.findByText("Lanche no balcão — Bia")).toBeTruthy();
    expect(screen.getByText("acima do limite")).toBeTruthy();
    expect(screen.getByText("estornado")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Estornar lançamento de Bia" }));
    await waitFor(() => expect(calls(fn, `POST /api/admin/v1/counter-sales/${SALE}/void`)).toHaveLength(1));
    await waitFor(() => expect(calls(fn, `GET /api/admin/v1/guardians/${ANA}/statement`)).toHaveLength(2));
  });

  it("generates a Pix for the debt and sends the payment link", async () => {
    const fn = mockApi({
      [`GET /api/admin/v1/guardians/${ANA}/statement`]: { status: 200, body: STATEMENT },
      [`POST /api/admin/v1/guardians/${ANA}/topups`]: { status: 200, body: TOPUP_VIEW },
      [`POST /api/admin/v1/guardians/${ANA}/payment-requests`]: { status: 200, body: { amountDueCents: 1350 } },
    });
    renderAt(`/admin/contas/${ANA}`, "cozinha");
    const amount = await screen.findByLabelText("Valor do Pix (R$)");
    expect((amount as HTMLInputElement).value).toBe("13,50");
    fireEvent.click(screen.getByRole("button", { name: "Gerar QR de pagamento" }));
    expect(((await screen.findByLabelText("Pix copia e cola")) as HTMLTextAreaElement).value).toBe("00020101FAKEcharge");
    expect(bodyOf(fn, `POST /api/admin/v1/guardians/${ANA}/topups`)).toEqual({ amountCents: 1350 });
    expect((calls(fn, `POST /api/admin/v1/guardians/${ANA}/topups`)[0]![1]!.headers as Record<string, string>)["idempotency-key"]).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Estornar lançamento de Bia" })).toBeNull(); // cozinha não estorna
    fireEvent.click(screen.getByRole("button", { name: "Enviar link de pagamento por WhatsApp" }));
    await waitFor(() => expect(calls(fn, `POST /api/admin/v1/guardians/${ANA}/payment-requests`)).toHaveLength(1));
  });
});

describe("CounterSaleAdmin", () => {
  it("asks before going over the limit and resends with the confirmation", async () => {
    vi.stubGlobal("confirm", () => true);
    const roster = {
      debtLimitCents: 5000,
      items: [{ id: MISTO, name: "Misto quente", priceCents: 900 }],
      students: [{ id: LEO, firstName: "Léo", className: "Infantil 3A", restrictions: null, guardian: { id: ANA, firstName: "Ana", balanceCents: -4500 } }],
    };
    const fn = mockApi({
      "GET /api/admin/v1/counter/roster": { status: 200, body: roster },
      "POST /api/admin/v1/counter-sales": [
        { status: 409, body: { error: { code: "insufficient_balance", message: "x" } } },
        { status: 200, body: { saleId: SALE, totalCents: 900, balanceCents: -5400, overLimit: true } },
      ],
    });
    renderAt("/admin/contas/lancar");
    fireEvent.change(await screen.findByLabelText("Aluno"), { target: { value: LEO } });
    fireEvent.change(screen.getByLabelText("Quantidade de Misto quente"), { target: { value: "1" } });
    expect(screen.getByText("Passa do limite de débito: será pedida confirmação.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Lançar" }));
    await waitFor(() => expect(calls(fn, "POST /api/admin/v1/counter-sales")).toHaveLength(2));
    expect(bodyOf(fn, "POST /api/admin/v1/counter-sales", 0)).toEqual({ studentId: LEO, items: [{ menuItemId: MISTO, qty: 1 }] });
    expect(bodyOf(fn, "POST /api/admin/v1/counter-sales", 1)).toEqual({ studentId: LEO, items: [{ menuItemId: MISTO, qty: 1 }], allowOverLimit: true });
  });
});
