import type { ReactNode } from "react";

/** Moldura do tablet da cozinha: barra fina com título, selo e ações; sem menu (spec: tela cheia). */
export function KdsShell({ title, status, actions, children }: { title: ReactNode; status?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="kds-shell">
      <header className="kds-topbar">
        <h1>{title}</h1>
        <div className="kds-topbar__actions">
          {status}
          {actions}
        </div>
      </header>
      <main className="kds-content">{children}</main>
    </div>
  );
}
