// Adaptado de ArchitectUI React Theme Free v4.9.3, src/Layout/AppMain e src/DemoPages/Main (MIT, © 2023 DashboardPack);
// ver apps/web/src/theme/LICENSE-ArchitectUI.txt.
import { useEffect, type ReactNode } from "react";
import { useLocation } from "react-router";
import { ToastContainer } from "react-toastify";
import { AppHeader, type HeaderUser } from "./AppHeader";
import { AppSidebar, type NavItem } from "./AppSidebar";
import { LayoutProvider, useLayout } from "./LayoutContext";

type Props = { nav: NavItem[]; schoolName?: string; user?: HeaderUser; onLogout: () => void; children: ReactNode };

function Shell({ nav, schoolName, user, onLogout, children }: Props) {
  const { collapsed, mobileOpen, closeMobile } = useLayout();
  const location = useLocation();

  // Navegar fecha a gaveta do celular.
  useEffect(() => {
    closeMobile();
  }, [location.pathname, location.hash, closeMobile]);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMobile();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileOpen, closeMobile]);

  const classes = ["app-container", "app-theme-white", "fixed-header", "fixed-sidebar"];
  if (collapsed) classes.push("closed-sidebar");
  if (mobileOpen) classes.push("sidebar-mobile-open");

  return (
    <div className={classes.join(" ")}>
      <a
        className="skip-link"
        href="#conteudo"
        onClick={(event) => {
          // Sem mexer no hash: o hash da URL escolhe a seção da página inicial.
          event.preventDefault();
          document.getElementById("conteudo")?.focus();
        }}
      >
        Pular para o conteúdo
      </a>
      <AppHeader schoolName={schoolName} user={user} onLogout={onLogout} />
      <div className="app-main">
        <AppSidebar items={nav} />
        <div className="app-main__outer">
          <main className="app-main__inner" id="conteudo" tabIndex={-1}>
            {children}
          </main>
        </div>
      </div>
      {/* O texto do toast já é anunciado pelo StatusNotice da página: o contêiner fica fora da árvore acessível. */}
      <div aria-hidden="true">
        <ToastContainer position="top-right" autoClose={4000} hideProgressBar closeButton={false} newestOnTop />
      </div>
    </div>
  );
}

/** Moldura do admin: cabeçalho, menu lateral, área principal e toasts. */
export function AppShell(props: Props) {
  return (
    <LayoutProvider>
      <Shell {...props} />
    </LayoutProvider>
  );
}
