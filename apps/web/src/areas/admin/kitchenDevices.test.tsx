import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KitchenDevicesAdmin } from "./KitchenDevicesAdmin";

type Reply = { status: number; body: unknown };
function mockApi(replies: Record<string, Reply>) {
  const fn = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url, init) => {
    const reply = replies[`${init?.method ?? "GET"} ${url}`];
    if (!reply) throw new Error(`unexpected request ${init?.method ?? "GET"} ${url}`);
    return new Response(reply.status === 204 ? null : JSON.stringify(reply.body), { status: reply.status });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const DEV = "0193a3b0-0000-7000-8000-0000000000d1";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("KitchenDevicesAdmin", () => {
  it("generates a pairing code and shows it with its validity", async () => {
    const fn = mockApi({
      "GET /api/admin/v1/kds/devices": { status: 200, body: { devices: [] } },
      "POST /api/admin/v1/kds/pairing-codes": { status: 200, body: { deviceId: DEV, code: "ABCD2345", expiresAt: "2031-11-05T13:10:00.000Z" } },
    });
    render(<KitchenDevicesAdmin />);
    fireEvent.click(await screen.findByRole("button", { name: "Gerar código de pareamento" }));
    expect(await screen.findByText("ABCD2345")).toBeTruthy();
    expect(screen.getByText(/Digite este código no tablet da cozinha/)).toBeTruthy();
    const post = fn.mock.calls.find((c) => c[1]?.method === "POST")!;
    expect((post[1]!.headers as Record<string, string>)["idempotency-key"]).toBeTruthy();
  });

  it("lists devices and revokes one after confirmation", async () => {
    vi.stubGlobal("confirm", () => true);
    const fn = mockApi({
      "GET /api/admin/v1/kds/devices": { status: 200, body: { devices: [{ id: DEV, createdAt: "2031-11-01T10:00:00.000Z", paired: true, revokedAt: null }] } },
      [`POST /api/admin/v1/kds/devices/${DEV}/revoke`]: { status: 204, body: null },
    });
    render(<KitchenDevicesAdmin />);
    fireEvent.click(await screen.findByRole("button", { name: "Revogar" }));
    await waitFor(() => expect(fn.mock.calls.some((c) => c[0] === `/api/admin/v1/kds/devices/${DEV}/revoke`)).toBe(true));
  });
});
