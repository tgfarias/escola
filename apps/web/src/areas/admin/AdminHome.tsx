import { Navigate, useLocation } from "react-router";
import { PageTitle } from "../../theme/layout/PageTitle";
import { useAdminMe } from "./AdminLayout";
import { Dashboard } from "./Dashboard";

const LEGACY_ANCHORS: Record<string, string> = {
  "#cardapio": "/admin/lanche/cardapio",
  "#dias": "/admin/lanche/dias",
  "#tablets": "/admin/lanche/tablets",
};

export function AdminHome() {
  const { hash } = useLocation();
  const { me, meFailed } = useAdminMe();

  if (LEGACY_ANCHORS[hash]) return <Navigate to={LEGACY_ANCHORS[hash]} replace />;

  // O AdminLayout busca /me e mostra o erro dessa busca; aqui só falta esperar.
  if (!me) return meFailed ? null : <p>Carregando…</p>;

  return (
    <>
      <PageTitle heading={me.schoolName} subheading="Início" icon="pe-7s-home" />
      <Dashboard role={me.role} />
    </>
  );
}
