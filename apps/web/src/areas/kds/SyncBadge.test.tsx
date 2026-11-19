import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SyncBadge } from "./SyncBadge";

const last = new Date(2031, 10, 5, 10, 7).toISOString();

afterEach(cleanup);

describe("SyncBadge", () => {
  it("is green when everything is synced", () => {
    render(<SyncBadge pending={0} lastSyncAt={last} now={new Date(2031, 10, 5, 10, 8)} />);
    const badge = screen.getByTestId("kds-badge");
    expect(badge.textContent).toBe("0 pendentes · última sincronização 10:07");
    expect(badge.className).toContain("text-bg-success");
  });

  it("is orange while deliveries wait to be sent", () => {
    render(<SyncBadge pending={3} lastSyncAt={last} now={new Date(2031, 10, 5, 10, 8)} />);
    const badge = screen.getByTestId("kds-badge");
    expect(badge.textContent).toBe("3 pendentes · última sincronização 10:07");
    expect(badge.className).toContain("text-bg-warning");
  });

  it("turns red after 2 minutes without sync", () => {
    render(<SyncBadge pending={1} lastSyncAt={last} now={new Date(2031, 10, 5, 10, 9, 1)} />);
    const badge = screen.getByTestId("kds-badge");
    expect(badge.textContent).toBe("1 pendente · última sincronização 10:07 — sem sincronizar");
    expect(badge.className).toContain("text-bg-danger");
  });
});
