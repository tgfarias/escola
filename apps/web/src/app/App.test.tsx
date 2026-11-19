import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
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
