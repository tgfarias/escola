import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

const COLLAPSED_KEY = "app-lanche:sidebar-collapsed";

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(value: boolean): void {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, value ? "1" : "0");
  } catch {
    // Sem armazenamento (aba privada, bloqueio do navegador): o menu só não lembra a escolha.
  }
}

export type LayoutState = {
  collapsed: boolean;
  mobileOpen: boolean;
  toggleCollapsed: () => void;
  toggleMobile: () => void;
  closeMobile: () => void;
};

const LayoutContext = createContext<LayoutState | null>(null);

/** Estado do layout, no lugar do Redux ThemeOptions do ArchitectUI: menu recolhido (lembrado) e gaveta do celular. */
export function LayoutProvider({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);

  const toggleCollapsed = useCallback(() => {
    const next = !collapsed;
    writeCollapsed(next);
    setCollapsed(next);
  }, [collapsed]);
  const toggleMobile = useCallback(() => setMobileOpen((open) => !open), []);
  const closeMobile = useCallback(() => setMobileOpen(false), []);

  const value = useMemo(
    () => ({ collapsed, mobileOpen, toggleCollapsed, toggleMobile, closeMobile }),
    [collapsed, mobileOpen, toggleCollapsed, toggleMobile, closeMobile],
  );
  return <LayoutContext.Provider value={value}>{children}</LayoutContext.Provider>;
}

export function useLayout(): LayoutState {
  const ctx = useContext(LayoutContext);
  if (!ctx) throw new Error("useLayout must be used inside LayoutProvider");
  return ctx;
}
