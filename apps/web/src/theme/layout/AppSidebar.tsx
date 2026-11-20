// Adaptado de ArchitectUI React Theme Free v4.9.3, src/Layout/AppSidebar e src/Layout/AppNav (MIT, © 2023 DashboardPack);
// ver apps/web/src/theme/LICENSE-ArchitectUI.txt.
import { Link, useLocation } from "react-router";
import { useLayout } from "./LayoutContext";

export type NavItem = {
  to: string;
  label: string;
  /** Classe do ícone pe7, por exemplo "pe-7s-home". */
  icon: string;
  isActive: (location: { pathname: string; hash: string }) => boolean;
};

/** Título de grupo do menu (sem link). */
export type NavHeading = { heading: string };
export type NavEntry = NavItem | NavHeading;

export function AppSidebar({ items }: { items: NavEntry[] }) {
  const location = useLocation();
  const { closeMobile } = useLayout();
  return (
    <>
      <div className="sidebar-mobile-overlay" aria-hidden="true" onClick={closeMobile} />
      <nav className="app-sidebar sidebar-shadow" id="app-sidebar" aria-label="Menu principal">
        <div className="app-sidebar__inner">
          <div className="vertical-nav-menu">
            <ul className="metismenu-container">
              {items.map((entry) => {
                if ("heading" in entry) {
                  return (
                    <li key={`heading-${entry.heading}`} className="app-sidebar__heading">
                      {entry.heading}
                    </li>
                  );
                }
                const active = entry.isActive(location);
                return (
                  <li key={entry.to} className="metismenu-item">
                    <Link
                      to={entry.to}
                      className={active ? "metismenu-link active" : "metismenu-link"}
                      aria-current={active ? "page" : undefined}
                    >
                      <i className={`metismenu-icon ${entry.icon}`} aria-hidden="true" />
                      {entry.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </nav>
    </>
  );
}
