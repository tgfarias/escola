import { cleanup, render, screen } from "@testing-library/react";
import { act } from "react";
import { MemoryRouter, useNavigate, type NavigateFunction } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

const paired = vi.hoisted(() => ({ value: false as boolean | "throws" }));

vi.mock("../areas/kds/sync", () => ({
  isPaired: async () => {
    if (paired.value === "throws") throw new Error("MissingAPIError");
    return paired.value;
  },
}));
vi.mock("../areas/kds/KdsApp", () => ({ default: () => <p>tela da cozinha</p> }));

const { App } = await import("./App");

function renderHome() {
  render(
    <MemoryRouter initialEntries={["/"]}>
      <App />
    </MemoryRouter>,
  );
}

describe("Home", () => {
  afterEach(cleanup);

  it("links to the kitchen tablet and stays put when the tablet is not paired", async () => {
    paired.value = false;
    renderHome();
    expect(screen.getByRole("link", { name: "Tablet da cozinha" }).getAttribute("href")).toBe("/kds");
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByText("Abra o link que a escola enviou pelo WhatsApp.")).toBeTruthy();
  });

  it("opens the KDS on a paired tablet", async () => {
    paired.value = true;
    renderHome();
    expect(await screen.findByText("tela da cozinha")).toBeTruthy();
  });

  it("keeps Home when the local store is unavailable", async () => {
    paired.value = "throws";
    renderHome();
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByRole("heading", { name: "App Lanche" })).toBeTruthy();
  });
});

describe("admin area", () => {
  afterEach(cleanup);

  it("loads the admin area on demand at the same addresses", async () => {
    render(
      <MemoryRouter initialEntries={["/admin/login"]}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByLabelText("E-mail")).toBeTruthy();
  });
});

describe("theme scope", () => {
  afterEach(cleanup);

  it("marks the document as themed only while the admin area is mounted", async () => {
    paired.value = false;
    let navigate: NavigateFunction = () => {};
    function Grab() {
      navigate = useNavigate();
      return null;
    }
    render(
      <MemoryRouter initialEntries={["/admin/login"]}>
        <App />
        <Grab />
      </MemoryRouter>,
    );
    expect(await screen.findByLabelText("E-mail")).toBeTruthy();
    expect(document.documentElement.classList.contains("app-themed")).toBe(true);
    await act(async () => navigate("/"));
    const home = await screen.findByRole("heading", { name: "App Lanche" });
    expect(home.closest(".app-themed")).toBeNull();
    expect(document.documentElement.classList.contains("app-themed")).toBe(false);
  });
});
