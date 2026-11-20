import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { announce, StatusNotice } from "../notify";
import { LayoutProvider } from "./LayoutContext";
import { AppShell } from "./AppShell";
import { AppSidebar, type NavItem } from "./AppSidebar";
import { PageTitle } from "./PageTitle";

const NAV: NavItem[] = [
  { to: "/admin", label: "Início", icon: "pe-7s-home", isActive: (l) => l.pathname === "/admin" && l.hash === "" },
  { to: "/admin/alunos", label: "Alunos e responsáveis", icon: "pe-7s-users", isActive: (l) => l.pathname.startsWith("/admin/alunos") },
  { to: "/admin#cardapio", label: "Cardápio", icon: "pe-7s-note2", isActive: (l) => l.pathname === "/admin" && l.hash === "#cardapio" },
];

function Saver() {
  const [message, setMessage] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setMessage("Dados salvos.");
          announce("Dados salvos.");
        }}
      >
        Salvar
      </button>
      <StatusNotice message={message} />
    </>
  );
}

function renderShell(path: string, onLogout = vi.fn()) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="*"
          element={
            <AppShell nav={NAV} schoolName="Escola Sol" user={{ email: "ana@escola.test", roleLabel: "Secretaria" }} onLogout={onLogout}>
              <PageTitle heading="Página de teste" subheading="Subtítulo" />
              <Saver />
            </AppShell>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  return onLogout;
}

const shell = () => document.querySelector(".app-container")!;
const link = (name: string) => screen.getByRole("link", { name });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("AppShell", () => {
  it("highlights the current page", () => {
    renderShell("/admin/alunos/qualquer");
    expect(link("Alunos e responsáveis").getAttribute("aria-current")).toBe("page");
    expect(link("Alunos e responsáveis").className).toContain("active");
    expect(link("Início").getAttribute("aria-current")).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Página de teste" })).toBeTruthy();
  });

  it("highlights a home section by its anchor and follows navigation", () => {
    renderShell("/admin#cardapio");
    expect(link("Cardápio").getAttribute("aria-current")).toBe("page");
    expect(link("Início").getAttribute("aria-current")).toBeNull();
    fireEvent.click(link("Início"));
    expect(link("Início").getAttribute("aria-current")).toBe("page");
    expect(link("Cardápio").getAttribute("aria-current")).toBeNull();
  });

  it("opens the mobile menu and closes it with Escape or after navigating", () => {
    renderShell("/admin");
    fireEvent.click(screen.getByRole("button", { name: "Abrir menu" }));
    expect(shell().classList.contains("sidebar-mobile-open")).toBe(true);
    expect(screen.getByRole("button", { name: "Fechar menu" }).getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(shell().classList.contains("sidebar-mobile-open")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Abrir menu" }));
    fireEvent.click(link("Alunos e responsáveis"));
    expect(shell().classList.contains("sidebar-mobile-open")).toBe(false);
    expect(screen.getByRole("button", { name: "Abrir menu" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("closes the mobile menu when the current page's link is tapped", () => {
    renderShell("/admin/alunos");
    fireEvent.click(screen.getByRole("button", { name: "Abrir menu" }));
    fireEvent.click(link("Alunos e responsáveis"));
    expect(shell().classList.contains("sidebar-mobile-open")).toBe(false);
  });

  it("moves focus into the mobile menu on open and back to the toggle on Escape", () => {
    renderShell("/admin");
    const toggle = screen.getByRole("button", { name: "Abrir menu" });
    toggle.focus();
    fireEvent.click(toggle);
    expect(document.activeElement).toBe(link("Início"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(shell().classList.contains("sidebar-mobile-open")).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Abrir menu" }));
  });

  it("collapses the sidebar and remembers it", () => {
    renderShell("/admin");
    fireEvent.click(screen.getByRole("button", { name: "Recolher menu" }));
    expect(shell().classList.contains("closed-sidebar")).toBe(true);
    expect(localStorage.getItem("app-lanche:sidebar-collapsed")).toBe("1");
    cleanup();
    renderShell("/admin");
    expect(shell().classList.contains("closed-sidebar")).toBe(true);
    expect(screen.getByRole("button", { name: "Expandir menu" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps working when the browser blocks storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    renderShell("/admin");
    expect(shell().classList.contains("closed-sidebar")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Recolher menu" }));
    expect(shell().classList.contains("closed-sidebar")).toBe(true);
  });

  it("shows the school and the user, and logs out", () => {
    const onLogout = renderShell("/admin");
    expect(screen.getByText("Escola Sol")).toBeTruthy();
    expect(screen.getByText("ana@escola.test")).toBeTruthy();
    expect(screen.getByText("Secretaria")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sair" }));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it("puts the small logo badge before the school name for the phone header", () => {
    renderShell("/admin");
    const left = screen.getByText("Escola Sol").closest(".app-header-left")!;
    const badge = left.querySelector(".app-header__mobile-badge img");
    expect(badge?.getAttribute("alt")).toBe("");
    expect(left.firstElementChild?.classList.contains("app-header__mobile-badge")).toBe(true);
  });

  it("shows success as a toast and announces it once, with role=status", async () => {
    renderShell("/admin");
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(document.querySelector(".Toastify")?.textContent).toContain("Dados salvos."));
    expect(document.querySelector(".Toastify")!.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Dados salvos.");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders a group heading in the sidebar as plain text, not a link", () => {
    render(
      <MemoryRouter>
        <LayoutProvider>
          <AppSidebar items={[{ heading: "Lanche" }, NAV[0]!]} />
        </LayoutProvider>
      </MemoryRouter>,
    );
    const heading = screen.getByText("Lanche");
    expect(heading.tagName).toBe("LI");
    expect(heading.className).toContain("app-sidebar__heading");
    expect(heading.querySelector("a")).toBeNull();
  });
});
