// Adaptado de ArchitectUI React Theme Free v4.9.3, src/Layout/AppMain/PageTitle (MIT, © 2023 DashboardPack), sem as
// ações de demonstração; ver apps/web/src/theme/LICENSE-ArchitectUI.txt.
import type { ReactNode } from "react";

export function PageTitle({
  heading,
  subheading,
  icon,
  actions,
}: {
  heading: ReactNode;
  subheading?: ReactNode;
  icon?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="app-page-title">
      <div className="page-title-wrapper">
        <div className="page-title-heading">
          {icon && (
            <div className="page-title-icon">
              <i className={`${icon} text-primary`} aria-hidden="true" />
            </div>
          )}
          <div>
            <h1 className="h5 mb-0">{heading}</h1>
            {subheading && <div className="page-title-subheading">{subheading}</div>}
          </div>
        </div>
        {actions && <div className="page-title-actions">{actions}</div>}
      </div>
    </div>
  );
}
