import { describe, expect, it } from "vitest";
import { badgeText } from "./badge";

describe("sync badge", () => {
  const last = new Date(2031, 10, 5, 10, 7).toISOString();
  it("shows pending count and last sync time", () => {
    expect(badgeText(3, last, new Date(2031, 10, 5, 10, 8))).toEqual({ text: "3 pendentes · última sincronização 10:07", stale: false });
    expect(badgeText(1, last, new Date(2031, 10, 5, 10, 8)).text).toBe("1 pendente · última sincronização 10:07");
  });
  it("turns stale after 2 minutes without sync", () => {
    expect(badgeText(0, last, new Date(2031, 10, 5, 10, 9, 1)).stale).toBe(true);
  });
  it("is stale when never synced", () => {
    expect(badgeText(0, null, new Date())).toEqual({ text: "0 pendentes · nunca sincronizado", stale: true });
  });
});
