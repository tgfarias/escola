import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

// Deploy novo ou rede ruim: o chunk do KDS não carrega.
vi.mock("../areas/kds/KdsApp", () => {
  throw new TypeError("Failed to fetch dynamically imported module");
});
vi.mock("../areas/kds/sync", () => ({ isPaired: async () => false }));

const { App } = await import("./App");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("lazy area that fails to load", () => {
  it("shows the reload message instead of a blank page", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <MemoryRouter initialEntries={["/kds"]}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByText("Não foi possível carregar esta área. Verifique a conexão e recarregue a página.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Recarregar" })).toBeTruthy();
  });
});
