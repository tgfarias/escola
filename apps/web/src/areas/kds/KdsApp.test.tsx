import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./sync", () => ({ isPaired: async () => false, isAuthLost: async () => false }));
vi.mock("./KdsPair", () => ({ KdsPair: () => <p>pareamento</p> }));

const { default: KdsApp } = await import("./KdsApp");

describe("KdsApp", () => {
  afterEach(cleanup);

  it("marks the document as themed while mounted and clears it on unmount", async () => {
    const { unmount } = render(
      <MemoryRouter initialEntries={["/kds"]}>
        <KdsApp />
      </MemoryRouter>,
    );
    expect(await screen.findByText("pareamento")).toBeTruthy();
    expect(document.documentElement.classList.contains("app-themed")).toBe(true);
    unmount();
    expect(document.documentElement.classList.contains("app-themed")).toBe(false);
  });
});
