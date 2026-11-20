import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminHome } from "./AdminHome";
import { AdminLayout } from "./AdminLayout";
import { KitchenDevicesPage, MenuPage, ServiceDaysPage } from "./LunchPages";

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
const DEVICES: Reply = { status: 200, body: { devices: [] } };
const DASH_EMPTY: Reply = { status: 200, body: { period: "today", from: "2030-03-04", to: "2030-03-04", snacks: { paidOrders: 0, deliveredOrders: 0, notCollectedOrders: 0, counterSales: 0, topItems: [] }, documents: null, money: null } };
const CLASSES: Reply = {
  status: 200,
  body: {
    classes: [
      { id: "0193a000-0000-7000-8000-0000000000c1", name: "Infantil 3A", shift: "matutino" },
      { id: "0193a000-0000-7000-8000-0000000000c2", name: "Infantil 5C", shift: "vespertino" },
    ],
  },
};
const BASE = { "GET /api/admin/v1/menu-items": MENU, "GET /api/admin/v1/service-days": DAYS, "GET /api/admin/v1/classes": CLASSES };

const OPEN_DAY = {
  serviceDate: "2030-03-04",
  cutoffAt: "2030-03-04T10:30:00.000Z",
  freezeAt: "2030-03-04T11:00:00.000Z",
  status: "open",
  shifts: [{ shift: "matutino", cutoffAt: "2030-03-04T10:30:00.000Z", freezeAt: "2030-03-04T11:00:00.000Z", status: "open" }],
  items: [{ menuItemId: ID_PAO, name: "Pão", priceCents: 350 }],
};

function renderAdmin(path = "/admin") {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<AdminHome />} />
          <Route path="lanche/dias" element={<ServiceDaysPage />} />
          <Route path="lanche/cardapio" element={<MenuPage />} />
          <Route path="lanche/tablets" element={<KitchenDevicesPage />} />
        </Route>
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
    renderAdmin("/admin/lanche/cardapio");
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
    renderAdmin("/admin/lanche/cardapio");
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
    renderAdmin("/admin/lanche/cardapio");
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
    renderAdmin("/admin/lanche/cardapio");
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
    renderAdmin("/admin/lanche/cardapio");
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
    renderAdmin("/admin/lanche/dias");
    await screen.findByRole("checkbox", { name: "Pão" });
    fireEvent.change(screen.getByLabelText("Data"), { target: { value: "2030-03-04" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Pão" }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar dia" }));
    await waitFor(() => expect(callOf(fn, "PUT /api/admin/v1/service-days/2030-03-04")).toBeDefined());
    expect(callOf(fn, "PUT /api/admin/v1/service-days/2030-03-04")!.body).toEqual({ items: [{ menuItemId: ID_PAO }] });
  });

  it("asks one optional cutoff per shift that has classes and sends only the filled ones", async () => {
    const fn = mockApi({
      ...BASE,
      "GET /api/admin/v1/me": me("secretaria"),
      "PUT /api/admin/v1/service-days/2030-03-04": { status: 200, body: OPEN_DAY },
    });
    renderAdmin("/admin/lanche/dias");
    await screen.findByRole("checkbox", { name: "Pão" });
    fireEvent.change(screen.getByLabelText("Data"), { target: { value: "2030-03-04" } });
    expect(await screen.findByLabelText("Corte — Manhã (opcional)")).toBeTruthy();
    fireEvent.change(await screen.findByLabelText("Corte — Tarde (opcional)"), { target: { value: "13:30" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Pão" }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar dia" }));
    await waitFor(() => expect(callOf(fn, "PUT /api/admin/v1/service-days/2030-03-04")).toBeDefined());
    expect(callOf(fn, "PUT /api/admin/v1/service-days/2030-03-04")!.body).toEqual({
      cutoffTimes: { vespertino: "13:30" },
      items: [{ menuItemId: ID_PAO }],
    });
  });

  it("closes a shift after confirming and reports the order count", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const fn = mockApi({
      "GET /api/admin/v1/menu-items": MENU,
      "GET /api/admin/v1/service-days": { status: 200, body: { serviceDays: [OPEN_DAY] } },
      "GET /api/admin/v1/classes": CLASSES,
      "GET /api/admin/v1/me": me("admin"),
      "POST /api/admin/v1/service-days/2030-03-04/shifts/matutino/close": {
        status: 200,
        body: {
          shift: "matutino",
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
    renderAdmin("/admin/lanche/dias");
    await screen.findByText(/04\/03\/2030/);
    expect(screen.getByText("Aberto")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Fechar turno — Manhã" }));
    expect(window.confirm).toHaveBeenCalledWith("Fechar o turno da manhã? Os pedidos não pagos expiram e o romaneio fica congelado.");
    await waitFor(() => expect(callOf(fn, "POST /api/admin/v1/service-days/2030-03-04/shifts/matutino/close")).toBeDefined());
    await waitFor(() => expect(screen.getAllByRole("status").map((s) => s.textContent)).toContain("Turno da manhã fechado: 3 pedidos."));
  });

  it("shows the locked-day message when the PUT is refused", async () => {
    mockApi({
      ...BASE,
      "GET /api/admin/v1/me": me("secretaria"),
      "PUT /api/admin/v1/service-days/2030-03-04": { status: 409, body: { error: { code: "service_day_locked", message: "x" } } },
    });
    renderAdmin("/admin/lanche/dias");
    await screen.findByRole("checkbox", { name: "Pão" });
    fireEvent.change(screen.getByLabelText("Data"), { target: { value: "2030-03-04" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Pão" }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar dia" }));
    await screen.findByText("Este dia já tem pedidos ou está fechado; o cardápio não pode mudar.");
  });
});

describe("lunch pages", () => {
  it("sends the kitchen role back to the home page", async () => {
    mockApi({ "GET /api/admin/v1/me": me("cozinha"), "GET /api/admin/v1/dashboard?period=today": DASH_EMPTY });
    renderAdmin("/admin/lanche/cardapio");
    await screen.findByRole("heading", { name: "Escola Sol" });
    expect(screen.queryByText("Pão — R$ 3,50")).toBeNull();
  });

  it.each([
    ["#cardapio", "Cardápio"],
    ["#dias", "Dias de serviço"],
    ["#tablets", "Tablets da cozinha"],
  ])("redirects the old anchor %s to its page", async (hash, heading) => {
    mockApi({ ...BASE, "GET /api/admin/v1/me": me("secretaria"), "GET /api/admin/v1/kds/devices": DEVICES });
    renderAdmin(`/admin${hash}`);
    expect(await screen.findByRole("heading", { level: 1, name: heading })).toBeTruthy();
  });

  it("shows each day's situation and each item's state as badges", async () => {
    mockApi({
      "GET /api/admin/v1/menu-items": MENU,
      "GET /api/admin/v1/service-days": { status: 200, body: { serviceDays: [OPEN_DAY] } },
      "GET /api/admin/v1/classes": CLASSES,
      "GET /api/admin/v1/me": me("admin"),
    });
    renderAdmin("/admin/lanche/dias");
    expect((await screen.findByText("Aberto")).className).toContain("badge");
    cleanup();
    renderAdmin("/admin/lanche/cardapio");
    expect((await screen.findByText("Inativo")).className).toContain("badge");
  });
});
