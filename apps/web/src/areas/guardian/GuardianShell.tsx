import type { ReactNode } from "react";
import { LOGO_ALT, LOGO_URL, PRODUCT_NAME } from "../../theme/brand";

/** Moldura das telas dos responsáveis: barra com o logo e o conteúdo numa coluna estreita (celular primeiro). */
export function GuardianShell({ children }: { children: ReactNode }) {
  return (
    <>
      <header className="g-header">
        <div className="g-header__inner">
          <img className="g-header__logo" src={LOGO_URL} alt={LOGO_ALT} />
          <span className="g-header__name">{PRODUCT_NAME}</span>
        </div>
      </header>
      <main className="g-main">{children}</main>
    </>
  );
}

/** Carregando ou erro antes de a tela ter dados. */
export function GuardianPending({ error }: { error: string | null }) {
  return (
    <GuardianShell>
      {error ? (
        <p role="alert" className="g-alert">
          {error}
        </p>
      ) : (
        <p className="g-muted">Carregando…</p>
      )}
    </GuardianShell>
  );
}
