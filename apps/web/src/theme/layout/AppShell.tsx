// Adaptado de ArchitectUI React Theme Free v4.9.3, src/Layout/AppMain e src/DemoPages/Main (MIT, © 2023 DashboardPack);
// ver apps/web/src/theme/LICENSE-ArchitectUI.txt.
import { useEffect, useRef, type ReactNode } from "react";
import { useLocation } from "react-router";
import { ToastContainer } from "react-toastify";
import { AppHeader, type HeaderUser } from "./AppHeader";
import { AppSidebar, type NavItem } from "./AppSidebar";
import { LayoutProvider, useLayout } from "./LayoutContext";

type Props = { nav: NavItem[]; schoolName?: string; user?: HeaderUser; onLogout: () => void; children: ReactNode };

function Shell({ nav, schoolName, user, onLogout, children }: Props) {
  const { collapsed, mobileOpen, closeMobile } = useLayout();
  const location = useLocation();
  const containerRef = useRef<HTMLDivElement>(null);

  // Navegar fecha a gaveta do celular, também ao tocar o link da página atual (location.key muda mesmo assim).
  useEffect(() => {
    closeMobile();
  }, [location.pathname, location.hash, location.key, closeMobile]);

  // Gaveta aberta: o foco vai para o primeiro link do menu; Escape fecha e devolve o foco ao botão do menu.
  useEffect(() => {
    if (!mobileOpen) return;
    containerRef.current?.querySelector<HTMLElement>("#app-sidebar a")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      closeMobile();
      containerRef.current?.querySelector<HTMLElement>('.app-header__mobile-menu [aria-controls="app-sidebar"]')?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileOpen, closeMobile]);

  const classes = ["app-container", "app-theme-white", "fixed-header", "fixed-sidebar"];
  if (collapsed) classes.push("closed-sidebar");
  if (mobileOpen) classes.push("sidebar-mobile-open");

  return (
    <div className={classes.join(" ")} ref={containerRef}>
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
