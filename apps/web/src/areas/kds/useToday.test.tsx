import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useToday } from "./useToday";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2031, 10, 5, 23, 59, 30));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useToday", () => {
  it("rolls to the new local day within a minute", () => {
    const { result } = renderHook(() => useToday());
    expect(result.current).toBe("2031-11-05");
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current).toBe("2031-11-06");
  });

  it("recomputes the day when the tablet becomes visible again", () => {
    const { result } = renderHook(() => useToday());
    vi.setSystemTime(new Date(2031, 10, 6, 7, 0, 0)); // timers parados com a tela apagada
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(result.current).toBe("2031-11-06");
  });
});
