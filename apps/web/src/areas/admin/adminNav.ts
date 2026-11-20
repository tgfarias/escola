import type { StaffRole } from "@app-lanche/contracts";
import type { NavEntry, NavItem } from "../../theme/layout/AppSidebar";

export const ROLE_LABELS: Record<StaffRole, string> = {
  admin: "Administração",
  secretaria: "Secretaria",
  cozinha: "Cozinha",
};

type Where = { pathname: string; hash: string };
const under = (prefix: string) => (l: Where) => l.pathname === prefix || l.pathname.startsWith(`${prefix}/`);

/**
 * Menu lateral do admin, em grupos (spec F5C, A.1). "Lanche" junta o dia a dia da cozinha; "Escola", o cadastro e os
 * documentos. A cozinha vê só "Início" e "Contas" (QR de pagamento no balcão).
 */
export function adminNav(role: StaffRole | undefined): NavEntry[] {
  const home: NavItem = { to: "/admin", label: "Início", icon: "pe-7s-home", isActive: (l) => l.pathname === "/admin" };
  const accounts: NavItem = { to: "/admin/contas", label: "Contas", icon: "pe-7s-cash", isActive: under("/admin/contas") };
  if (role === "cozinha") return [home, { heading: "Lanche" }, accounts];
  if (role !== "admin" && role !== "secretaria") return [home];
  return [
    home,
    { heading: "Escola" },
    { to: "/admin/alunos", label: "Alunos e responsáveis", icon: "pe-7s-users", isActive: under("/admin/alunos") },
    { to: "/admin/documentos", label: "Documentos", icon: "pe-7s-news-paper", isActive: under("/admin/documentos") },
    { heading: "Lanche" },
    { to: "/admin/lanche/dias", label: "Dias de serviço", icon: "pe-7s-date", isActive: under("/admin/lanche/dias") },
    { to: "/admin/lanche/cardapio", label: "Cardápio", icon: "pe-7s-note2", isActive: under("/admin/lanche/cardapio") },
    { to: "/admin/lanche/tablets", label: "Tablets da cozinha", icon: "pe-7s-display2", isActive: under("/admin/lanche/tablets") },
    accounts,
  ];
}
