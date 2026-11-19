import type { ManifestContent } from "@app-lanche/contracts";

export type ClassGroup = ManifestContent["by_class"][number];
export type StateFilter = "all" | "pending" | "delivered";
export type BoardFilter = { className: string | null; state: StateFilter };

/** Turmas e pedidos que o filtro do quadro deixa à vista; turma sem pedido visível some. Só tela, nenhuma regra. */
export function visibleGroups(groups: ClassGroup[], delivered: ReadonlySet<string>, filter: BoardFilter): ClassGroup[] {
  return groups
    .filter((g) => filter.className === null || g.class === filter.className)
    .map((g) => ({
      ...g,
      orders: g.orders.filter((o) => filter.state === "all" || (filter.state === "delivered") === delivered.has(o.order_id)),
    }))
    .filter((g) => g.orders.length > 0);
}
