import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "./Dashboard";

type Reply = { status: number; body: unknown };

function mockApi(replies: Record<string, Reply>) {
  const fn = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url, init) => {
    const reply = replies[`${init?.method ?? "GET"} ${url}`];
    if (!reply) throw new Error(`unexpected request ${url}`);
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const TODAY = {
  period: "today",
  from: "2026-11-20",
  to: "2026-11-20",
  snacks: { paidOrders: 42, deliveredOrders: 40, notCollectedOrders: 2, counterSales: 15, topItems: [{ name: "Misto quente", qty: 30 }] },
  documents: { published: 8, viewed: 6, batchesRendering: 1, batchesWithFailures: 0 },
  money: { pixReceivedCents: 125_000, counterCents: 22_500, creditsCents: 48_000, debtCents: 3_500, debtors: 3 },
};
const WEEK = { ...TODAY, period: "7d", from: "2026-11-14", snacks: { ...TODAY.snacks, paidOrders: 200 } };

function renderDashboard(role: "admin" | "secretaria" | "cozinha") {
  render(
    <MemoryRouter initialEntries={["/admin"]}>
      <Routes>
        <Route path="/admin" element={<Dashboard role={role} />} />
        <Route path="/admin/login" element={<p>login</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("admin dashboard", () => {
  it("shows counts and hides money values until asked, every time the page opens", async () => {
    mockApi({ "GET /api/admin/v1/dashboard?period=today": { status: 200, body: TODAY } });
    renderDashboard("secretaria");
    expect(await screen.findByText("42")).toBeTruthy();
    expect(screen.getByText("Misto quente — 30")).toBeTruthy();
    expect(screen.getByText("6 (75%)")).toBeTruthy();
    expect(screen.getAllByText("R$ ••••")).toHaveLength(4);
    expect(screen.queryByText("R$ 1.250,00")).toBeNull();
    expect(screen.getByText(/3 responsáveis/)).toBeTruthy();

    const toggle = screen.getByRole("button", { name: "Mostrar valores" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(screen.getByText("R$ 1.250,00")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ocultar valores" }).getAttribute("aria-pressed")).toBe("true");

    cleanup();
    renderDashboard("secretaria");
    await screen.findByText("42");
    expect(screen.getAllByText("R$ ••••")).toHaveLength(4);
  });

  it("switches the period and shows its date range", async () => {
    mockApi({
      "GET /api/admin/v1/dashboard?period=today": { status: 200, body: TODAY },
      "GET /api/admin/v1/dashboard?period=7d": { status: 200, body: WEEK },
    });
    renderDashboard("admin");
    await screen.findByText("Hoje (20/11/2026)");
    fireEvent.click(screen.getByRole("button", { name: "7 dias" }));
    await screen.findByText("200");
    expect(screen.getByText("De 14/11/2026 a 20/11/2026")).toBeTruthy();
    expect(screen.getByRole("button", { name: "7 dias" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("shows the kitchen only the snacks block, without the values button", async () => {
    mockApi({ "GET /api/admin/v1/dashboard?period=today": { status: 200, body: { ...TODAY, documents: null, money: null } } });
    renderDashboard("cozinha");
    await screen.findByText("42");
    expect(screen.queryByText("Documentos")).toBeNull();
    expect(screen.queryByText("Valores")).toBeNull();
    expect(screen.queryByRole("button", { name: "Mostrar valores" })).toBeNull();
  });

  it("shows a dash instead of a percentage when nothing was published", async () => {
    mockApi({ "GET /api/admin/v1/dashboard?period=today": { status: 200, body: { ...TODAY, documents: { ...TODAY.documents, published: 0, viewed: 0 } } } });
    renderDashboard("admin");
    await screen.findByText("42");
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("sends an expired session to the login", async () => {
    mockApi({ "GET /api/admin/v1/dashboard?period=today": { status: 401, body: { error: { code: "unauthenticated", message: "x" } } } });
    renderDashboard("admin");
    await screen.findByText("login");
  });
});
