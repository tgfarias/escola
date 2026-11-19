// Adaptado de ArchitectUI React Theme Free v4.9.3, src/Layout/AppHeader, src/Layout/AppLogo e src/Layout/AppMobileMenu
// (MIT, © 2023 DashboardPack); ver apps/web/src/theme/LICENSE-ArchitectUI.txt.
import { Button } from "reactstrap";
import { LOGO_URL, PRODUCT_NAME } from "../brand";
import { useLayout } from "./LayoutContext";

export type HeaderUser = { email: string; roleLabel: string };

export function AppHeader({ schoolName, user, onLogout }: { schoolName?: string; user?: HeaderUser; onLogout: () => void }) {
  const { collapsed, mobileOpen, toggleCollapsed, toggleMobile } = useLayout();
  return (
    <header className="app-header header-shadow">
      <div className="app-header__logo">
        <span className="app-logo">
          <span className="app-logo__badge">
            <img src={LOGO_URL} alt="" />
          </span>
          {PRODUCT_NAME}
        </span>
        <div className="header__pane ms-auto">
          <button
            type="button"
            className="app-header__icon-btn"
            aria-label={collapsed ? "Expandir menu" : "Recolher menu"}
            aria-pressed={collapsed}
            onClick={toggleCollapsed}
          >
            <i className="pe-7s-menu" aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="app-header__mobile-menu">
        <button
          type="button"
          className="app-header__icon-btn"
          aria-label={mobileOpen ? "Fechar menu" : "Abrir menu"}
          aria-expanded={mobileOpen}
          aria-controls="app-sidebar"
          onClick={toggleMobile}
        >
          <i className="pe-7s-menu" aria-hidden="true" />
        </button>
      </div>
      <div className="app-header__content">
        <div className="app-header-left">
          {schoolName && <span className="app-header__school text-truncate">{schoolName}</span>}
        </div>
        <div className="app-header-right">
          {user && (
            <div className="app-user-box">
              <div>{user.email}</div>
              <div className="app-user-box__role">{user.roleLabel}</div>
            </div>
          )}
          <Button color="light" size="sm" type="button" onClick={onLogout}>
            Sair
          </Button>
        </div>
      </div>
    </header>
  );
}
