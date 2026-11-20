import type { DashboardQuery, DashboardResponse } from "@app-lanche/contracts";
import { withTenant } from "../../db/index";
import type { SessionClaims } from "../../platform/session";
import * as repo from "./repo";

/** Indicadores da página inicial (spec F5C, A.3). A cozinha recebe só o bloco de lanches. */
export async function getDashboard(session: SessionClaims, query: DashboardQuery): Promise<DashboardResponse> {
  const office = session.kind === "staff" && (session.role === "admin" || session.role === "secretaria");
  return withTenant(session.schoolId, async (trx) => {
    const p = await repo.resolvePeriod(trx, query.period);
    const counts = await repo.snackCounts(trx, p);
    return {
      period: query.period,
      from: p.from,
      to: p.to,
      snacks: { ...counts, topItems: await repo.topItems(trx, p) },
      documents: office ? await repo.documentCounts(trx, p) : null,
      money: office ? await repo.moneyTotals(trx, p) : null,
    };
  });
}
