import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { lazy, Suspense } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AreaErrorBoundary } from "./AreaErrorBoundary";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AreaErrorBoundary", () => {
  it("explains a chunk that failed to load and reloads on request", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const Broken = lazy(() => Promise.reject(new TypeError("Failed to fetch dynamically imported module")));
    const reload = vi.fn();
    render(
      <AreaErrorBoundary onReload={reload}>
        <Suspense fallback={null}>
          <Broken />
        </Suspense>
      </AreaErrorBoundary>,
    );
    expect(await screen.findByText("Não foi possível carregar esta área. Verifique a conexão e recarregue a página.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Recarregar" }));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalled();
  });

  it("renders the area when it loads", async () => {
    const Area = lazy(async () => ({ default: () => <p>área carregada</p> }));
    render(
      <AreaErrorBoundary>
        <Suspense fallback={null}>
          <Area />
        </Suspense>
      </AreaErrorBoundary>,
    );
    expect(await screen.findByText("área carregada")).toBeTruthy();
  });
});
