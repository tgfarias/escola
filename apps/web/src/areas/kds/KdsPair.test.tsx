import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../app/api";
import { LOGO_ALT } from "../../theme/brand";
import { KdsPair } from "./KdsPair";
import * as sync from "./sync";

vi.mock("./sync", () => ({ pair: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.mocked(sync.pair).mockReset();
});

const typeCode = (value: string) => fireEvent.change(screen.getByLabelText("Código de pareamento"), { target: { value } });

describe("KdsPair", () => {
  it("shows the school logo and allows pairing only with 8 characters", () => {
    render(<KdsPair onPaired={vi.fn()} />);
    expect(screen.getByRole("img", { name: LOGO_ALT })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Parear tablet da cozinha" })).toBeTruthy();
    typeCode("abcd234");
    expect((screen.getByRole("button", { name: "Parear" }) as HTMLButtonElement).disabled).toBe(true);
    typeCode("abcd2345");
    expect((screen.getByRole("button", { name: "Parear" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("pairs with the typed code", async () => {
    vi.mocked(sync.pair).mockResolvedValue("0193a3b0-0000-7000-8000-0000000000d1");
    const onPaired = vi.fn();
    render(<KdsPair onPaired={onPaired} />);
    typeCode("abcd2345");
    fireEvent.click(screen.getByRole("button", { name: "Parear" }));
    await waitFor(() => expect(onPaired).toHaveBeenCalledTimes(1));
    expect(sync.pair).toHaveBeenCalledWith("abcd2345");
  });

  it("asks for a new code when the code is wrong or expired", async () => {
    vi.mocked(sync.pair).mockRejectedValue(new ApiError(400, "invalid_pairing_code"));
    render(<KdsPair onPaired={vi.fn()} />);
    typeCode("abcd2345");
    fireEvent.click(screen.getByRole("button", { name: "Parear" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Código inválido ou vencido. Peça um novo código à secretaria.");
  });

  it("explains that pairing needs internet", async () => {
    vi.mocked(sync.pair).mockRejectedValue(new ApiError(0, "network_error"));
    render(<KdsPair onPaired={vi.fn()} />);
    typeCode("abcd2345");
    fireEvent.click(screen.getByRole("button", { name: "Parear" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Sem conexão. O pareamento precisa de internet.");
  });

  it("tells a disconnected tablet to ask for a new code", () => {
    render(<KdsPair onPaired={vi.fn()} disconnected />);
    expect(screen.getByRole("alert").textContent).toBe(
      "Este tablet foi desconectado. Peça um novo código à secretaria; as entregas ainda não enviadas serão mantidas.",
    );
  });
});
