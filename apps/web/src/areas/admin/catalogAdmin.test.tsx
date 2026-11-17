import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminHome } from "./AdminHome";

type Reply = { status: number; body: unknown };

const ID_PAO = "0193a000-0000-7000-8000-0000000000a1";
const ID_SUCO = "0193a000-0000-7000-8000-0000000000a2";
const ID_NEW = "0193a000-0000-7000-8000-0000000000a3";

function me(role: string): Reply {
  return { status: 200, body: { id: "0193a000-0000-7000-8000-000000000001", email: "ana@escola.test", role, schoolName: "Escola Sol" } };
}

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

function callOf(fn: ReturnType<typeof mockApi>, key: string) {
  const call = fn.mock.calls.find((c) => `${c[1]?.method ?? "GET"} ${c[0]}` === key);
  return call && { init: call[1]!, body: JSON.parse((call[1]!.body as string | undefined) ?? "null") as unknown };
}

const MENU: Reply = {
  status: 200,
  body: {
    items: [
      { id: ID_PAO, name: "Pão", priceCents: 350, active: true },
      { id: ID_SUCO, name: "Suco", priceCents: 500, active: false },
    ],
  },
};
const DAYS: Reply = { status: 200, body: { serviceDays: [] } };
const BASE = { "GET /api/admin/v1/menu-items": MENU, "GET /api/admin/v1/service-days": DAYS };

const OPEN_DAY = {
  serviceDate: "2030-03-04",
  cutoffAt: "2030-03-04T10:30:00.000Z",
  freezeAt: "2030-03-04T11:00:00.000Z",
  status: "open",
  items: [{ menuItemId: ID_PAO, name: "Pão", priceCents: 350 }],
};

function renderAdmin() {
  render(
    <MemoryRouter initialEntries={["/admin"]}>
      <Routes>
        <Route path="/admin" element={<AdminHome />} />
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

describe("menu admin", () => {
  it("lists items and creates a new one with an idempotency key", async () => {
    const fn = mockApi({
      ...BASE,
      "GET /api/admin/v1/me": me("secretaria"),
      "POST /api/admin/v1/menu-items": { status: 200, body: { id: ID_NEW, name: "Pão de queijo", priceCents: 450, active: true } },
    });
    renderAdmin();
    await screen.findByText("Pão — R$ 3,50");
    await screen.findByText("Suco — R$ 5,00 (inativo)");
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Pão de queijo" } });
    fireEvent.change(screen.getByLabelText("Preço (R$)"), { target: { value: "4,50" } });
    fireEvent.click(screen.getByRole("button", { name: "Adicionar" }));
    await screen.findByText("Pão de queijo — R$ 4,50");
    const post = callOf(fn, "POST /api/admin/v1/menu-items")!;
    expect(post.body).toEqual({ name: "Pão de queijo", priceCents: 450 });
    expect((post.init.headers as Record<string, string>)["idempotency-key"]).toBeTruthy();
  });

  it("refuses an invalid price without calling the API", async () => {
    const fn = mockApi({ ...BASE, "GET /api/admin/v1/me": me("admin") });
    renderAdmin();
    await screen.findByText("Pão — R$ 3,50");
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Bolo" } });
    fireEvent.change(screen.getByLabelText("Preço (R$)"), { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Adicionar" }));
    await screen.findByText("Preço inválido.");
    expect(callOf(fn, "POST /api/admin/v1/menu-items")).toBeUndefined();
  });

  it("uses a new idempotency key after the form was edited, and reuses it on a pure retry", async () => {
    const replies: Record<string, Reply> = {
      ...BASE,
      "GET /api/admin/v1/me": me("secretaria"),
      "POST /api/admin/v1/menu-items": { status: 409, body: { error: { code: "menu_item_name_taken", message: "x" } } },
    };
    const fn = mockApi(replies);
    renderAdmin();
    await screen.findByText("Pão — R$ 3,50");
    const keys = () =>
      fn.mock.calls
        .filter((c) => c[1]?.method === "POST")
        .map((c) => (c[1]!.headers as Record<string, string>)["idempotency-key"]);
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Pão" } });
    fireEvent.change(screen.getByLabelText("Preço (R$)"), { target: { value: "4,50" } });
    fireEvent.click(screen.getByRole("button", { name: "Adicionar" }));
    await screen.findByText("Já existe um item com esse nome.");
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Pão de queijo" } });
    replies["POST /api/admin/v1/menu-items"] = {
      status: 200,
      body: { id: ID_NEW, name: "Pão de queijo", priceCents: 450, active: true },
    };
    fireEvent.click(screen.getByRole("button", { name: "Adicionar" }));
    await screen.findByText("Pão de queijo — R$ 4,50");
    const [first, second] = keys();
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });

  it("reuses the idempotency key when resubmitting unchanged after a network error", async () => {
    const fn = mockApi({
      ...BASE,
      "GET /api/admin/v1/me": me("secretaria"),
    });
    fn.mockImplementation(async (url, init) => {
      const key = `${init?.method ?? "GET"} ${url}`;
      if (key === "POST /api/admin/v1/menu-items") throw new TypeError("offline");
      if (key === "GET /api/admin/v1/me") return new Response(JSON.stringify(me("secretaria").body));
      if (key === "GET /api/admin/v1/menu-items") return new Response(JSON.stringify(MENU.body));
      return new Response(JSON.stringify(DAYS.body));
    });
    renderAdmin();
    await screen.findByText("Pão — R$ 3,50");
    fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Bolo" } });
    fireEvent.change(screen.getByLabelText("Preço (R$)"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Adicionar" }));
    await screen.findByText("Sem conexão. Verifique a internet e tente de novo.");
    fireEvent.click(screen.getByRole("button", { name: "Adicionar" }));
    await waitFor(() => expect(fn.mock.calls.filter((c) => c[1]?.method === "POST")).toHaveLength(2));
    const keys = fn.mock.calls
      .filter((c) => c[1]?.method === "POST")
      .map((c) => (c[1]!.headers as Record<string, string>)["idempotency-key"]);
    expect(keys[1]).toBe(keys[0]);
  });

  it("deactivates an item", async () => {
    const fn = mockApi({
      ...BASE,
      "GET /api/admin/v1/me": me("secretaria"),
      [`PATCH /api/admin/v1/menu-items/${ID_PAO}`]: { status: 200, body: { id: ID_PAO, name: "Pão", priceCents: 350, active: false } },
    });
    renderAdmin();
    await screen.findByText("Pão — R$ 3,50");
    fireEvent.click(screen.getByRole("button", { name: "Desativar" }));
    await screen.findByText("Pão — R$ 3,50 (inativo)");
    expect(callOf(fn, `PATCH /api/admin/v1/menu-items/${ID_PAO}`)!.body).toEqual({ active: false });
  });
});

describe("service days admin", () => {
  it("opens a day with the chosen items and no cutoff when empty", async () => {
    const fn = mockApi({
      ...BASE,
      "GET /api/admin/v1/me": me("secretaria"),
      "PUT /api/admin/v1/service-days/2030-03-04": { status: 200, body: OPEN_DAY },
    });
    renderAdmin();
    await screen.findByText("Pão — R$ 3,50");
    fireEvent.change(screen.getByLabelText("Data"), { target: { value: "2030-03-04" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Pão" }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar dia" }));
    await waitFor(() => expect(callOf(fn, "PUT /api/admin/v1/service-days/2030-03-04")).toBeDefined());
    expect(callOf(fn, "PUT /api/admin/v1/service-days/2030-03-04")!.body).toEqual({ items: [{ menuItemId: ID_PAO }] });
  });

  it("closes a day after confirming and reports the order count", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mockApi({
      "GET /api/admin/v1/menu-items": MENU,
      "GET /api/admin/v1/service-days": { status: 200, body: { serviceDays: [OPEN_DAY] } },
      "GET /api/admin/v1/me": me("admin"),
      "POST /api/admin/v1/service-days/2030-03-04/close": {
        status: 200,
        body: {
          status: "closed",
          closed_at: "2030-03-04T11:00:00.000Z",
          manifest_version: 1,
          kitchen_phone: null,
          totals: { orders: 3, by_item: [{ item: "Pão", qty: 3 }] },
          by_class: [],
          late_credits: 0,
        },
      },
    });
    renderAdmin();
    await screen.findByText(/04\/03\/2030/);
    fireEvent.click(screen.getByRole("button", { name: "Fechar dia" }));
    await screen.findByText("Dia fechado: 3 pedidos.");
    expect(window.confirm).toHaveBeenCalledWith("Fechar o dia? Os pedidos não pagos expiram e o romaneio fica congelado.");
  });

  it("shows the locked-day message when the PUT is refused", async () => {
    mockApi({
      ...BASE,
      "GET /api/admin/v1/me": me("secretaria"),
      "PUT /api/admin/v1/service-days/2030-03-04": { status: 409, body: { error: { code: "service_day_locked", message: "x" } } },
    });
    renderAdmin();
    await screen.findByText("Pão — R$ 3,50");
    fireEvent.change(screen.getByLabelText("Data"), { target: { value: "2030-03-04" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Pão" }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar dia" }));
    await screen.findByText("Este dia já tem pedidos ou está fechado; o cardápio não pode mudar.");
  });

  it("hides both sections from the kitchen role", async () => {
    mockApi({ "GET /api/admin/v1/me": me("cozinha") });
    renderAdmin();
    await screen.findByText("Escola Sol");
    expect(screen.queryByText("Cardápio")).toBeNull();
    expect(screen.queryByText("Dias de serviço")).toBeNull();
  });
});
