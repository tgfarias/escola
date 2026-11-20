import type { ReactNode } from "react";
import { Navigate } from "react-router";
import { PageTitle } from "../../theme/layout/PageTitle";
import { useAdminMe } from "./AdminLayout";
import { KitchenDevicesAdmin } from "./KitchenDevicesAdmin";
import { MenuAdmin } from "./MenuAdmin";
import { ServiceDaysAdmin } from "./ServiceDaysAdmin";

/** Páginas do grupo "Lanche" (spec F5C, A.1): só administração e secretaria; a cozinha volta ao início. */
function OfficeOnly({ children }: { children: ReactNode }) {
  const { me, meFailed } = useAdminMe();
  if (!me) return meFailed ? null : <p>Carregando…</p>;
  if (me.role !== "admin" && me.role !== "secretaria") return <Navigate to="/admin" replace />;
  return <>{children}</>;
}

export function ServiceDaysPage() {
  return (
    <OfficeOnly>
      <PageTitle heading="Dias de serviço" subheading="Abrir dias de pedido, acompanhar e fechar." icon="pe-7s-date" />
      <ServiceDaysAdmin />
    </OfficeOnly>
  );
}

export function MenuPage() {
  return (
    <OfficeOnly>
      <PageTitle heading="Cardápio" subheading="Itens e preços oferecidos nos dias de serviço." icon="pe-7s-note2" />
      <MenuAdmin />
    </OfficeOnly>
  );
}

export function KitchenDevicesPage() {
  return (
    <OfficeOnly>
      <PageTitle heading="Tablets da cozinha" subheading="Código de pareamento e tablets conectados." icon="pe-7s-display2" />
      <KitchenDevicesAdmin />
    </OfficeOnly>
  );
}
