import { useEffect, useState, type ReactNode } from "react";
import { Alert, Button, Nav, NavItem, NavLink } from "reactstrap";
import { KdsShell } from "../../theme/layout/KdsShell";
import { CounterPanel } from "./CounterPanel";
import { kdsDb, markOrder } from "./db";
import { validClassFilter, visibleGroups, type StateFilter } from "./filters";
import { SyncBadge } from "./SyncBadge";
import * as sync from "./sync";
import { useLive } from "./useLive";

const STATE_FILTERS: { value: StateFilter; label: string }[] = [
  { value: "all", label: "Todos" },
  { value: "pending", label: "Pendentes" },
  { value: "delivered", label: "Entregues" },
];

function FilterPill({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <NavItem>
      <NavLink tag="button" type="button" active={active} aria-pressed={active} onClick={onClick}>
        {children}
      </NavLink>
    </NavItem>
  );
}

export function KdsBoard({ serviceDate, onUnpaired }: { serviceDate: string; onUnpaired: () => void }) {
  const manifest = useLive(() => kdsDb.manifest.get(serviceDate), [serviceDate]);
  const states = useLive(() => kdsDb.orderState.where("serviceDate").equals(serviceDate).toArray(), [serviceDate]);
  const pending = useLive(() => kdsDb.outbox.count(), []);
  const lastSyncAt = useLive(async () => (await kdsDb.meta.get("lastSyncAt"))?.value ?? null, []);
  const noService = useLive(async () => (await kdsDb.meta.get(`noService:${serviceDate}`)) !== undefined, [serviceDate]);
  const [now, setNow] = useState(() => new Date());
  const [message, setMessage] = useState<string | null>(null);
  const [tapFailed, setTapFailed] = useState(false);
  const [classFilter, setClassFilter] = useState<string | null>(null);
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [view, setView] = useState<"board" | "counter">("board");

  useEffect(() => sync.start(serviceDate), [serviceDate]);
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 10_000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => {
    // Spec 7.4: tela acesa enquanto o KDS está aberto. O navegador solta o lock ao ocultar a página.
    type Lock = { release: () => Promise<void>; addEventListener: (t: "release", fn: () => void) => void };
    const nav = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<Lock> } };
    let lock: Lock | null = null;
    let cancelled = false;
    let requesting = false;
    function acquire() {
      if (!nav.wakeLock || lock || requesting || cancelled) return;
      requesting = true;
      nav.wakeLock.request("screen").then(
        (l) => {
          requesting = false;
          if (cancelled) {
            void l.release().catch(() => undefined);
            return;
          }
          lock = l;
          l.addEventListener("release", () => {
            if (lock === l) lock = null;
          });
        },
        () => {
          requesting = false;
        },
      );
    }
    function onVisible() {
      if (document.visibilityState === "visible") acquire();
    }
    document.addEventListener("visibilitychange", onVisible);
    acquire();
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      void lock?.release().catch(() => undefined);
      lock = null;
    };
  }, []);
  useEffect(() => {
    if ((pending ?? 0) === 0) setMessage(null);
  }, [pending]);

  const delivered = new Set((states ?? []).filter((s) => s.state === "delivered").map((s) => s.orderId));
  const closed = manifest?.status === "closed";
  const classes = manifest?.content.by_class.map((c) => c.class) ?? [];
  // Romaneio novo sem a turma filtrada: volta para "Todas as turmas" em vez de mostrar um quadro vazio.
  const classList = classes.join("\n");
  useEffect(() => {
    if (manifest) setClassFilter((current) => validClassFilter(current, classList.split("\n")));
  }, [manifest, classList]);
  const groups = manifest ? visibleGroups(manifest.content.by_class, delivered, { className: classFilter, state: stateFilter }) : [];

  async function tap(orderId: string, delivered: boolean) {
    try {
      await markOrder(orderId, serviceDate, delivered);
      setTapFailed(false);
    } catch (err) {
      console.warn("kds mark failed", err instanceof Error ? err.name : "unknown");
      setTapFailed(true);
    }
  }

  async function unpair() {
    if (!(await sync.unpair())) {
      setMessage("Há entregas ou vendas do balcão ainda não sincronizadas. Conecte o tablet à internet e aguarde antes de desparear.");
      return;
    }
    onUnpaired();
  }

  return (
    <KdsShell
      title={`Cozinha — ${serviceDate.split("-").reverse().join("/")}`}
      status={<SyncBadge pending={pending ?? 0} lastSyncAt={lastSyncAt ?? null} now={now} />}
      actions={
        <Button data-testid="kds-unpair" color="light" type="button" onClick={() => void unpair()}>
          Desparear este tablet
        </Button>
      }
    >
      {message && (
        <Alert color="danger" fade={false}>
          {message}
        </Alert>
      )}
      {tapFailed && (
        <Alert color="danger" fade={false}>
          Não foi possível registrar a entrega neste tablet. Tente de novo.
        </Alert>
      )}
      <Nav tabs className="mb-3">
        <NavItem>
          <NavLink tag="button" type="button" data-testid="kds-tab-board" active={view === "board"} aria-pressed={view === "board"} onClick={() => setView("board")}>
            Entregas
          </NavLink>
        </NavItem>
        <NavItem>
          <NavLink tag="button" type="button" data-testid="kds-tab-counter" active={view === "counter"} aria-pressed={view === "counter"} onClick={() => setView("counter")}>
            Lançar
          </NavLink>
        </NavItem>
      </Nav>
      {view === "counter" && <CounterPanel serviceDate={serviceDate} />}
      {view === "board" && (
        <>
        {!manifest && noService && (
          <div className="alert alert-secondary" data-testid="kds-no-service">
            Não há serviço de lanche nesta data.
          </div>
        )}
        {!manifest && !noService && <div className="alert alert-secondary">Carregando o romaneio… Conecte o tablet à internet na primeira vez.</div>}
        {manifest && !closed && (
          <div className="alert alert-warning" data-testid="kds-waiting">
            Prévia parcial — aguardando fechamento. As entregas podem ser marcadas depois do fechamento.
          </div>
        )}
        {manifest && (
          <>
            <p className="fs-5 fw-semibold mb-3">
              {manifest.content.totals.orders} pedidos ·{" "}
              {manifest.content.totals.by_item.map((i) => `${i.qty}x ${i.item}`).join(" · ")}
            </p>
            <div className="kds-filters">
              <div role="group" aria-label="Filtrar por turma">
                <Nav pills>
                  <FilterPill active={classFilter === null} onClick={() => setClassFilter(null)}>
                    Todas as turmas
                  </FilterPill>
                  {classes.map((c) => (
                    <FilterPill key={c} active={classFilter === c} onClick={() => setClassFilter(c)}>
                      {c}
                    </FilterPill>
                  ))}
                </Nav>
              </div>
              <div role="group" aria-label="Filtrar por entrega">
                <Nav pills>
                  {STATE_FILTERS.map((f) => (
                    <FilterPill key={f.value} active={stateFilter === f.value} onClick={() => setStateFilter(f.value)}>
                      {f.label}
                    </FilterPill>
                  ))}
                </Nav>
              </div>
            </div>
            {groups.length === 0 && <p>Nenhum pedido neste filtro.</p>}
            {groups.map((c) => (
              <section key={c.class}>
                <h2 className="kds-class-title">{c.class}</h2>
                <ul className="kds-grid">
                  {c.orders.map((o) => {
                    const isDelivered = delivered.has(o.order_id);
                    return (
                      <li key={o.order_id}>
                        <button
                          type="button"
                          className={isDelivered ? "kds-card is-delivered" : "kds-card"}
                          data-testid={`kds-order-${o.order_id}`}
                          aria-pressed={isDelivered}
                          disabled={!closed}
                          onClick={() => void tap(o.order_id, !isDelivered)}
                        >
                          <span className="kds-card__name">{o.student}</span>
                          <span className="kds-card__class">{c.class}</span>
                          <span>{o.items.join(", ")}</span>
                          {o.restrictions && <span className="badge text-bg-warning">Restrição: {o.restrictions}</span>}
                          <span className="kds-card__state">{isDelivered ? "✓ Entregue" : "Pendente"}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </>
        )}
        </>
      )}
    </KdsShell>
  );
}
