import type { StaffRole } from "@app-lanche/contracts";
import type { NavItem } from "../../theme/layout/AppSidebar";

export const ROLE_LABELS: Record<StaffRole, string> = {
  admin: "Administração",
  secretaria: "Secretaria",
  cozinha: "Cozinha",
};

type Where = { pathname: string; hash: string };
const home = (hash: string) => (l: Where) => l.pathname === "/admin" && l.hash === hash;
const under = (prefix: string) => (l: Where) => l.pathname === prefix || l.pathname.startsWith(`${prefix}/`);

/**
 * Menu lateral do admin. Cardápio, dias de serviço e tablets continuam seções da página inicial (âncoras), como antes
 * do tema. Fora "Início", só para quem administra o cadastro (mesma regra da AdminHome); "Contas" aparece também para a
 * cozinha, que gera o QR de pagamento no balcão.
 */
export function adminNav(role: StaffRole | undefined): NavItem[] {
  const items: NavItem[] = [{ to: "/admin", label: "Início", icon: "pe-7s-home", isActive: home("") }];
  const accounts: NavItem = { to: "/admin/contas", label: "Contas", icon: "pe-7s-cash", isActive: under("/admin/contas") };
  if (role === "cozinha") return [...items, accounts];
  if (role !== "admin" && role !== "secretaria") return items;
  return [
    ...items,
    { to: "/admin/alunos", label: "Alunos e responsáveis", icon: "pe-7s-users", isActive: under("/admin/alunos") },
    accounts,
    { to: "/admin#cardapio", label: "Cardápio", icon: "pe-7s-note2", isActive: home("#cardapio") },
    { to: "/admin#dias", label: "Dias de serviço", icon: "pe-7s-date", isActive: home("#dias") },
    { to: "/admin/documentos", label: "Documentos", icon: "pe-7s-news-paper", isActive: under("/admin/documentos") },
    { to: "/admin#tablets", label: "Tablets da cozinha", icon: "pe-7s-display2", isActive: home("#tablets") },
  ];
}
