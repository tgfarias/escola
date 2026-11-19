import { useState } from "react";
import { Alert } from "reactstrap";
import { OVER_LIMIT_TEXT, type RosterItem } from "../../ui/counter";
import { formatCents } from "../../ui/money";
import { CounterView } from "./CounterView";
import { CounterSaleRefused, kdsDb, recordCounterSale, ROSTER_ITEMS, ROSTER_LIMIT, voidCounterSale } from "./db";
import { useLive } from "./useLive";
import { useToday } from "./useToday";

/** Aba "Lançar": lê e escreve só no IndexedDB (regra 32); o módulo `sync` envia a outbox. */
export function CounterPanel({ serviceDate }: { serviceDate: string }) {
  const roster = useLive(() => kdsDb.roster.toArray(), []);
  const limit = useLive(async () => Number((await kdsDb.meta.get(ROSTER_LIMIT))?.value ?? "0"), []);
  const items = useLive(async () => JSON.parse((await kdsDb.meta.get(ROSTER_ITEMS))?.value ?? "[]") as RosterItem[], []);
  const sales = useLive(async () => (await kdsDb.counterSales.where("serviceDate").equals(serviceDate).sortBy("occurredAt")).reverse(), [serviceDate]);
  const today = useToday();
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (roster === undefined || limit === undefined || items === undefined || sales === undefined) return <p>Carregando…</p>;
  if (roster.length === 0) {
    return (
      <div className="alert alert-secondary" data-testid="kds-counter-empty">
        Carregando a lista de alunos… Conecte o tablet à internet na primeira vez.
      </div>
    );
  }

  return (
    <>
      {notice && (
        <Alert color="success" fade={false} role="status">
          {notice}
        </Alert>
      )}
      {error && (
        <Alert color="danger" fade={false}>
          {error}
        </Alert>
      )}
      <CounterView
        roster={roster}
        items={items}
        limitCents={limit}
        sales={sales}
        today={today}
        onSell={async (studentId, lines) => {
          try {
            await recordCounterSale({ serviceDate, studentId, lines });
            const name = roster.find((r) => r.studentId === studentId)?.firstName ?? "";
            setNotice(`Lançado para ${name}: ${formatCents(lines.reduce((s, l) => s + l.qty * l.unitPriceCents, 0))}.`);
            setError(null);
          } catch (err) {
            setNotice(null);
            setError(err instanceof CounterSaleRefused && err.reason === "over_limit" ? OVER_LIMIT_TEXT : "Não foi possível lançar neste tablet. Tente de novo.");
          }
        }}
        onUndo={async (saleId) => {
          try {
            await voidCounterSale(saleId);
            setNotice("Lançamento desfeito.");
            setError(null);
          } catch {
            setError("Não foi possível desfazer neste tablet. Tente de novo.");
          }
        }}
      />
    </>
  );
}
