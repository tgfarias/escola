# F5C Parte B — Turnos e "Finalizar turno" — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Escolas com turma da manhã (matutino) e da tarde (vespertino): corte, pagamento, fechamento e romaneio por turno; o tablet mostra um turno por vez e "Finaliza" o turno offline; pedidos pagos e não retirados viram `not_collected` e a secretaria decide, pedido a pedido, se devolve como crédito.

**Architecture:** A migração `0012_shifts.sql` cria `service_day_shifts` (um por turno ativo no dia), põe `shift` em `classes`, `checkouts` e `manifests`, cria `shift_events` (evento `shift_finished` do tablet, `event_id` como chave) e `uncollected_decisions` (decisão da secretaria), e acrescenta `not_collected` / `uncollected_credit`. O `service_days` continua sendo a unidade do cardápio e do link (`cutoff_at`/`freeze_at` espelham o turno mais tarde); toda regra de corte passa a ler o turno (`catalog.lockShift`). O checkout pertence a um turno, derivado no servidor das turmas dos alunos. Fechar trava `service_days FOR UPDATE → service_day_shifts FOR UPDATE`; confirmar/pedir/entregar travam ambos `FOR SHARE`. Finalizar (`serviceDays.finishShiftInTrx`) faz `closed → finished` e `confirmed → not_collected`; o tablet manda `shift_finished` pela mesma `POST /api/kds/v1/events`. Um módulo novo `uncollected` lista e decide os não retirados. A agenda (`list_due_actions()`, recriada em `0013_shift_schedule.sql`) ganha `finish_shifts` para o job `POST /jobs/v1/shifts/safety-finish`.

**Tech Stack:** Fastify 5, Kysely, PostgreSQL 16 (RLS, FKs compostas, índices parciais), zod 4, React 19, react-router 8, reactstrap (admin/KDS), Dexie 4 (versão 3), Vitest + Testcontainers, Vitest + jsdom + Testing Library, Playwright. Nenhuma dependência nova.

**Spec:** `docs/superpowers/specs/2026-11-20-admin-turnos-avisos-design.md` (Parte B, autoritativa), com `docs/superpowers/specs/2026-11-16-app-lanche-design.md` (4.4, 5.1–5.7, 6.2–6.3, 7) e `docs/superpowers/specs/2026-11-19-balcao-carteira-design.md` (ordem de travas, ordem de envio do tablet). Regras do projeto: `CLAUDE.md`.

## Global Constraints

- CLAUDE.md inteiro vale. Todo acesso ao banco dentro de `withTenant(schoolId, …)`; `school_id` só da sessão, do caminho HMAC (rotas internas) ou da agenda `list_due_actions()` (jobs).
- **Nenhuma função `SECURITY DEFINER` nova.** `list_due_actions()` é recriada com `CREATE OR REPLACE` e a mesma assinatura (`action, school_id, service_date, overdue`). `getDb` não entra em arquivo novo (a allowlist do ESLint não muda).
- Toda tabela nova (`service_day_shifts`, `shift_events`, `uncollected_decisions`): `school_id uuid NOT NULL`, RLS `tenant_isolation` (`school_id = app_school_id()`), `UNIQUE (school_id, id)` (ou `(school_id, event_id)`), FKs compostas `(school_id, …)`, entra em `TENANT_TABLES` de `apps/api/src/db/rls.test.ts` (ordem de bytes) e em `seedTenant`.
- Turnos: `Shift = "matutino" | "vespertino"`, rótulos de tela **"Manhã"** e **"Tarde"**; estado do turno `ShiftStatus = "open" | "closed" | "finished"`, rótulos **"Aberto"**, **"Fechado (romaneio pronto)"**, **"Finalizado"**.
- Ordem única de travas numa transação: `service_days → service_day_shifts → checkouts → topups → payments → guardian_students → counter_sales → wallets`. Fechar turno: dia `FOR UPDATE`, turno `FOR UPDATE`. Finalizar: dia `FOR SHARE`, turno `FOR UPDATE`. Pedido, cancelamento, `confirmPayment`, entrega do tablet e decisão de não retirado: dia `FOR SHARE`, turno `FOR SHARE` (entrega e decisão travam depois os `orders` `FOR UPDATE`).
- Regras 15–17 por turno: `now()` do banco decide o corte; pagamento com `paid_at > cutoff_at` do turno, ou com o turno já fechado, vira `late_payment_credit` e pedido `expired_late`; o romaneio de um turno é imutável depois de gravado (regra 18).
- Transições com `UPDATE … WHERE status = '<anterior>'` (zero linhas = já feito, sem efeito colateral). Dedup por constraint: `shift_events.event_id` (PK), `UNIQUE (school_id, order_id)` em `uncollected_decisions`, índice único parcial `wallet_entries_one_uncollected_credit`.
- Dinheiro em centavos inteiros (`bigint`/`number` inteiro, sufixo `Cents`/`_cents`). Crédito de não retirado = soma de `qty × unit_price_cents` dos itens do pedido, calculada no servidor; sempre por `wallet.postEntry` (trava `wallets FOR UPDATE`).
- `Idempotency-Key` (helper `idempotent` + `requestHash` + `idempotencyKeyFrom`) em "Devolver como crédito" e "Manter sem devolução". Naturalmente idempotentes, sem chave: fechar e finalizar turno (admin), "Marcar como conferido", `PUT` do turno da turma, eventos do tablet (pelo `event_id`), rotas internas e de job.
- Efeito externo só pela outbox, na transação: `service_day.closed` passa a ter `shift` e sai **um por turno fechado**.
- KDS (regras 32–36): componentes de `areas/kds` só leem/escrevem no IndexedDB; só `sync.ts` chama a API; "Finalizar turno" é uma transação Dexie que grava a outbox e o estado local; nada sai da outbox antes de o servidor devolver o `event_id` em `accepted` ou `rejected`; sem Background Sync API; `event_id` gerado no cliente.
- Mudou contrato: schema em `packages/contracts`, exemplo na spec e fixture do teste de contrato no mesmo commit (regra 23). Corpos de `/api` em `camelCase`; rotas internas, romaneio e eventos em `snake_case`.
- LGPD: nada de nome, telefone ou valor por aluno em log; `audit_log.detail` só com ids, turnos, contagens e booleanos; listas para a secretaria e o tablet só com o primeiro nome do aluno.
- Telas do admin seguem a spec de UI (como a Parte A): `PageTitle`, `Card`, `Table responsive hover striped`, `Alert color="danger"`, `StatusBadge`, `announce` + `StatusNotice`. A área do responsável continua sem reactstrap/tema (o ESLint barra).
- Migrações aplicadas nunca são editadas: esta parte cria `0012_shifts.sql` (Task 1) e `0013_shift_schedule.sql` (Task 6).
- O `CamelCasePlugin` converte nomes de coluna também em `sql\`…\``; `bigint` volta como `number` (parser de `apps/api/src/db/index.ts`); some `sum(...)::bigint`.
- Texto de interface em português do Brasil exatamente como o plano dá; código, nomes e commits em inglês. Mensagens de commit terminam com:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01K86CbkJPwmS7fPKomVgzip
  ```
- O arquivo não rastreado `prompt.txt` na raiz é do usuário: nunca o commite (sempre `git add` com caminhos explícitos). Nada de `.superpowers/`, `test-results/` nem de build.
- Comandos focados: API `pnpm --filter @app-lanche/api exec vitest run <caminho relativo a apps/api>`; contratos `pnpm --filter @app-lanche/contracts test`; web `pnpm --filter @app-lanche/web exec vitest run <caminho relativo a apps/web>`.
- Regenerar os tipos Kysely depois de cada migração (da raiz; espere o Postgres aceitar conexões; desligue depois):
  `pnpm db:up; DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/app_lanche APP_DB_PASSWORD=app_user pnpm db:migrate; DATABASE_URL=postgres://postgres:postgres@localhost:5432/app_lanche pnpm db:types; docker compose down`
- Nesta máquina WSL os testes de API (Testcontainers) só passam com o compose desligado: `pnpm app:down; docker compose down` antes de `pnpm test` ou `pnpm test:api`. Playwright: `pnpm db:up && pnpm test:e2e`, depois `docker compose down`.
- Antes de cada commit: `pnpm typecheck && pnpm lint` e os testes dos pacotes tocados.

## Rulings e pontos para o controlador

Decisões tomadas por este plano além da spec e das orientações (o executor não reabre):

1. **Migração dos dados existentes.** Cada `service_days` ganha um turno `matutino` com os mesmos horários. Dia aberto → turno `open`; dia fechado de data **anterior a hoje** (fuso da escola) → turno `finished` com `finished_at = closed_at` e **sem** tocar nos pedidos (senão todo pedido antigo sem entrega marcada no KDS viraria "não retirado"); dia fechado de hoje ou futuro → `closed`. Os ids do backfill usam `gen_random_uuid()` (v4): o Postgres 16 não gera v7 e são linhas de migração.
2. **Corte padrão.** `schools.default_cutoff_time` é removida; o valor vai para `cutoff_time_matutino` (padrão `07:30`). `cutoff_time_vespertino` tem padrão **`13:00`**. Não há tela para alterar os padrões (só o formulário do dia aceita outro horário por turno).
3. **Turnos de um dia.** Ao abrir/salvar o dia, a API cria uma linha por turno que tem ao menos uma turma com aluno ativo; sem nenhuma turma com aluno, cria só o `matutino`. `cutoffTimes` para um turno sem turma → 400 `validation_failed`. Linhas de turno nunca são apagadas (o dia só pode ser salvo de novo sem pedidos).
4. **Checkout de um turno só.** `checkouts.shift` (FK composta para `service_day_shifts`), derivado no servidor da turma dos alunos; `CreateCheckoutRequest` não muda. Alunos de turnos diferentes no mesmo pedido → 422 `invalid_order` (a PWA manda um checkout por turno). Turno sem linha no dia → 409 `shift_not_offered` (erro novo).
5. **Fechamento.** `closeShift` fecha um turno (rota nova `POST /api/admin/v1/service-days/:date/shifts/:shift/close`). `closeServiceDay` fecha vários: o n8n (rota interna) e o fechamento de segurança fecham os turnos já **congelados** (`now() >= freeze_at`); a rota antiga do admin (`POST …/:date/close`) fecha os turnos **depois do corte**. Nenhum turno fechado ao fim → 409 `service_day_open`. O dia fica `closed` quando nenhum turno está `open`.
6. **Contratos de romaneio.** `ManifestResponse` ganha `shift` e `status: "closed" | "finished"`. As rotas de fechamento do dia devolvem `ServiceDayCloseResponse { service_date, status, shifts: ManifestResponse[] }`. `GET …/manifest` (admin e interna) ganha `?shift=` com padrão `matutino` (eventos `service_day.closed` antigos, ainda na outbox no deploy, não têm `shift`).
7. **Resumo da cozinha por turno.** `service_day.closed` ganha `shift` e sai um por turno. O n8n lê o romaneio do turno e manda o mesmo modelo `WA_TEMPLATE_KITCHEN` com o primeiro parâmetro `"DD/MM (manhã)"` ou `"DD/MM (tarde)"`: nenhum modelo novo no WhatsApp.
8. **KDS.** `GET /api/kds/v1/manifest/:date` passa a devolver `{ serviceDate, shifts: [{ shift, status, manifestVersion, content }] }`. O Dexie vai para a versão 3 mantendo o store `manifest` e a chave `serviceDate`; o upgrade só esvazia o store (é cache, baixado de novo). Um tablet com o build antigo em cache falha ao ler o romaneio até o service worker atualizar; as entregas continuam saindo porque a rodada envia a outbox antes de baixar o romaneio.
9. **`shift_finished`.** Fica em `shift_events (event_id PK, service_day_shift_id, device_id, type, occurred_at, received_at)`. O servidor processa as entregas do lote e depois cada `shift_finished`, em transações separadas (sem promover a trava do turno de `SHARE` para `UPDATE` na mesma transação). Turno inexistente ou ainda aberto → `rejected`; repetido, ou turno já finalizado por outro tablet → `accepted` sem efeito. O tablet só envia um `shift_finished` quando **não há nenhuma entrega da mesma data** na outbox (mais forte que "anteriores a ele" e independente do relógio, que `nextOccurredAt` pode adiantar).
10. **Entrega depois de finalizar.** `delivered` leva `not_collected → delivered`; `undelivered` num turno finalizado volta o pedido para `not_collected` (não para `confirmed`). O tablet continua deixando marcar pedidos de um turno finalizado (retirada atrasada).
11. **Decisão da secretaria.** Tabela `uncollected_decisions` (`UNIQUE (school_id, order_id)`, `decision` `credited|kept`, motivo opcional, `reviewed_at`). O **motivo fica nessa tabela**, não no `audit_log.detail` (o helper de auditoria só aceita ids e contagens); a auditoria registra `decision_id` e `has_reason`. "Para conferir" = decisão `credited` cujo pedido voltou a `delivered` e ainda sem `reviewed_at`; o botão "Marcar como conferido" grava `reviewed_at`.
12. **`not_collected` conta como pedido ativo** no índice `orders_one_active_per_student` (não deixa nascer outro pedido do mesmo aluno e data).
13. **Crédito de não retirado.** `wallet_entries.source_type` ganha `order` (`source_id` = id do pedido). Vai para o responsável financeiro **atual** do aluno; aluno sem responsável financeiro → 422 `invalid_order`. Não sai mensagem ao responsável (a spec não pede; aparece no extrato como "Lanche não retirado — devolvido").
14. **Lembretes (mínimo).** Um lote por data, como hoje. A janela abre quando algum turno aberto entra em `cutoff_at − reminder_lead_minutes` e fecha no corte mais tarde do dia. Entram só alunos cujo turno ainda está aberto e antes do corte; o `cutoff_at`/`cutoff_local_time` de cada destinatário é o **menor** corte entre os turnos dos filhos ainda sem pedido. Família só da tarde pode, portanto, ser lembrada na janela da manhã.
15. **Rede de segurança.** `list_due_actions()` ganha `finish_shifts` (dias com turno `closed` e `now() >= (service_date + 23:00) no fuso da escola`); só o job `POST /jobs/v1/shifts/safety-finish` consome; `GET /internal/v1/schedule/due` não lista (como `reconcile_topups`).
16. **Turno da turma.** `PUT /api/admin/v1/classes/:id/shift` (`OFFICE`, 204, auditada). UI: cartão "Turmas e turnos" na página "Alunos e responsáveis", que já carrega as turmas. Mudar o turno de uma turma não move checkouts existentes (o romaneio usa `checkouts.shift`). CSV: coluna opcional `turno`; vazio mantém o turno atual (turma nova: matutino); a mesma turma com turnos diferentes no arquivo → erro de linha.
17. **Link de pedido** (orientação 12): já expira em `service_days.cutoff_at`, que agora espelha o turno mais tarde; só ganha teste.
18. **Tela do responsável.** Um cartão por turno quando os filhos estão em turnos diferentes (título "Manhã"/"Tarde"), cada um com seu corte, seu carrinho e seu botão "Pagar". Filhos num turno sem lanche no dia: "Não há lanche para a turma de X neste dia."

Pontos que pedem decisão do usuário (o plano segue a opção marcada; mudar exige ajuste antes de executar):

- **P1 — corte padrão da tarde 13:00** e nenhuma tela para mudar os padrões. Outro horário? Tela de configuração?
- **P2 — lembrete da tarde na janela da manhã** (ruling 14). Se a família só da tarde precisar de lembrete próprio, é preciso um lote por data **e turno** (muda `reminder_batches` e o contrato do n8n) — fica para a Parte C, que reescreve os lembretes.
- **P3 — tablet com build antigo** perde o romaneio até atualizar (ruling 8). Alternativa: rota nova `/api/kds/v2/manifest` mantendo a v1 por um tempo.
- **P4 — turma nova num turno sem linha num dia que já tem pedidos:** pedidos desse turno são recusados (`shift_not_offered`) porque o dia não pode ser salvo de novo. Precisa de "acrescentar turno a dia com pedidos"?
- **P5 — dias antigos migrados como finalizados** (ruling 1): sem "não retirados" retroativos. Confirmar.

---

## Mapa de arquivos

```
db/migrations/0012_shifts.sql                                                              (Task 1)
apps/api/src/db/{types.ts,rls.test.ts,schema.test.ts}, apps/api/test/helpers.ts                (Task 1)
packages/contracts/src/shifts.ts (+index)                                                      (Task 1)
apps/api/src/modules/{catalog/repo.ts,orders/{repo,service}.ts,serviceDays/repo.ts} (compat)    (Task 1)
e2e/global-setup.ts; testes com UPDATE direto em service_days                                    (Task 1)
packages/contracts/src/{registry.ts,shifts.ts}; registry/{csv,repo,service,routes}.ts (+tests)  (Task 2)
apps/web/src/areas/admin/{ClassShifts.tsx,StudentsAdmin.tsx,studentsAdmin.test.tsx}; ui/shifts.ts; db/seed-dev.ts (Task 2)
packages/contracts/src/catalog.ts; catalog/{repo,service,routes}.ts (+catalog.test); admin ServiceDaysAdmin (form) (Task 3)
packages/contracts/src/{auth,checkout,errors}.ts; orders/*, payments/*, auth/repo.ts; web fixtures (Task 4)
apps/web/src/areas/guardian/{DayOrder.tsx,ShiftOrder.tsx,order.test.tsx}                        (Task 5)
db/migrations/0013_shift_schedule.sql; packages/contracts/src/{manifest,events}.ts; serviceDays/*, internal/routes.ts; n8n/code/{events,schedule}.js; ServiceDaysAdmin (Task 6)
packages/contracts/src/kds.ts; kds/{repo,service}.ts; web kds/{db,sync,state,KdsBoard,ShiftBoard}.tsx; e2e/shifts.spec.ts (Task 7)
kds/*, serviceDays/*, orders/*, catalog/*; ServiceDaysAdmin (finalizar)                            (Task 8)
web kds/{db,sync,state,ShiftBoard,KdsBoard}; e2e/shifts.spec.ts                                     (Task 9)
packages/contracts/src/{uncollected,wallet}.ts; modules/uncollected/*; web admin UncollectedAdmin, adminNav, walletLabels; dashboard test (Task 10)
serviceDays/*, jobs/*, reminders/*; packages/contracts/src/internal.ts; docs/deploy.md (Task 11)
specs, docs/local.md, verificação final                                                           (Task 12)
```

---

### Task 1: Migração `0012_shifts.sql` e compatibilidade de turno único

Ao fim desta tarefa o banco tem o modelo de turnos inteiro e o app continua funcionando como antes, com um turno `matutino` por dia (as tarefas seguintes passam a usar os turnos).

**Files:**
- Create: `db/migrations/0012_shifts.sql`
- Create: `packages/contracts/src/shifts.ts`
- Modify: `packages/contracts/src/index.ts` (exportar `./shifts`)
- Regenerate: `apps/api/src/db/types.ts`
- Modify: `apps/api/src/db/rls.test.ts` (`TENANT_TABLES`), `apps/api/src/db/schema.test.ts` (casos novos)
- Modify: `apps/api/test/helpers.ts` (`seedTenant`, `seedServiceDay`, `seedFamily`, `seedClosedDayWithOrders`; novos `seedConfirmedOrders`, `moveCutoff`, `markDayClosed`)
- Modify: `apps/api/src/modules/catalog/repo.ts:67-80` (`upsertServiceDay`) e `:133-142` (`markServiceDayClosed`)
- Modify: `apps/api/src/modules/orders/repo.ts:17-22` (`insertCheckout`), `apps/api/src/modules/orders/service.ts:64` (passa `shift: "matutino"`)
- Modify: `apps/api/src/modules/serviceDays/repo.ts:38-40` (`insertManifest`), `apps/api/src/modules/serviceDays/service.ts:67` (passa `shift: "matutino"`)
- Modify (UPDATE direto em `service_days` → helpers): `orders/cancel.test.ts:81`, `orders/checkout.test.ts:120`, `serviceDays/close.test.ts:33`, `catalog/catalog.test.ts:134-138,157`, `auth/magicLink.test.ts:53`, `payments/confirm.test.ts:117`, `internal/reminders.test.ts:12`
- Modify: `e2e/global-setup.ts`

**Interfaces:**
- Produces (contracts): `Shift = z.enum(["matutino", "vespertino"])`, `ShiftStatus = z.enum(["open", "closed", "finished"])`, `SHIFTS: readonly Shift[]` (`["matutino", "vespertino"]`), `CutoffTime` (`"HH:MM"`), tipos inferidos de mesmo nome.
- Produces (helpers de teste):
  - `seedServiceDay(schoolId, { serviceDate?, cutoffInMinutes?, items?, shifts?: Partial<Record<Shift, number>> })` → `{ serviceDayId, serviceDate, items, shiftIds: Partial<Record<Shift, string>> }` (`shifts` = minutos até o corte de cada turno; padrão `{ matutino: cutoffInMinutes ?? 60 }`; o dia espelha o maior).
  - `seedFamily(schoolId, names?, opts?: { className?: string; shift?: Shift })`.
  - `seedConfirmedOrders(schoolId, { serviceDayId, serviceDate, menuItemId, studentNames, shift?, className? })` → `{ guardianId, checkoutId, orderIds }`.
  - `seedClosedDayWithOrders(schoolId, { serviceDate, studentNames, shift? })` → `{ serviceDayId, orderIds }` (inalterado para quem já usa).
  - `moveCutoff(serviceDayId, seconds, shift?)`: corte do(s) turno(s) = `now() + seconds`, congelamento +5 min, e o dia espelha o maior.
  - `markDayClosed(serviceDayId)`: dia e turnos abertos → `closed` (sem romaneio).
- Produces (banco): tabelas `service_day_shifts`, `shift_events`, `uncollected_decisions`; colunas `classes.shift`, `checkouts.shift`, `manifests.shift`, `schools.cutoff_time_matutino`, `schools.cutoff_time_vespertino`; `orders.status` aceita `not_collected`; `wallet_entries.kind` aceita `uncollected_credit` e `source_type` aceita `order`.

- [ ] **Step 1: Write the failing tests**

Em `apps/api/src/db/rls.test.ts`, `TENANT_TABLES` passa a ter, em ordem de bytes:

```ts
  "service_day_items",
  "service_day_shifts",
  "service_days",
  "shift_events",
  "staff_users",
  "students",
  "topups",
  "uncollected_decisions",
  "wallet_entries",
  "wallets",
```

Em `apps/api/src/db/schema.test.ts`, no `it("allows one active order per student and date")`, depois de `await expect(insertOrder("confirmed")).rejects…`, acrescente:

```ts
    await expect(insertOrder("not_collected")).rejects.toThrow(/orders_one_active_per_student/);
```

e no fim do arquivo:

```ts
describe("F5C shifts schema", () => {
  let schoolId: string;
  let ids: SeedIds;

  beforeAll(async () => {
    schoolId = await createSchool();
    ids = await seedTenant(schoolId);
  });

  it("keeps one row per day and shift, with consistent states", async () => {
    const insert = (values: Record<string, unknown>) =>
      withTenant(schoolId, (trx) =>
        sql`INSERT INTO service_day_shifts (id, school_id, service_day_id, shift, cutoff_at, freeze_at, status, closed_at, finished_at)
            VALUES (${uuidv7()}, ${schoolId}, ${ids.serviceDayId}, ${values.shift}, now(), now() + interval '5 minutes',
                    ${values.status ?? "open"}, ${values.closedAt ?? null}, ${values.finishedAt ?? null})`.execute(trx),
      );
    await expect(insert({ shift: "matutino" })).rejects.toThrow(/service_day_shifts_school_id_service_day_id_shift_key/);
    await expect(insert({ shift: "integral" })).rejects.toThrow(/check constraint/);
    await expect(insert({ shift: "vespertino", status: "closed" })).rejects.toThrow(/check constraint/);
    await expect(insert({ shift: "vespertino", status: "finished", closedAt: new Date() })).rejects.toThrow(/check constraint/);
    await insert({ shift: "vespertino", status: "finished", closedAt: new Date(), finishedAt: new Date() });
  });

  it("ties checkouts and manifests to a shift that exists on that day", async () => {
    const day = await seedServiceDay(schoolId, { serviceDate: "2099-01-05" }); // só matutino
    const fam = await seedFamily(schoolId, ["Léo"]);
    const checkout = (shift: string) =>
      withTenant(schoolId, (trx) =>
        trx.insertInto("checkouts").values({ id: uuidv7(), schoolId, guardianId: fam.guardianId, serviceDayId: day.serviceDayId, shift, totalCents: 900 }).execute(),
      );
    await expect(checkout("vespertino")).rejects.toThrow(/checkouts_shift_fk/);
    await checkout("matutino");
    const manifest = (shift: string) =>
      withTenant(schoolId, (trx) =>
        trx.insertInto("manifests").values({ id: uuidv7(), schoolId, serviceDayId: day.serviceDayId, shift, content: JSON.stringify({}) }).execute(),
      );
    await expect(manifest("vespertino")).rejects.toThrow(/manifests_shift_fk/);
    await manifest("matutino");
    await expect(manifest("matutino")).rejects.toThrow(/manifests_shift_version_key/);
  });

  it("credits an uncollected order at most once and only as a positive amount", async () => {
    const credit = (amountCents: number, sourceType = "order") =>
      withTenant(schoolId, (trx) =>
        trx.insertInto("walletEntries")
          .values({ id: uuidv7(), schoolId, walletId: ids.walletId, kind: "uncollected_credit", amountCents, sourceType, sourceId: ids.orderId })
          .execute(),
      );
    await expect(credit(-900)).rejects.toThrow(/check constraint/);
    await credit(900);
    await expect(credit(900, "adjustment")).rejects.toThrow(/wallet_entries_one_uncollected_credit/);
  });

  it("makes shift events append-only and lets decisions change only the review columns", async () => {
    await expect(withTenant(schoolId, (trx) => sql`UPDATE shift_events SET occurred_at = now()`.execute(trx))).rejects.toThrow(/permission denied/);
    await expect(withTenant(schoolId, (trx) => sql`DELETE FROM shift_events`.execute(trx))).rejects.toThrow(/permission denied/);
    await expect(withTenant(schoolId, (trx) => sql`UPDATE uncollected_decisions SET decision = 'credited'`.execute(trx))).rejects.toThrow(/permission denied/);
    await expect(withTenant(schoolId, (trx) => sql`DELETE FROM uncollected_decisions`.execute(trx))).rejects.toThrow(/permission denied/);
    // A semente é uma decisão "kept": o privilégio de UPDATE nas colunas de conferência existe (o erro é da CHECK,
    // avaliada depois da permissão), e só decisões "credited" podem ser conferidas.
    const { staffUserId } = await adminDb().selectFrom("staffUsers").select("id as staffUserId").where("schoolId", "=", schoolId).executeTakeFirstOrThrow();
    await expect(
      withTenant(schoolId, (trx) => sql`UPDATE uncollected_decisions SET reviewed_at = now(), reviewed_by_staff_id = ${staffUserId}`.execute(trx)),
    ).rejects.toThrow(/check constraint/);
  });

  it("defaults a class to the morning shift and moves the school's cutoff to the morning column", async () => {
    const row = await adminDb().selectFrom("classes").select("shift").where("id", "=", ids.classId).executeTakeFirstOrThrow();
    expect(row.shift).toBe("matutino");
    const { rows } = await sql<{ m: string; v: string }>`
      SELECT cutoff_time_matutino::text AS m, cutoff_time_vespertino::text AS v FROM schools WHERE id = ${schoolId}`.execute(adminDb());
    expect(rows[0]).toEqual({ m: "07:30:00", v: "13:00:00" });
  });
});
```

(`seedFamily` e `seedServiceDay` já estão importados em `schema.test.ts`; acrescente `adminDb` se faltar.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm app:down; docker compose down; pnpm --filter @app-lanche/api exec vitest run src/db/rls.test.ts src/db/schema.test.ts`
Expected: FAIL (`relation "service_day_shifts" does not exist`, lista de tabelas diferente).

- [ ] **Step 3: Write the migration** — `db/migrations/0012_shifts.sql`

```sql
-- F5C Parte B: turnos (matutino/vespertino), corte, fechamento e romaneio por turno, "Finalizar turno" e
-- pedidos não retirados (spec 2026-11-20-admin-turnos-avisos-design.md, B.1).

-- Turno da turma. Escola de um turno só fica toda no matutino.
ALTER TABLE classes ADD COLUMN shift text NOT NULL DEFAULT 'matutino' CHECK (shift IN ('matutino', 'vespertino'));

-- Corte padrão por turno. O antigo default_cutoff_time vira o do matutino; o vespertino começa às 13:00.
ALTER TABLE schools ADD COLUMN cutoff_time_matutino time NOT NULL DEFAULT '07:30';
ALTER TABLE schools ADD COLUMN cutoff_time_vespertino time NOT NULL DEFAULT '13:00';
UPDATE schools SET cutoff_time_matutino = default_cutoff_time;
ALTER TABLE schools DROP COLUMN default_cutoff_time;

-- Um turno ativo por dia. service_days.cutoff_at/freeze_at espelham o turno mais tarde (compatibilidade).
CREATE TABLE service_day_shifts (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  service_day_id uuid NOT NULL,
  shift text NOT NULL CHECK (shift IN ('matutino', 'vespertino')),
  cutoff_at timestamptz NOT NULL,
  freeze_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'finished')),
  closed_at timestamptz,
  finished_at timestamptz,
  finished_by_device_id uuid,
  finished_by_staff_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, service_day_id, shift),
  FOREIGN KEY (school_id, service_day_id) REFERENCES service_days (school_id, id),
  FOREIGN KEY (school_id, finished_by_device_id) REFERENCES devices (school_id, id),
  FOREIGN KEY (school_id, finished_by_staff_id) REFERENCES staff_users (school_id, id),
  CHECK (freeze_at > cutoff_at),
  CHECK ((status = 'open') = (closed_at IS NULL)),
  CHECK ((status = 'finished') = (finished_at IS NOT NULL)),
  CHECK (finished_by_device_id IS NULL OR finished_by_staff_id IS NULL),
  CHECK (status = 'finished' OR (finished_by_device_id IS NULL AND finished_by_staff_id IS NULL))
);
CREATE INDEX service_day_shifts_closed ON service_day_shifts (school_id, service_day_id) WHERE status = 'closed';

-- Dados existentes: um turno matutino por dia, com os horários e o estado do dia. Dia fechado de data passada já foi
-- servido: entra como finalizado sem mexer nos pedidos (não gera "não retirados" retroativos).
INSERT INTO service_day_shifts (id, school_id, service_day_id, shift, cutoff_at, freeze_at, status, closed_at, finished_at)
SELECT gen_random_uuid(), d.school_id, d.id, 'matutino', d.cutoff_at, d.freeze_at,
       CASE WHEN d.status = 'open' THEN 'open'
            WHEN d.service_date < (now() AT TIME ZONE s.timezone)::date THEN 'finished'
            ELSE 'closed' END,
       d.closed_at,
       CASE WHEN d.status = 'closed' AND d.service_date < (now() AT TIME ZONE s.timezone)::date THEN d.closed_at END
FROM service_days d JOIN schools s ON s.id = d.school_id;

-- O checkout é a unidade de pagamento de um turno.
ALTER TABLE checkouts ADD COLUMN shift text NOT NULL DEFAULT 'matutino' CHECK (shift IN ('matutino', 'vespertino'));
ALTER TABLE checkouts ALTER COLUMN shift DROP DEFAULT;
ALTER TABLE checkouts ADD CONSTRAINT checkouts_shift_fk
  FOREIGN KEY (school_id, service_day_id, shift) REFERENCES service_day_shifts (school_id, service_day_id, shift);
DROP INDEX checkouts_day_status;
CREATE INDEX checkouts_day_status ON checkouts (school_id, service_day_id, shift, status);

-- Romaneio por turno, imutável depois de gravado (regra 18). A coluna nova não altera o conteúdo gravado.
ALTER TABLE manifests ADD COLUMN shift text NOT NULL DEFAULT 'matutino' CHECK (shift IN ('matutino', 'vespertino'));
ALTER TABLE manifests ALTER COLUMN shift DROP DEFAULT;
ALTER TABLE manifests DROP CONSTRAINT manifests_school_id_service_day_id_version_key;
ALTER TABLE manifests ADD CONSTRAINT manifests_shift_version_key UNIQUE (school_id, service_day_id, shift, version);
ALTER TABLE manifests ADD CONSTRAINT manifests_shift_fk
  FOREIGN KEY (school_id, service_day_id, shift) REFERENCES service_day_shifts (school_id, service_day_id, shift);

-- Pedido pago e não retirado. Continua ativo: não deixa nascer outro pedido do aluno na mesma data.
ALTER TABLE orders DROP CONSTRAINT orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (status IN (
  'pending', 'confirmed', 'delivered', 'expired', 'expired_late', 'cancelled', 'not_collected'));
DROP INDEX orders_one_active_per_student;
CREATE UNIQUE INDEX orders_one_active_per_student
  ON orders (school_id, student_id, service_date) WHERE status IN ('pending', 'confirmed', 'delivered', 'not_collected');
CREATE INDEX orders_not_collected ON orders (school_id, service_date) WHERE status = 'not_collected';

-- Devolução de não retirado: crédito positivo, origem no pedido, uma vez por pedido.
ALTER TABLE wallet_entries DROP CONSTRAINT wallet_entries_kind_check;
ALTER TABLE wallet_entries ADD CONSTRAINT wallet_entries_kind_check CHECK (kind IN (
  'checkout_hold', 'hold_release', 'late_payment_credit', 'cancel_credit', 'refund', 'manual_adjustment',
  'counter_charge', 'counter_void', 'topup_credit', 'uncollected_credit'));
ALTER TABLE wallet_entries DROP CONSTRAINT wallet_entries_source_type_check;
ALTER TABLE wallet_entries ADD CONSTRAINT wallet_entries_source_type_check
  CHECK (source_type IN ('checkout', 'payment', 'adjustment', 'counter_sale', 'topup', 'order'));
ALTER TABLE wallet_entries DROP CONSTRAINT wallet_entries_sign_check;
ALTER TABLE wallet_entries ADD CONSTRAINT wallet_entries_sign_check CHECK (
  (kind IN ('checkout_hold', 'refund', 'counter_charge') AND amount_cents < 0)
  OR (kind IN ('hold_release', 'late_payment_credit', 'cancel_credit', 'counter_void', 'topup_credit', 'uncollected_credit') AND amount_cents > 0)
  OR kind = 'manual_adjustment'
);
CREATE UNIQUE INDEX wallet_entries_one_uncollected_credit ON wallet_entries (school_id, source_id) WHERE kind = 'uncollected_credit';

-- "Finalizar turno" vindo do tablet. event_id gerado no cliente é a chave (regra 36); append-only.
CREATE TABLE shift_events (
  event_id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  service_day_shift_id uuid NOT NULL,
  device_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('shift_finished')),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, event_id),
  FOREIGN KEY (school_id, service_day_shift_id) REFERENCES service_day_shifts (school_id, id),
  FOREIGN KEY (school_id, device_id) REFERENCES devices (school_id, id)
);

-- Decisão da secretaria sobre um pedido não retirado. Uma por pedido; só a conferência muda depois.
CREATE TABLE uncollected_decisions (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  order_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('credited', 'kept')),
  guardian_id uuid,
  wallet_entry_id uuid,
  amount_cents bigint CHECK (amount_cents > 0),
  reason text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 200),
  staff_user_id uuid NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by_staff_id uuid,
  UNIQUE (school_id, id),
  UNIQUE (school_id, order_id),
  FOREIGN KEY (school_id, order_id) REFERENCES orders (school_id, id),
  FOREIGN KEY (school_id, guardian_id) REFERENCES guardians (school_id, id),
  FOREIGN KEY (school_id, wallet_entry_id) REFERENCES wallet_entries (school_id, id),
  FOREIGN KEY (school_id, staff_user_id) REFERENCES staff_users (school_id, id),
  FOREIGN KEY (school_id, reviewed_by_staff_id) REFERENCES staff_users (school_id, id),
  CHECK ((decision = 'credited') = (wallet_entry_id IS NOT NULL)),
  CHECK ((wallet_entry_id IS NULL) = (guardian_id IS NULL) AND (guardian_id IS NULL) = (amount_cents IS NULL)),
  CHECK ((reviewed_at IS NULL) = (reviewed_by_staff_id IS NULL)),
  CHECK (reviewed_at IS NULL OR decision = 'credited')
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['service_day_shifts', 'shift_events', 'uncollected_decisions']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (school_id = app_school_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON service_day_shifts TO app_user;
GRANT SELECT, INSERT ON shift_events, uncollected_decisions TO app_user;
GRANT UPDATE (reviewed_at, reviewed_by_staff_id) ON uncollected_decisions TO app_user;
```

- [ ] **Step 4: Contracts** — `packages/contracts/src/shifts.ts`

```ts
import { z } from "zod";

/** Turno da turma e do dia (spec F5C, B.1). Turnos além destes ficam fora do escopo. */
export const Shift = z.enum(["matutino", "vespertino"]);
export type Shift = z.infer<typeof Shift>;
export const SHIFTS: readonly Shift[] = Shift.options;

/** open → closed (romaneio pronto) → finished (cozinha encerrou; pendentes viram não retirados). */
export const ShiftStatus = z.enum(["open", "closed", "finished"]);
export type ShiftStatus = z.infer<typeof ShiftStatus>;

/** Horário local "HH:MM". */
export const CutoffTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
```

Em `packages/contracts/src/index.ts` acrescente `export * from "./shifts";` em ordem alfabética.

- [ ] **Step 5: Regenerate the Kysely types**

Run (da raiz): `pnpm db:up; DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/app_lanche APP_DB_PASSWORD=app_user pnpm db:migrate; DATABASE_URL=postgres://postgres:postgres@localhost:5432/app_lanche pnpm db:types; docker compose down`
Expected: `apps/api/src/db/types.ts` ganha `ServiceDayShifts`, `ShiftEvents`, `UncollectedDecisions`, `Classes.shift: Generated<string>`, `Checkouts.shift: string`, `Manifests.shift: string`, `Schools.cutoffTimeMatutino`/`cutoffTimeVespertino`, e perde `Schools.defaultCutoffTime`.

- [ ] **Step 6: Compatibility code (um turno matutino por dia)**

`apps/api/src/modules/catalog/repo.ts` — `upsertServiceDay` passa a ler `cutoff_time_matutino` e a manter a linha do turno (a Task 3 generaliza):

```ts
/** Cria ou atualiza o horário do dia (e do turno matutino), calculado no banco no fuso da escola. */
export async function upsertServiceDay(trx: Trx, schoolId: string, serviceDate: string, cutoffTime: string | null) {
  const { rows } = await sql<{ id: string; cutoffInFuture: boolean }>`
    INSERT INTO service_days (id, school_id, service_date, cutoff_at, freeze_at)
    SELECT ${uuidv7()}, s.id, ${serviceDate}::date, c.cutoff_at, c.cutoff_at + interval '5 minutes'
    FROM schools s
    CROSS JOIN LATERAL (
      SELECT ((${serviceDate}::date + coalesce(${cutoffTime}::time, s.cutoff_time_matutino)) AT TIME ZONE s.timezone) AS cutoff_at
    ) c
    WHERE s.id = ${schoolId}
    ON CONFLICT (school_id, service_date)
      DO UPDATE SET cutoff_at = EXCLUDED.cutoff_at, freeze_at = EXCLUDED.freeze_at
    RETURNING id, cutoff_at, freeze_at, now() < cutoff_at AS cutoff_in_future`.execute(trx);
  const day = rows[0]!;
  await sql`
    INSERT INTO service_day_shifts (id, school_id, service_day_id, shift, cutoff_at, freeze_at)
    SELECT ${uuidv7()}, d.school_id, d.id, 'matutino', d.cutoff_at, d.freeze_at FROM service_days d WHERE d.id = ${day.id}
    ON CONFLICT (school_id, service_day_id, shift) DO UPDATE SET cutoff_at = EXCLUDED.cutoff_at, freeze_at = EXCLUDED.freeze_at`.execute(trx);
  return { id: day.id, cutoffInFuture: day.cutoffInFuture };
}
```

`markServiceDayClosed` fecha também os turnos abertos, antes do dia:

```ts
export async function markServiceDayClosed(trx: Trx, serviceDayId: string): Promise<Date | null> {
  await trx
    .updateTable("serviceDayShifts")
    .set({ status: "closed", closedAt: sql<Date>`now()` })
    .where("serviceDayId", "=", serviceDayId)
    .where("status", "=", "open")
    .execute();
  const row = await trx
    .updateTable("serviceDays")
    .set({ status: "closed", closedAt: sql<Date>`now()` })
    .where("id", "=", serviceDayId)
    .where("status", "=", "open")
    .returning("closedAt")
    .executeTakeFirst();
  return row?.closedAt ?? null;
}
```

`apps/api/src/modules/orders/repo.ts` — `insertCheckout` recebe `shift: Shift` (importe `type Shift` de `@app-lanche/contracts`) no tipo da linha; em `orders/service.ts` (`placeCheckout`) a chamada passa `shift: "matutino"`.

`apps/api/src/modules/serviceDays/repo.ts` — `insertManifest(trx, row: { schoolId; serviceDayId; shift: Shift; content })`; em `serviceDays/service.ts` (`closeServiceDay`) a chamada passa `shift: "matutino"`.

- [ ] **Step 7: Test helpers** — `apps/api/test/helpers.ts`

Importe `type Shift` de `@app-lanche/contracts`. Em `SeedIds` acrescente `serviceDayShiftId: string; shiftEventId: string; uncollectedDecisionId: string;` e gere-os com `uuidv7()` no objeto `ids`. Em `seedTenant`:

- logo depois do insert em `serviceDays`:
  ```ts
  await db
    .insertInto("serviceDayShifts")
    .values({ id: ids.serviceDayShiftId, schoolId, serviceDayId: ids.serviceDayId, shift: "matutino", cutoffAt, freezeAt: new Date(cutoffAt.getTime() + 300_000) })
    .execute();
  ```
- no insert de `checkouts`, acrescente `shift: "matutino"`; no de `manifests`, `shift: "matutino"`;
- no fim (antes do `return ids`):
  ```ts
  // F5C Parte B: evento de turno finalizado e decisão de não retirado.
  await db
    .insertInto("shiftEvents")
    .values({ eventId: ids.shiftEventId, schoolId, serviceDayShiftId: ids.serviceDayShiftId, deviceId: ids.kitchenDeviceId, type: "shift_finished", occurredAt: new Date() })
    .execute();
  await db
    .insertInto("uncollectedDecisions")
    .values({ id: ids.uncollectedDecisionId, schoolId, orderId: ids.orderId, decision: "kept", staffUserId: ids.staffUserId })
    .execute();
  ```

`seedFamily` ganha um terceiro parâmetro:

```ts
export async function seedFamily(
  schoolId: string,
  names: string[] = ["Léo", "Bia"],
  opts: { className?: string; shift?: Shift } = {},
): Promise<{ guardianId: string; studentIds: string[] }> {
  const db = adminDb();
  const className = opts.className ?? "Infantil 3A";
  const shift = opts.shift ? { shift: opts.shift } : {};
  const cls = await db
    .insertInto("classes")
    .values({ id: uuidv7(), schoolId, name: className, ...shift })
    .onConflict((oc) => oc.columns(["schoolId", "name"]).doUpdateSet({ name: className, ...shift }))
    .returning("id")
    .executeTakeFirstOrThrow();
  // … resto igual (guardião, alunos, vínculos financeiros) …
}
```

`seedServiceDay` cria as linhas de turno:

```ts
export async function seedServiceDay(
  schoolId: string,
  opts: { serviceDate?: string; cutoffInMinutes?: number; items?: { name: string; priceCents: number }[]; shifts?: Partial<Record<Shift, number>> } = {},
): Promise<{ serviceDayId: string; serviceDate: string; items: { id: string; name: string; priceCents: number }[]; shiftIds: Partial<Record<Shift, string>> }> {
  const db = adminDb();
  const serviceDate = opts.serviceDate ?? "2030-03-04";
  const shifts = opts.shifts ?? { matutino: opts.cutoffInMinutes ?? 60 };
  const dayMinutes = Math.max(...Object.values(shifts));
  const serviceDayId = uuidv7();
  await sql`
    INSERT INTO service_days (id, school_id, service_date, cutoff_at, freeze_at)
    VALUES (${serviceDayId}, ${schoolId}, ${serviceDate}::date,
            now() + make_interval(mins => ${dayMinutes}), now() + make_interval(mins => ${dayMinutes + 5}))`.execute(db);
  const shiftIds: Partial<Record<Shift, string>> = {};
  for (const [shift, minutes] of Object.entries(shifts) as [Shift, number][]) {
    const id = uuidv7();
    await sql`
      INSERT INTO service_day_shifts (id, school_id, service_day_id, shift, cutoff_at, freeze_at)
      VALUES (${id}, ${schoolId}, ${serviceDayId}, ${shift},
              now() + make_interval(mins => ${minutes}), now() + make_interval(mins => ${minutes + 5}))`.execute(db);
    shiftIds[shift] = id;
  }
  // … itens como hoje …
  return { serviceDayId, serviceDate, items, shiftIds };
}
```

Novos helpers (e `seedClosedDayWithOrders` reescrito em cima de `seedConfirmedOrders`):

```ts
/** Pedidos confirmados (1x o item) de uma família nova, num checkout pago do turno. */
export async function seedConfirmedOrders(
  schoolId: string,
  opts: { serviceDayId: string; serviceDate: string; menuItemId: string; studentNames: string[]; shift?: Shift; className?: string },
): Promise<{ guardianId: string; checkoutId: string; orderIds: string[] }> {
  const shift = opts.shift ?? "matutino";
  const fam = await seedFamily(schoolId, opts.studentNames, { shift, className: opts.className ?? (shift === "matutino" ? "Infantil 3A" : "Infantil 5C") });
  const db = adminDb();
  const checkoutId = uuidv7();
  await db
    .insertInto("checkouts")
    .values({ id: checkoutId, schoolId, guardianId: fam.guardianId, serviceDayId: opts.serviceDayId, shift, status: "paid", totalCents: 900 * fam.studentIds.length })
    .execute();
  const orderIds: string[] = [];
  for (const studentId of fam.studentIds) {
    const orderId = uuidv7();
    await db.insertInto("orders").values({ id: orderId, schoolId, checkoutId, studentId, serviceDate: opts.serviceDate, status: "confirmed" }).execute();
    await db.insertInto("orderItems").values({ id: uuidv7(), schoolId, orderId, menuItemId: opts.menuItemId, qty: 1, unitPriceCents: 900 }).execute();
    orderIds.push(orderId);
  }
  return { guardianId: fam.guardianId, checkoutId, orderIds };
}

/** Dia (de um turno) já depois do corte, com um pedido confirmado por aluno; o teste fecha o dia. */
export async function seedClosedDayWithOrders(
  schoolId: string,
  opts: { serviceDate: string; studentNames: string[]; shift?: Shift },
): Promise<{ serviceDayId: string; orderIds: string[] }> {
  const shift = opts.shift ?? "matutino";
  const day = await seedServiceDay(schoolId, { serviceDate: opts.serviceDate, shifts: { [shift]: -30 } });
  const seeded = await seedConfirmedOrders(schoolId, { serviceDayId: day.serviceDayId, serviceDate: opts.serviceDate, menuItemId: day.items[0]!.id, studentNames: opts.studentNames, shift });
  return { serviceDayId: day.serviceDayId, orderIds: seeded.orderIds };
}

/** Corte do turno (ou de todos) = agora + `seconds`; congelamento 5 min depois; o dia espelha o turno mais tarde. */
export async function moveCutoff(serviceDayId: string, seconds: number, shift?: Shift): Promise<void> {
  const db = adminDb();
  await sql`
    UPDATE service_day_shifts
    SET cutoff_at = now() + make_interval(secs => ${seconds}), freeze_at = now() + make_interval(secs => ${seconds + 300})
    WHERE service_day_id = ${serviceDayId} AND (${shift ?? null}::text IS NULL OR shift = ${shift ?? null}::text)`.execute(db);
  await sql`
    UPDATE service_days d SET cutoff_at = m.cutoff_at, freeze_at = m.freeze_at
    FROM (SELECT max(cutoff_at) AS cutoff_at, max(freeze_at) AS freeze_at FROM service_day_shifts WHERE service_day_id = ${serviceDayId}) m
    WHERE d.id = ${serviceDayId}`.execute(db);
}

/** Dia e turnos abertos → closed, direto no banco (sem romaneio): testes de pedido e cardápio. */
export async function markDayClosed(serviceDayId: string): Promise<void> {
  const db = adminDb();
  await sql`UPDATE service_day_shifts SET status = 'closed', closed_at = now() WHERE service_day_id = ${serviceDayId} AND status = 'open'`.execute(db);
  await sql`UPDATE service_days SET status = 'closed', closed_at = now() WHERE id = ${serviceDayId} AND status = 'open'`.execute(db);
}
```

Troque os `UPDATE` diretos em `service_days` dos testes pelos helpers (importe-os de `../../../test/helpers`):

| Arquivo:linha | Hoje | Passa a ser |
| --- | --- | --- |
| `orders/cancel.test.ts:81` | `UPDATE service_days SET cutoff_at = now() - 1 min, freeze_at = now() + 4 min` | `await moveCutoff(s.day.serviceDayId, -60);` |
| `orders/checkout.test.ts:120` | `UPDATE service_days SET status = 'closed' …` | `await markDayClosed(closed.day.serviceDayId);` |
| `serviceDays/close.test.ts:33` (`passCutoff`) | `UPDATE service_days SET cutoff_at = now() - 1 s` | corpo: `await moveCutoff(serviceDayId, -1);` |
| `catalog/catalog.test.ts:157` | `UPDATE service_days SET status = 'closed' …` | `await markDayClosed(closed.serviceDayId);` |
| `auth/magicLink.test.ts:53` | `updateTable("serviceDays").set({ status: "closed" … })` | `await markDayClosed(closed.serviceDayId);` |
| `payments/confirm.test.ts:117` | `UPDATE service_days SET status = 'closed' …` | `await markDayClosed(c.day.serviceDayId);` |

E acrescente `shift: "matutino"` aos inserts diretos de `checkouts` em `catalog/catalog.test.ts:134-138` e `internal/reminders.test.ts:12`.

`e2e/global-setup.ts`: depois do insert do dia, insira o turno; o checkout leva `shift`:

```ts
    await db.query(
      `INSERT INTO service_day_shifts (id, school_id, service_day_id, shift, cutoff_at, freeze_at)
       SELECT gen_random_uuid(), school_id, id, 'matutino', cutoff_at, freeze_at FROM service_days WHERE id = $1`,
      [day!.id],
    );
```

e `INSERT INTO checkouts (id, school_id, guardian_id, service_day_id, shift, status, total_cents) VALUES (gen_random_uuid(), $1, $2, $3, 'matutino', 'paid', 2700)`.

- [ ] **Step 8: Run the whole API suite and the checks**

Run: `pnpm app:down; docker compose down; pnpm --filter @app-lanche/contracts test && pnpm test:api && pnpm typecheck && pnpm lint`
Expected: PASS (inclusive `rls.test.ts` com as três tabelas novas e `schema.test.ts`).

- [ ] **Step 9: Commit**

```bash
git add db/migrations/0012_shifts.sql packages/contracts/src/shifts.ts packages/contracts/src/index.ts apps/api/src/db/types.ts \
  apps/api/src/db/rls.test.ts apps/api/src/db/schema.test.ts apps/api/test/helpers.ts \
  apps/api/src/modules/catalog/repo.ts apps/api/src/modules/orders/repo.ts apps/api/src/modules/orders/service.ts \
  apps/api/src/modules/serviceDays/repo.ts apps/api/src/modules/serviceDays/service.ts \
  apps/api/src/modules/orders/cancel.test.ts apps/api/src/modules/orders/checkout.test.ts apps/api/src/modules/serviceDays/close.test.ts \
  apps/api/src/modules/catalog/catalog.test.ts apps/api/src/modules/auth/magicLink.test.ts apps/api/src/modules/payments/confirm.test.ts \
  apps/api/src/modules/internal/reminders.test.ts e2e/global-setup.ts
git commit -m "feat(db): shifts, shift events and uncollected decisions schema"
```

---

### Task 2: Turno da turma (CSV, rota e cartão "Turmas e turnos")

**Files:**
- Modify: `packages/contracts/src/registry.ts` (`ClassListResponse` com `shift`; `SetClassShiftRequest`)
- Modify: `apps/api/src/modules/registry/csv.ts` (coluna `turno`), `csv.test.ts`
- Modify: `apps/api/src/modules/registry/repo.ts` (`upsertClass`, `listClasses`, `setClassShift`), `service.ts`, `routes.ts`
- Modify: `apps/api/src/modules/registry/import.test.ts`; Create: `apps/api/src/modules/registry/classShift.test.ts`
- Create: `apps/web/src/ui/shifts.ts`, `apps/web/src/areas/admin/ClassShifts.tsx`
- Modify: `apps/web/src/areas/admin/StudentsAdmin.tsx`, `studentsAdmin.test.tsx`
- Modify: `db/seed-dev.ts` (turma "Infantil 4B" no vespertino)
- Modify: `docs/superpowers/specs/2026-11-20-admin-turnos-avisos-design.md` (B.1: valores aceitos na coluna `turno`)

**Interfaces:**
- Consumes: `Shift`, `SHIFTS` (Task 1).
- Produces: `ClassListResponse.classes[]: { id, name, shift: Shift }`; `SetClassShiftRequest = { shift: Shift }`; rota `PUT /api/admin/v1/classes/:id/shift` → 204; `parseShift(raw: string): Shift | null` em `csv.ts`; `StudentRow.shift: Shift | null`; web `SHIFT_LABELS: Record<Shift, string>` (`{ matutino: "Manhã", vespertino: "Tarde" }`) em `apps/web/src/ui/shifts.ts`; componente `ClassShifts({ classes, onChanged })`.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/modules/registry/csv.test.ts` (acrescente):

```ts
describe("turno column", () => {
  const HEADER = "codigo_aluno,primeiro_nome,turma,responsavel_nome,responsavel_telefone,turno";

  it("accepts morning and afternoon names without case or accents and leaves blanks as null", () => {
    expect(parseShift("Matutino")).toBe("matutino");
    expect(parseShift(" MANHÃ ")).toBe("matutino");
    expect(parseShift("manha")).toBe("matutino");
    expect(parseShift("Vespertino")).toBe("vespertino");
    expect(parseShift("tarde")).toBe("vespertino");
    expect(parseShift("integral")).toBeNull();
    const { rows, errors } = parseStudentsCsv(`${HEADER}\nA1,Léo,3A,Ana,11999990001,Tarde\nA2,Bia,4B,Rui,11999990002,`);
    expect(errors).toEqual([]);
    expect(rows.map((r) => r.shift)).toEqual(["vespertino", null]);
  });

  it("rejects an unknown shift and a class with two shifts in the same file", () => {
    expect(parseStudentsCsv(`${HEADER}\nA1,Léo,3A,Ana,11999990001,noite`).errors).toEqual([{ line: 2, message: "turno inválido" }]);
    expect(parseStudentsCsv(`${HEADER}\nA1,Léo,3A,Ana,11999990001,manhã\nA2,Bia,3A,Rui,11999990002,tarde`).errors).toEqual([
      { line: 3, message: "turma com turnos diferentes" },
    ]);
  });
});
```

(importe `parseShift` de `./csv`.)

`apps/api/src/modules/registry/classShift.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { adminDb, createSchool, seedFamily, staffCookie } from "../../../test/helpers";
import { buildApp } from "../../app";

const csv = (rows: string) => `codigo_aluno,primeiro_nome,turma,responsavel_nome,responsavel_telefone,turno\n${rows}`;

describe("class shift", () => {
  it("imports the shift, keeps it when the column is blank and lists it", async () => {
    const schoolId = await createSchool();
    const { cookies } = await staffCookie(schoolId, "secretaria");
    const app = buildApp();
    const imp = (rows: string) => app.inject({ method: "POST", url: "/api/admin/v1/import/students", cookies, payload: { csv: csv(rows) } });
    expect((await imp("A1,Léo,Infantil 5C,Ana,11999990001,tarde\nA2,Bia,Infantil 3A,Ana,11999990001,")).json().applied).toBe(true);
    expect((await imp("A1,Léo,Infantil 5C,Ana,11999990001,")).json().applied).toBe(true);
    const list = await app.inject({ method: "GET", url: "/api/admin/v1/classes", cookies });
    expect(list.json().classes.map((c: { name: string; shift: string }) => [c.name, c.shift])).toEqual([
      ["Infantil 3A", "matutino"],
      ["Infantil 5C", "vespertino"],
    ]);
  });

  it("changes a class's shift, audits it and refuses other roles and unknown classes", async () => {
    const schoolId = await createSchool();
    await seedFamily(schoolId, ["Léo"]);
    const cls = await adminDb().selectFrom("classes").select("id").where("schoolId", "=", schoolId).executeTakeFirstOrThrow();
    const { cookies } = await staffCookie(schoolId, "admin");
    const app = buildApp();
    const put = (id: string, shift: string, c = cookies) => app.inject({ method: "PUT", url: `/api/admin/v1/classes/${id}/shift`, cookies: c, payload: { shift } });
    expect((await put(cls.id, "vespertino")).statusCode).toBe(204);
    expect((await put(cls.id, "vespertino")).statusCode).toBe(204);
    const row = await adminDb().selectFrom("classes").select("shift").where("id", "=", cls.id).executeTakeFirstOrThrow();
    expect(row.shift).toBe("vespertino");
    const audits = await adminDb().selectFrom("auditLog").select("detail").where("schoolId", "=", schoolId).where("action", "=", "class.shift_changed").execute();
    expect(audits).toHaveLength(1);
    expect((await put(cls.id, "noite")).statusCode).toBe(400);
    expect((await put(uuidv7(), "matutino")).statusCode).toBe(404);
    const kitchen = await staffCookie(schoolId, "cozinha");
    expect((await put(cls.id, "matutino", kitchen.cookies)).statusCode).toBe(403);
  });
});
```

Web — em `studentsAdmin.test.tsx`, `CLASSES` passa a ter `shift` (`{ id: C1, name: "Infantil 3A", shift: "matutino" }`, `{ id: C2, name: "Infantil 4B", shift: "vespertino" }`) e acrescente:

```tsx
  it("changes a class's shift from the classes card", async () => {
    const fn = mockApi({ ...BASE, [`PUT /api/admin/v1/classes/${C1}/shift`]: { status: 204 } });
    renderPage();
    const select = await screen.findByLabelText("Turno de Infantil 3A");
    expect((select as HTMLSelectElement).value).toBe("matutino");
    expect((screen.getByLabelText("Turno de Infantil 4B") as HTMLSelectElement).value).toBe("vespertino");
    fireEvent.change(select, { target: { value: "vespertino" } });
    await waitFor(() => expect(bodyOf(fn, `PUT /api/admin/v1/classes/${C1}/shift`)).toEqual({ shift: "vespertino" }));
    await waitFor(() => expect(fn.mock.calls.filter((c) => c[0] === "/api/admin/v1/classes").length).toBe(2));
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @app-lanche/api exec vitest run src/modules/registry && pnpm --filter @app-lanche/web exec vitest run src/areas/admin/studentsAdmin.test.tsx`
Expected: FAIL (`parseShift` não existe; `shift` ausente; rota 404; rótulo não encontrado).

- [ ] **Step 3: Contracts** — em `packages/contracts/src/registry.ts`:

```ts
import { Shift } from "./shifts";

export const ClassListResponse = z.object({
  classes: z.array(z.object({ id: z.string().uuid(), name: z.string(), shift: Shift })),
});
export type ClassListResponse = z.infer<typeof ClassListResponse>;

/** PUT /api/admin/v1/classes/:id/shift — naturalmente idempotente (204). */
export const SetClassShiftRequest = z.object({ shift: Shift }).strict();
export type SetClassShiftRequest = z.infer<typeof SetClassShiftRequest>;
```

- [ ] **Step 4: CSV** — em `apps/api/src/modules/registry/csv.ts`:

```ts
import type { Shift } from "@app-lanche/contracts";

/** "Manhã", "matutino", "TARDE"… → turno; vazio fica a cargo de quem chama; desconhecido → null. */
export function parseShift(raw: string): Shift | null {
  const v = raw.trim().toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
  if (v === "matutino" || v === "manha") return "matutino";
  if (v === "vespertino" || v === "tarde") return "vespertino";
  return null;
}
```

`StudentRow` ganha `shift: Shift | null`. Em `parseStudentsCsv`, crie `const classShift = new Map<string, Shift>();` junto dos outros mapas e, no laço, logo depois da validação do CPF:

```ts
    const rawShift = optional(record.turno);
    const shift = rawShift === null ? null : parseShift(rawShift);
    if (rawShift !== null && shift === null) {
      errors.push({ line, message: "turno inválido" });
      return;
    }
    if (shift !== null) {
      const seen = classShift.get(record.turma!);
      if (seen && seen !== shift) {
        errors.push({ line, message: "turma com turnos diferentes" });
        return;
      }
      classShift.set(record.turma!, shift);
    }
```

e `shift` entra no objeto `row`.

- [ ] **Step 5: Repo, service, route**

`registry/repo.ts`:

```ts
/** Turma por nome; `shift` null mantém o turno de uma turma existente (turma nova: matutino). */
export async function upsertClass(trx: Trx, schoolId: string, name: string, shift: Shift | null): Promise<string> {
  const set = shift ? { name, shift } : { name };
  const row = await trx
    .insertInto("classes")
    .values({ id: uuidv7(), schoolId, ...set })
    .onConflict((oc) => oc.columns(["schoolId", "name"]).doUpdateSet(set))
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function listClasses(trx: Trx) {
  return trx.selectFrom("classes").select(["id", "name", "shift"]).orderBy("name").execute();
}

export async function setClassShift(trx: Trx, classId: string, shift: Shift): Promise<"changed" | "same" | "missing"> {
  const row = await trx.selectFrom("classes").select("shift").where("id", "=", classId).forUpdate().executeTakeFirst();
  if (!row) return "missing";
  if (row.shift === shift) return "same";
  await trx.updateTable("classes").set({ shift }).where("id", "=", classId).execute();
  return "changed";
}
```

`registry/service.ts`: em `importStudents`, a turma é criada com o turno da **primeira linha que o informa** — antes do laço, monte `const shiftOf = new Map<string, Shift>(); for (const r of rows) if (r.shift && !shiftOf.has(r.className)) shiftOf.set(r.className, r.shift);` e use `repo.upsertClass(trx, schoolId, row.className, shiftOf.get(row.className) ?? null)`. `listClasses` devolve `shift` como `Shift` (cast `r.shift as Shift`). Nova função:

```ts
export async function setClassShift(session: SessionClaims, classId: string, body: SetClassShiftRequest): Promise<void> {
  await withTenant(session.schoolId, async (trx) => {
    const result = await repo.setClassShift(trx, classId, body.shift);
    if (result === "missing") throw new DomainError("not_found");
    if (result === "changed") {
      await audit(trx, { schoolId: session.schoolId, actorKind: "staff", actorId: session.sub, action: "class.shift_changed", detail: { class_id: classId, shift: body.shift } });
    }
  });
}
```

`registry/routes.ts`:

```ts
  // PUT naturalmente idempotente: repetir não muda nada (sem Idempotency-Key).
  app.put("/api/admin/v1/classes/:id/shift", { config: { auth: OFFICE } }, async (req, reply) => {
    await service.setClassShift(req.session!, IdParams.parse(req.params).id, SetClassShiftRequest.parse(req.body));
    return reply.status(204).send();
  });
```

Ajuste `import.test.ts` onde ele compara a lista de turmas (acrescente `shift: "matutino"` às turmas esperadas).

- [ ] **Step 6: Web**

`apps/web/src/ui/shifts.ts`:

```ts
import type { Shift } from "@app-lanche/contracts";

export const SHIFT_LABELS: Record<Shift, string> = { matutino: "Manhã", vespertino: "Tarde" };
```

`apps/web/src/areas/admin/ClassShifts.tsx`:

```tsx
import { SHIFTS, type ClassListResponse, type Shift } from "@app-lanche/contracts";
import { useState } from "react";
import { Card, CardBody, CardHeader, Input, Table } from "reactstrap";
import { z } from "zod";
import { apiFetch } from "../../app/api";
import { announce } from "../../theme/notify";
import { SHIFT_LABELS } from "../../ui/shifts";

type Props = { classes: ClassListResponse["classes"]; onChanged: () => Promise<void>; onError: (err: unknown) => void };

/** Turno de cada turma (spec F5C, B.1). Mudar não move pedidos já feitos. */
export function ClassShifts({ classes, onChanged, onError }: Props) {
  const [busy, setBusy] = useState<string | null>(null);

  async function change(id: string, name: string, shift: Shift) {
    setBusy(id);
    try {
      await apiFetch(`/api/admin/v1/classes/${id}/shift`, z.undefined(), { method: "PUT", body: { shift } });
      announce(`${name}: turno da ${SHIFT_LABELS[shift].toLowerCase()}.`);
      await onChanged();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(null);
    }
  }

  if (classes.length === 0) return null;
  return (
    <Card tag="section" className="main-card mb-3">
      <CardHeader tag="h2" className="h6 mb-0">
        Turmas e turnos
      </CardHeader>
      <CardBody>
        <Table responsive hover striped className="mb-0">
          <thead>
            <tr>
              <th>Turma</th>
              <th>Turno</th>
            </tr>
          </thead>
          <tbody>
            {classes.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td>
                  <Input
                    type="select"
                    aria-label={`Turno de ${c.name}`}
                    value={c.shift}
                    disabled={busy === c.id}
                    onChange={(e) => void change(c.id, c.name, e.target.value as Shift)}
                  >
                    {SHIFTS.map((s) => (
                      <option key={s} value={s}>
                        {SHIFT_LABELS[s]}
                      </option>
                    ))}
                  </Input>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </CardBody>
    </Card>
  );
}
```

Em `StudentsAdmin.tsx`, renderize `<ClassShifts classes={classes} onChanged={reload} onError={fail} />` logo abaixo do cartão da lista de alunos, usando o estado de turmas e a função de recarga que a página já tem (a mesma que busca `GET /api/admin/v1/classes`; se a recarga de turmas estiver junto com a de alunos, passe essa) e o tratador de erro da página (`useStaffErrors`).

`db/seed-dev.ts`: a turma `Infantil 4B` passa a `{ id: id(0xc2), name: "Infantil 4B", shift: "vespertino" }` e o insert de `classes` grava `shift` (`INSERT INTO classes (id, school_id, name, shift) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`; `Infantil 3A` com `"matutino"`).

Spec (regra 23): em B.1, no item "O CSV de importação ganha a coluna opcional `turno`", acrescente: "Aceita `matutino`/`manhã` e `vespertino`/`tarde` (sem diferença de maiúsculas e acentos); vazio mantém o turno da turma (turma nova: matutino); a mesma turma com turnos diferentes no arquivo é erro de linha."

- [ ] **Step 7: Run tests and checks**

Run: `pnpm --filter @app-lanche/api exec vitest run src/modules/registry && pnpm --filter @app-lanche/web exec vitest run src/areas/admin && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/contracts/src/registry.ts apps/api/src/modules/registry apps/web/src/ui/shifts.ts \
  apps/web/src/areas/admin/ClassShifts.tsx apps/web/src/areas/admin/StudentsAdmin.tsx apps/web/src/areas/admin/studentsAdmin.test.tsx \
  db/seed-dev.ts docs/superpowers/specs/2026-11-20-admin-turnos-avisos-design.md
git commit -m "feat(registry): class shift in CSV import, admin route and classes card"
```

---

### Task 3: Abrir o dia com um corte por turno

**Files:**
- Modify: `packages/contracts/src/catalog.ts` (+ `packages/contracts/src/catalog.test.ts`, novo)
- Modify: `apps/api/src/modules/catalog/repo.ts`, `service.ts`; Test: `apps/api/src/modules/catalog/catalog.test.ts`
- Modify: `apps/web/src/areas/admin/ServiceDaysAdmin.tsx` (formulário), `catalogAdmin.test.tsx`
- Modify (fixtures com o contrato novo): `apps/web/src/areas/guardian/order.test.tsx` (`DAYS`)
- Modify: `docs/superpowers/specs/2026-11-20-admin-turnos-avisos-design.md` (exemplo de B.2)

**Interfaces:**
- Consumes: `Shift`, `ShiftStatus`, `CutoffTime` (Task 1); `ClassListResponse` com `shift` (Task 2); `SHIFT_LABELS` (Task 2).
- Produces (contracts): `ServiceDayShift = { shift, cutoffAt, freezeAt, status: ShiftStatus }`; `ServiceDay.shifts: ServiceDayShift[]` (≥ 1, matutino primeiro); `UpsertServiceDayRequest = { cutoffTimes: { matutino?: "HH:MM"; vespertino?: "HH:MM" } (padrão {}), items }` (sai `cutoffTime`); `GuardianShift = { shift, cutoffAt, acceptingOrders }`; `GuardianServiceDay.shifts: GuardianShift[]` (≥ 1). `cutoffAt`/`freezeAt` do dia continuam (turno mais tarde).
- Produces (`catalog/service.ts`, usado por orders, payments, serviceDays, kds, uncollected, reminders):
  ```ts
  export type LockedShift = {
    id: string; serviceDayId: string; shift: Shift; cutoffAt: Date; freezeAt: Date;
    status: ShiftStatus; closedAt: Date | null; beforeCutoff: boolean; frozen: boolean;
  };
  export async function lockShift(trx: Trx, serviceDayId: string, shift: Shift, mode: "share" | "update"): Promise<LockedShift | undefined>;
  export async function listShifts(trx: Trx, serviceDayId: string): Promise<LockedShift[]>; // sem trava, matutino primeiro
  ```
  (`beforeCutoff = now() <= cutoff_at`, `frozen = now() >= freeze_at`, ambos pelo banco.)

- [ ] **Step 1: Write the failing tests**

`packages/contracts/src/catalog.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { GuardianServiceDay, ServiceDay, UpsertServiceDayRequest } from "./catalog";

const ITEM = { menuItemId: "0193a3b0-0000-7000-8000-000000000001", name: "Misto quente", priceCents: 900 };

describe("catalog contracts", () => {
  it("accepts a cutoff per shift and defaults to none", () => {
    expect(UpsertServiceDayRequest.parse({ items: [{ menuItemId: ITEM.menuItemId }] }).cutoffTimes).toEqual({});
    expect(UpsertServiceDayRequest.parse({ cutoffTimes: { vespertino: "13:30" }, items: [{ menuItemId: ITEM.menuItemId }] }).cutoffTimes).toEqual({ vespertino: "13:30" });
    expect(() => UpsertServiceDayRequest.parse({ cutoffTimes: { noite: "19:00" }, items: [{ menuItemId: ITEM.menuItemId }] })).toThrow();
    expect(() => UpsertServiceDayRequest.parse({ cutoffTimes: { matutino: "7:30" }, items: [{ menuItemId: ITEM.menuItemId }] })).toThrow();
  });

  it("accepts the spec B.2 example of a day with two shifts", () => {
    const example = {
      serviceDate: "2026-11-23",
      cutoffAt: "2026-11-23T16:00:00.000Z",
      freezeAt: "2026-11-23T16:05:00.000Z",
      status: "open",
      shifts: [
        { shift: "matutino", cutoffAt: "2026-11-23T10:30:00.000Z", freezeAt: "2026-11-23T10:35:00.000Z", status: "closed" },
        { shift: "vespertino", cutoffAt: "2026-11-23T16:00:00.000Z", freezeAt: "2026-11-23T16:05:00.000Z", status: "open" },
      ],
      items: [ITEM],
    };
    expect(ServiceDay.parse(example)).toEqual(example);
    expect(() => ServiceDay.parse({ ...example, shifts: [] })).toThrow();
    const guardian = {
      serviceDate: example.serviceDate,
      cutoffAt: example.cutoffAt,
      items: [ITEM],
      shifts: [{ shift: "vespertino", cutoffAt: "2026-11-23T16:00:00.000Z", acceptingOrders: true }],
    };
    expect(GuardianServiceDay.parse(guardian)).toEqual(guardian);
  });
});
```

`apps/api/src/modules/catalog/catalog.test.ts` — no `describe` de dias de serviço, substitua o teste "computes the cutoff in the school's timezone" por:

```ts
  it("computes one cutoff per shift that has classes, in the school's timezone", async () => {
    const { schoolId, cookies, misto, suco } = await setup();
    // Sem turma com aluno: só o matutino, no horário padrão da escola (07:30 em São Paulo = 10:30Z).
    const res = await put(cookies, "2030-03-04", { items: [{ menuItemId: misto }, { menuItemId: suco, priceCents: 400 }] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      serviceDate: "2030-03-04",
      cutoffAt: "2030-03-04T10:30:00.000Z",
      freezeAt: "2030-03-04T10:35:00.000Z",
      status: "open",
      shifts: [{ shift: "matutino", cutoffAt: "2030-03-04T10:30:00.000Z", freezeAt: "2030-03-04T10:35:00.000Z", status: "open" }],
      items: [
        { menuItemId: misto, name: "Misto quente", priceCents: 900 },
        { menuItemId: suco, name: "Suco", priceCents: 400 },
      ],
    });
    // Turmas nos dois turnos: o vespertino usa o padrão 13:00 (16:00Z) e o dia espelha o turno mais tarde.
    await seedFamily(schoolId, ["Léo"], { className: "Infantil 3A", shift: "matutino" });
    await seedFamily(schoolId, ["Bia"], { className: "Infantil 5C", shift: "vespertino" });
    const both = await put(cookies, "2030-03-05", { cutoffTimes: { matutino: "09:00" }, items: [{ menuItemId: misto }] });
    expect(both.json()).toMatchObject({
      cutoffAt: "2030-03-05T16:00:00.000Z",
      freezeAt: "2030-03-05T16:05:00.000Z",
      shifts: [
        { shift: "matutino", cutoffAt: "2030-03-05T12:00:00.000Z" },
        { shift: "vespertino", cutoffAt: "2030-03-05T16:00:00.000Z" },
      ],
    });
  });

  it("refuses a cutoff for a shift without classes and a shift whose cutoff already passed", async () => {
    const { schoolId, cookies, misto } = await setup();
    const noClasses = await put(cookies, "2030-03-04", { cutoffTimes: { vespertino: "13:30" }, items: [{ menuItemId: misto }] });
    expect(noClasses.statusCode).toBe(400);
    expect(noClasses.json().error.code).toBe("validation_failed");
    await seedFamily(schoolId, ["Bia"], { className: "Infantil 5C", shift: "vespertino" });
    // Data de hoje com o corte do vespertino às 00:00: já passou.
    const { rows } = await sql<{ d: string }>`SELECT (now() AT TIME ZONE timezone)::date::text AS d FROM schools WHERE id = ${schoolId}`.execute(adminDb());
    const past = await put(cookies, rows[0]!.d, { cutoffTimes: { vespertino: "00:00" }, items: [{ menuItemId: misto }] });
    expect(past.statusCode).toBe(409);
    expect(past.json().error.code).toBe("cutoff_passed");
  });

  it("shows guardians each shift and whether it still takes orders", async () => {
    const schoolId = await createSchool();
    const family = await seedFamily(schoolId);
    const cookies = await guardianCookie(schoolId, family.guardianId);
    const day = await seedServiceDay(schoolId, { serviceDate: "2030-03-04", shifts: { matutino: -1, vespertino: 120 } });
    const list = await buildApp().inject({ method: "GET", url: "/api/v1/service-days", cookies });
    expect(list.json().serviceDays[0].shifts).toEqual([
      { shift: "matutino", cutoffAt: expect.any(String), acceptingOrders: false },
      { shift: "vespertino", cutoffAt: expect.any(String), acceptingOrders: true },
    ]);
    const menu = await buildApp().inject({ method: "GET", url: `/api/v1/service-days/${day.serviceDate}/menu`, cookies });
    expect(menu.json()).toMatchObject({ acceptingOrders: true, shifts: [{ acceptingOrders: false }, { acceptingOrders: true }] });
  });
```

No teste "locks a day once it has a checkout" o insert do checkout já leva `shift: "matutino"` (Task 1).

Web — em `catalogAdmin.test.tsx`: `OPEN_DAY` ganha `shifts: [{ shift: "matutino", cutoffAt: "2030-03-04T10:30:00.000Z", freezeAt: "2030-03-04T11:00:00.000Z", status: "open" }]`; `BASE` ganha `"GET /api/admin/v1/classes": { status: 200, body: { classes: [{ id: "0193a000-0000-7000-8000-0000000000c1", name: "Infantil 3A", shift: "matutino" }, { id: "0193a000-0000-7000-8000-0000000000c2", name: "Infantil 5C", shift: "vespertino" }] } }`. Acrescente:

```tsx
  it("asks one optional cutoff per shift that has classes and sends only the filled ones", async () => {
    const fn = mockApi({
      ...BASE,
      "GET /api/admin/v1/me": me("secretaria"),
      "PUT /api/admin/v1/service-days/2030-03-04": { status: 200, body: OPEN_DAY },
    });
    renderAdmin("/admin/lanche/dias");
    fireEvent.change(await screen.findByLabelText("Data"), { target: { value: "2030-03-04" } });
    expect(screen.getByLabelText("Corte — Manhã (opcional)")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Corte — Tarde (opcional)"), { target: { value: "13:30" } });
    fireEvent.click(screen.getByLabelText("Pão"));
    fireEvent.click(screen.getByRole("button", { name: "Salvar dia" }));
    await waitFor(() => expect(callOf(fn, "PUT /api/admin/v1/service-days/2030-03-04")).toBeDefined());
    expect(callOf(fn, "PUT /api/admin/v1/service-days/2030-03-04")!.body).toEqual({ cutoffTimes: { vespertino: "13:30" }, items: [{ menuItemId: ID_PAO }] });
  });
```

(Use os mesmos seletores do teste "opens a day with the chosen items…" já existente para a data e os itens, se forem outros.)

Em `apps/web/src/areas/guardian/order.test.tsx`, `DAYS.serviceDays[0]` ganha `shifts: [{ shift: "matutino", cutoffAt: CUTOFF, acceptingOrders: true }]`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @app-lanche/contracts test; pnpm --filter @app-lanche/api exec vitest run src/modules/catalog; pnpm --filter @app-lanche/web exec vitest run src/areas/admin/catalogAdmin.test.tsx`
Expected: FAIL (`shifts` ausente; `cutoffTimes` desconhecido; rótulos não encontrados).

- [ ] **Step 3: Contracts** — em `packages/contracts/src/catalog.ts`:

```ts
import { CutoffTime, Shift, ShiftStatus } from "./shifts";

export const UpsertServiceDayRequest = z.object({
  /** Corte de cada turno com turmas; ausente usa o padrão da escola (schools.cutoff_time_<turno>). */
  cutoffTimes: z.object({ matutino: CutoffTime.optional(), vespertino: CutoffTime.optional() }).strict().default({}),
  items: z
    .array(z.object({ menuItemId: Uuid, priceCents: Cents.optional() }))
    .min(1)
    .max(30)
    .refine((items) => new Set(items.map((i) => i.menuItemId)).size === items.length, "duplicate item"),
});

export const ServiceDayShift = z.object({ shift: Shift, cutoffAt: IsoDateTime, freezeAt: IsoDateTime, status: ShiftStatus });
export type ServiceDayShift = z.infer<typeof ServiceDayShift>;

/** `cutoffAt`/`freezeAt` do dia = os do turno mais tarde (o link de pedido vale até lá). */
export const ServiceDay = z.object({
  serviceDate: IsoDate,
  cutoffAt: IsoDateTime,
  freezeAt: IsoDateTime,
  status: ServiceDayStatus,
  shifts: z.array(ServiceDayShift).min(1),
  items: z.array(DayItem),
});

export const GuardianShift = z.object({ shift: Shift, cutoffAt: IsoDateTime, acceptingOrders: z.boolean() });
export type GuardianShift = z.infer<typeof GuardianShift>;

export const GuardianServiceDay = z.object({
  serviceDate: IsoDate,
  cutoffAt: IsoDateTime,
  items: z.array(DayItem),
  shifts: z.array(GuardianShift).min(1),
});
```

(`GuardianMenuResponse` continua `GuardianServiceDay.extend({ acceptingOrders })`; os tipos inferidos mantêm os nomes.)

- [ ] **Step 4: Repo** — em `apps/api/src/modules/catalog/repo.ts` (substitui o `upsertServiceDay` da Task 1):

```ts
function shiftQuery(trx: Trx) {
  return trx
    .selectFrom("serviceDayShifts")
    .select([
      "id",
      "serviceDayId",
      "shift",
      "cutoffAt",
      "freezeAt",
      "status",
      "closedAt",
      sql<boolean>`now() <= cutoff_at`.as("beforeCutoff"),
      sql<boolean>`now() >= freeze_at`.as("frozen"),
    ]);
}

export async function lockShift(trx: Trx, serviceDayId: string, shift: Shift, mode: "share" | "update") {
  const q = shiftQuery(trx).where("serviceDayId", "=", serviceDayId).where("shift", "=", shift);
  return (mode === "share" ? q.forShare() : q.forUpdate()).executeTakeFirst();
}

export async function listShifts(trx: Trx, serviceDayIds: string[]) {
  if (serviceDayIds.length === 0) return [];
  return shiftQuery(trx).where("serviceDayId", "in", serviceDayIds).orderBy("serviceDayId").orderBy("shift").execute();
}

/** Turnos com ao menos uma turma com aluno ativo; matutino se nenhum. */
export async function activeShifts(trx: Trx): Promise<Shift[]> {
  const rows = await trx
    .selectFrom("classes")
    .innerJoin("students", "students.classId", "classes.id")
    .select("classes.shift")
    .where("students.active", "=", true)
    .distinct()
    .orderBy("classes.shift")
    .execute();
  return rows.length > 0 ? rows.map((r) => r.shift as Shift) : ["matutino"];
}

/** Corte de cada turno na data, no fuso da escola, pelo banco; `time` null usa o padrão da escola. */
export async function computeCutoffs(trx: Trx, serviceDate: string, cutoffs: { shift: Shift; time: string | null }[]) {
  const { rows } = await sql<{ shift: Shift; cutoffAt: Date; inFuture: boolean }>`
    SELECT c.shift, c.cutoff_at, now() < c.cutoff_at AS in_future
    FROM (
      SELECT x.shift,
        ((${serviceDate}::date + coalesce(x.time, CASE x.shift WHEN 'vespertino' THEN s.cutoff_time_vespertino ELSE s.cutoff_time_matutino END))
          AT TIME ZONE s.timezone) AS cutoff_at
      FROM schools s
      CROSS JOIN unnest(${cutoffs.map((c) => c.shift)}::text[], ${cutoffs.map((c) => c.time)}::time[]) AS x(shift, time)
      WHERE s.id = app_school_id()
    ) c
    ORDER BY c.shift`.execute(trx);
  return rows;
}

/** Cria ou atualiza o dia e seus turnos; o dia espelha o turno mais tarde. Linhas de turno nunca são apagadas. */
export async function upsertServiceDay(trx: Trx, schoolId: string, serviceDate: string, cutoffs: { shift: Shift; cutoffAt: Date }[]): Promise<string> {
  const latest = new Date(Math.max(...cutoffs.map((c) => c.cutoffAt.getTime())));
  const { rows } = await sql<{ id: string }>`
    INSERT INTO service_days (id, school_id, service_date, cutoff_at, freeze_at)
    VALUES (${uuidv7()}, ${schoolId}, ${serviceDate}::date, ${latest}, ${latest}::timestamptz + interval '5 minutes')
    ON CONFLICT (school_id, service_date) DO UPDATE SET cutoff_at = EXCLUDED.cutoff_at, freeze_at = EXCLUDED.freeze_at
    RETURNING id`.execute(trx);
  const dayId = rows[0]!.id;
  for (const c of cutoffs) {
    await sql`
      INSERT INTO service_day_shifts (id, school_id, service_day_id, shift, cutoff_at, freeze_at)
      VALUES (${uuidv7()}, ${schoolId}, ${dayId}, ${c.shift}, ${c.cutoffAt}, ${c.cutoffAt}::timestamptz + interval '5 minutes')
      ON CONFLICT (school_id, service_day_id, shift) DO UPDATE SET cutoff_at = EXCLUDED.cutoff_at, freeze_at = EXCLUDED.freeze_at`.execute(trx);
  }
  await sql`
    UPDATE service_days d SET cutoff_at = m.cutoff_at, freeze_at = m.freeze_at
    FROM (SELECT max(cutoff_at) AS cutoff_at, max(freeze_at) AS freeze_at FROM service_day_shifts WHERE service_day_id = ${dayId}) m
    WHERE d.id = ${dayId}`.execute(trx);
  return dayId;
}
```

(Importe `type Shift` de `@app-lanche/contracts`.)

- [ ] **Step 5: Service** — em `apps/api/src/modules/catalog/service.ts`:

```ts
export type LockedShift = {
  id: string;
  serviceDayId: string;
  shift: Shift;
  cutoffAt: Date;
  freezeAt: Date;
  status: ShiftStatus;
  closedAt: Date | null;
  beforeCutoff: boolean;
  frozen: boolean;
};

function asShift(row: NonNullable<Awaited<ReturnType<typeof repo.lockShift>>>): LockedShift {
  return { ...row, shift: row.shift as Shift, status: row.status as ShiftStatus };
}

export async function lockShift(trx: Trx, serviceDayId: string, shift: Shift, mode: "share" | "update"): Promise<LockedShift | undefined> {
  const row = await repo.lockShift(trx, serviceDayId, shift, mode);
  return row && asShift(row);
}

export async function listShifts(trx: Trx, serviceDayId: string): Promise<LockedShift[]> {
  return (await repo.listShifts(trx, [serviceDayId])).map(asShift);
}

async function shiftsByDay(trx: Trx, ids: string[]): Promise<Map<string, LockedShift[]>> {
  const map = new Map<string, LockedShift[]>(ids.map((id) => [id, []]));
  for (const r of await repo.listShifts(trx, ids)) map.get(r.serviceDayId)!.push(asShift(r));
  return map;
}

const shiftView = (s: LockedShift) => ({ shift: s.shift, cutoffAt: s.cutoffAt.toISOString(), freezeAt: s.freezeAt.toISOString(), status: s.status });
const guardianShift = (s: LockedShift) => ({ shift: s.shift, cutoffAt: s.cutoffAt.toISOString(), acceptingOrders: s.status === "open" && s.beforeCutoff });
```

- `serviceDayView` e `listServiceDays` acrescentam `shifts: (await shiftsByDay(trx, ids)).get(day.id)!.map(shiftView)`.
- `listOpenDaysForGuardian` acrescenta `shifts: …map(guardianShift)`; `guardianMenu` acrescenta `shifts` e passa a `acceptingOrders: day.status === "open" && shifts.some((s) => s.acceptingOrders)`.
- `upsertServiceDay` (depois da trava do dia e do `service_day_locked`, que não mudam):

```ts
    const shifts = await repo.activeShifts(trx);
    const asked = Object.keys(body.cutoffTimes) as Shift[];
    if (asked.some((s) => !shifts.includes(s))) throw new DomainError("validation_failed", "cutoff for a shift without classes");
    const cutoffs = await repo.computeCutoffs(trx, serviceDate, shifts.map((shift) => ({ shift, time: body.cutoffTimes[shift] ?? null })));
    if (cutoffs.some((c) => !c.inFuture)) throw new DomainError("cutoff_passed");
    const dayId = await repo.upsertServiceDay(trx, schoolId, serviceDate, cutoffs);
    // … itens como hoje, com dayId no lugar de day.id …
```

- [ ] **Step 6: Admin form** — em `ServiceDaysAdmin.tsx`:
  - busque também `apiFetch("/api/admin/v1/classes", ClassListResponse)` no `useEffect` inicial e guarde `formShifts: Shift[] = SHIFTS.filter((s) => classes.some((c) => c.shift === s))`, ou `["matutino"]` sem turma;
  - troque o estado `cutoff` por `cutoffs: Partial<Record<Shift, string>>`;
  - troque o campo único por um campo por turno de `formShifts`:

```tsx
            {formShifts.map((s) => (
              <Col md={4} key={s}>
                <FormGroup>
                  <Label for={`day-cutoff-${s}`}>{`Corte — ${SHIFT_LABELS[s]} (opcional)`}</Label>
                  <Input
                    id={`day-cutoff-${s}`}
                    type="time"
                    value={cutoffs[s] ?? ""}
                    onChange={(e) => setCutoffs((prev) => ({ ...prev, [s]: e.target.value }))}
                  />
                </FormGroup>
              </Col>
            ))}
```

  - o corpo do `PUT` passa a ser:

```ts
      const filled = Object.fromEntries(Object.entries(cutoffs).filter(([, v]) => v));
      await apiFetch(`/api/admin/v1/service-days/${date}`, ServiceDaySchema, {
        method: "PUT",
        body: { ...(Object.keys(filled).length > 0 ? { cutoffTimes: filled } : {}), items: [...selected].map((menuItemId) => ({ menuItemId })) },
      });
```

- [ ] **Step 7: Spec example (regra 23).** Em B.2, ao fim, acrescente o exemplo do teste de contrato:

````markdown
Exemplo de `GET /api/admin/v1/service-days` (um dia; `cutoffAt`/`freezeAt` do dia = turno mais tarde):

```json
{ "serviceDate": "2026-11-23", "cutoffAt": "2026-11-23T16:00:00.000Z", "freezeAt": "2026-11-23T16:05:00.000Z", "status": "open",
  "shifts": [
    { "shift": "matutino", "cutoffAt": "2026-11-23T10:30:00.000Z", "freezeAt": "2026-11-23T10:35:00.000Z", "status": "closed" },
    { "shift": "vespertino", "cutoffAt": "2026-11-23T16:00:00.000Z", "freezeAt": "2026-11-23T16:05:00.000Z", "status": "open" } ],
  "items": [{ "menuItemId": "0193…", "name": "Misto quente", "priceCents": 900 }] }
```

`PUT /api/admin/v1/service-days/{date}` recebe `{ "cutoffTimes": { "vespertino": "13:30" }, "items": [...] }`; turno sem horário usa o padrão da escola.
````

- [ ] **Step 8: Run tests and checks**

Run: `pnpm --filter @app-lanche/contracts test && pnpm --filter @app-lanche/api exec vitest run src/modules/catalog src/modules/auth && pnpm --filter @app-lanche/web exec vitest run src/areas && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/contracts/src/catalog.ts packages/contracts/src/catalog.test.ts apps/api/src/modules/catalog \
  apps/web/src/areas/admin/ServiceDaysAdmin.tsx apps/web/src/areas/admin/catalogAdmin.test.tsx apps/web/src/areas/guardian/order.test.tsx \
  docs/superpowers/specs/2026-11-20-admin-turnos-avisos-design.md
git commit -m "feat(catalog): open service days with one cutoff per shift"
```

---

### Task 4: Pedido, cancelamento e pagamento por turno

**Files:**
- Modify: `packages/contracts/src/{auth.ts,checkout.ts,errors.ts}` (+ `errors.test.ts` se listar códigos)
- Modify: `apps/api/src/platform/errors.ts` (`shift_not_offered: 409`)
- Modify: `apps/api/src/modules/auth/repo.ts:191` (aluno com `classes.shift`), `auth/service.ts` (`me`)
- Modify: `apps/api/src/modules/orders/{repo,service}.ts`, `apps/api/src/modules/payments/{repo,service}.ts`
- Test: `apps/api/src/modules/orders/checkout.test.ts`, `orders/cancel.test.ts`, `payments/confirm.test.ts`, `auth/guardianAuth.test.ts`, `auth/magicLink.test.ts`; helper `seedTwoShiftFamily` em `apps/api/test/helpers.ts`
- Modify: `apps/web/src/ui/messages.ts`; fixtures em `apps/web/src/areas/guardian/*.test.tsx`

**Interfaces:**
- Consumes: `catalog.lockShift`, `LockedShift` (Task 3); helpers `seedServiceDay({ shifts })`, `seedFamily(…, { shift, className })`, `moveCutoff` (Task 1).
- Produces (contracts): `MeResponse.students[].shift: Shift`; `CheckoutView.shift: Shift` (e `CheckoutView.cutoffAt` passa a ser o corte do turno); `OrderStatus` com `"not_collected"`; erro `shift_not_offered` (409).
- Produces (API): `orders.repo.guardianActiveStudents` devolve `shift`; `payments.repo.paymentTarget` devolve `shift` do checkout; `orders.repo.checkoutHeaders` devolve `shift` e o `cutoffAt` do turno.

- [ ] **Step 1: Write the failing tests**

Em `apps/api/test/helpers.ts`, acrescente (usado aqui e nas Tasks 5–10):

```ts
/** Responsável com Léo na turma da manhã ("Infantil 3A") e Bia na da tarde ("Infantil 5C"). */
export async function seedTwoShiftFamily(schoolId: string): Promise<{ guardianId: string; leo: string; bia: string }> {
  const fam = await seedFamily(schoolId, ["Léo"], { className: "Infantil 3A", shift: "matutino" });
  const other = await seedFamily(schoolId, ["Bia"], { className: "Infantil 5C", shift: "vespertino" });
  await adminDb().insertInto("guardianStudents").values({ schoolId, guardianId: fam.guardianId, studentId: other.studentIds[0]!, financial: false }).execute();
  return { guardianId: fam.guardianId, leo: fam.studentIds[0]!, bia: other.studentIds[0]! };
}
```

`apps/api/src/modules/orders/checkout.test.ts` (acrescente; importe `moveCutoff`, `seedServiceDay`, `seedTwoShiftFamily`, `adminDb`; `const twoShiftFamily = seedTwoShiftFamily;`):

```ts
const post = async (schoolId: string, guardianId: string, serviceDate: string, orders: { studentId: string; items: { menuItemId: string; qty: number }[] }[]) =>
  buildApp().inject({
    method: "POST",
    url: "/api/v1/checkouts",
    cookies: await guardianCookie(schoolId, guardianId),
    headers: { "idempotency-key": uuidv7() },
    payload: { serviceDate, orders },
  });

describe("checkout per shift", () => {
  it("places one checkout per shift, with that shift's cutoff, and refuses mixing shifts", async () => {
    const schoolId = await createSchool();
    const day = await seedServiceDay(schoolId, { shifts: { matutino: 60, vespertino: 300 } });
    const f = await twoShiftFamily(schoolId);
    const item = [{ menuItemId: day.items[0]!.id, qty: 1 }];
    const mixed = await post(schoolId, f.guardianId, day.serviceDate, [{ studentId: f.leo, items: item }, { studentId: f.bia, items: item }]);
    expect(mixed.statusCode).toBe(422);
    expect(mixed.json().error.code).toBe("invalid_order");
    const morning = await post(schoolId, f.guardianId, day.serviceDate, [{ studentId: f.leo, items: item }]);
    const afternoon = await post(schoolId, f.guardianId, day.serviceDate, [{ studentId: f.bia, items: item }]);
    expect(morning.json().shift).toBe("matutino");
    expect(afternoon.json().shift).toBe("vespertino");
    const shifts = await adminDb().selectFrom("serviceDayShifts").select(["shift", "cutoffAt"]).where("serviceDayId", "=", day.serviceDayId).execute();
    const cutoff = Object.fromEntries(shifts.map((s) => [s.shift, s.cutoffAt.toISOString()]));
    expect(morning.json().cutoffAt).toBe(cutoff.matutino);
    expect(afternoon.json().cutoffAt).toBe(cutoff.vespertino);
    const pix = await adminDb().selectFrom("payments").select("expiresAt").where("checkoutId", "=", afternoon.json().id).executeTakeFirstOrThrow();
    expect(pix.expiresAt.toISOString()).toBe(cutoff.vespertino);
  });

  it("closes orders for a shift past its cutoff while the other shift still takes them", async () => {
    const schoolId = await createSchool();
    const day = await seedServiceDay(schoolId, { shifts: { matutino: 60, vespertino: 300 } });
    const f = await twoShiftFamily(schoolId);
    await moveCutoff(day.serviceDayId, -1, "matutino");
    const item = [{ menuItemId: day.items[0]!.id, qty: 1 }];
    const late = await post(schoolId, f.guardianId, day.serviceDate, [{ studentId: f.leo, items: item }]);
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe("cutoff_passed");
    expect((await post(schoolId, f.guardianId, day.serviceDate, [{ studentId: f.bia, items: item }])).statusCode).toBe(200);
  });

  it("refuses a shift the day does not offer", async () => {
    const schoolId = await createSchool();
    const day = await seedServiceDay(schoolId); // só matutino
    const f = await twoShiftFamily(schoolId);
    const res = await post(schoolId, f.guardianId, day.serviceDate, [{ studentId: f.bia, items: [{ menuItemId: day.items[0]!.id, qty: 1 }] }]);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("shift_not_offered");
  });
});
```

`apps/api/src/modules/orders/cancel.test.ts` (acrescente; importe `moveCutoff`, `seedServiceDay`, `seedTwoShiftFamily`):

```ts
  it("lets a guardian cancel an afternoon order after the morning cutoff", async () => {
    const schoolId = await createSchool();
    const day = await seedServiceDay(schoolId, { shifts: { matutino: 60, vespertino: 300 } });
    const f = await seedTwoShiftFamily(schoolId);
    const created = await buildApp().inject({
      method: "POST",
      url: "/api/v1/checkouts",
      cookies: await guardianCookie(schoolId, f.guardianId),
      headers: { "idempotency-key": uuidv7() },
      payload: { serviceDate: day.serviceDate, orders: [{ studentId: f.bia, items: [{ menuItemId: day.items[0]!.id, qty: 1 }] }] },
    });
    await moveCutoff(day.serviceDayId, -1, "matutino");
    const res = await buildApp().inject({ method: "POST", url: `/api/v1/checkouts/${created.json().id}/cancel`, cookies: await guardianCookie(schoolId, f.guardianId) });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("expired");
  });
```

`apps/api/src/modules/payments/confirm.test.ts` (acrescente):

```ts
  it("credits a payment made after its own shift's cutoff even while the day's later shift is open", async () => {
    const schoolId = await createSchool();
    const day = await seedServiceDay(schoolId, { shifts: { matutino: 60, vespertino: 300 } });
    const fam = await seedFamily(schoolId, ["Léo"], { shift: "matutino" });
    const res = await buildApp().inject({
      method: "POST",
      url: "/api/v1/checkouts",
      cookies: await guardianCookie(schoolId, fam.guardianId),
      headers: { "idempotency-key": uuidv7() },
      payload: { serviceDate: day.serviceDate, orders: [{ studentId: fam.studentIds[0]!, items: [{ menuItemId: day.items[0]!.id, qty: 1 }] }] },
    });
    const checkoutId = res.json().id as string;
    const payment = await adminDb().selectFrom("payments").select("id").where("checkoutId", "=", checkoutId).executeTakeFirstOrThrow();
    await moveCutoff(day.serviceDayId, -60, "matutino");
    const outcome = await withTenant(schoolId, (trx) => confirmPayment(trx, { schoolId, paymentId: payment.id, paidAt: new Date() }));
    expect(outcome).toBe("late_credited");
    const order = await adminDb().selectFrom("orders").select("status").where("checkoutId", "=", checkoutId).executeTakeFirstOrThrow();
    expect(order.status).toBe("expired_late");
    expect(await walletLedgerMatches(schoolId, fam.guardianId)).toBe(true);
  });
```

`apps/api/src/modules/auth/guardianAuth.test.ts:73`: a expectativa de `students` ganha `shift: "matutino"`.

`apps/api/src/modules/auth/magicLink.test.ts` (acrescente):

```ts
  it("keeps an order link valid until the latest shift's cutoff", async () => {
    const schoolId = await createSchool();
    const seed = await seedTenant(schoolId);
    const day = await seedServiceDay(schoolId, { serviceDate: "2031-05-05", shifts: { matutino: 30, vespertino: 300 } });
    const res = await buildApp().inject(
      internalRequest("POST", `/internal/v1/schools/${schoolId}/magic-links`, { guardian_id: seed.guardianId, scope: "order", service_date: day.serviceDate }),
    );
    const shift = await adminDb().selectFrom("serviceDayShifts").select("cutoffAt").where("id", "=", day.shiftIds.vespertino!).executeTakeFirstOrThrow();
    expect(new Date(res.json().expires_at).toISOString()).toBe(shift.cutoffAt.toISOString());
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @app-lanche/api exec vitest run src/modules/orders src/modules/payments src/modules/auth`
Expected: FAIL (checkout misturado aceito; `shift` ausente; `shift_not_offered` desconhecido; pagamento confirmado pelo corte do dia).

- [ ] **Step 3: Contracts and errors**

- `auth.ts`: `MeResponse.students` → `z.object({ id: z.string().uuid(), firstName: z.string(), className: z.string(), shift: Shift })`.
- `checkout.ts`: `OrderStatus` acrescenta `"not_collected"`; `CheckoutView` acrescenta `shift: Shift` logo depois de `serviceDate`, com o comentário `/** Corte do turno do checkout. */` em `cutoffAt`.
- `errors.ts`: acrescente `"shift_not_offered"` depois de `"service_day_open"`; `apps/api/src/platform/errors.ts`: `shift_not_offered: 409`.
- `apps/web/src/ui/messages.ts`: `MESSAGES.shift_not_offered = "Não há lanche para este turno neste dia."` e `STAFF_MESSAGES.shift_not_offered = "Este dia não tem lanche para esse turno."`.

- [ ] **Step 4: API**

`auth/repo.ts` (consulta dos alunos do `me`): `.select(["students.id", "students.firstName", "classes.name as className", "classes.shift"])`; o serviço faz `shift: s.shift as Shift`.

`orders/repo.ts`:
- `guardianActiveStudents`: `.innerJoin("classes", "classes.id", "students.classId")` e `.select(["students.id", "students.firstName", "classes.shift"])`.
- `checkoutHeaders`: troque o join de `serviceDays` por
  ```ts
    .innerJoin("serviceDays", "serviceDays.id", "checkouts.serviceDayId")
    .innerJoin("serviceDayShifts", (j) =>
      j.onRef("serviceDayShifts.serviceDayId", "=", "checkouts.serviceDayId").onRef("serviceDayShifts.shift", "=", "checkouts.shift"),
    )
  ```
  e selecione `"checkouts.shift"` e `"serviceDayShifts.cutoffAt"` (no lugar de `"serviceDays.cutoffAt"`).

`orders/service.ts` — `placeCheckout` (o resto da função não muda):

```ts
  const day = await catalog.lockServiceDayByDate(trx, body.serviceDate, "share");
  if (!day) throw new DomainError("not_found");

  const studentIds = body.orders.map((o) => o.studentId);
  if (new Set(studentIds).size !== studentIds.length) throw new DomainError("invalid_order");
  const students = await repo.guardianActiveStudents(trx, guardianId, studentIds);
  if (students.length !== studentIds.length) throw new DomainError("invalid_order");
  // Um checkout é de um turno (spec F5C, B.1): a PWA manda um por turno.
  const shifts = new Set(students.map((s) => s.shift as Shift));
  if (shifts.size !== 1) throw new DomainError("invalid_order");
  const shift = [...shifts][0]!;
  // Travas: service_days → service_day_shifts (FOR SHARE, regra 16) → … → wallets.
  const turn = await catalog.lockShift(trx, day.id, shift, "share");
  if (!turn) throw new DomainError("shift_not_offered");
  if (turn.status !== "open" || !turn.beforeCutoff) throw new DomainError("cutoff_passed");
```

`insertCheckout` recebe `shift` (no lugar do `"matutino"` da Task 1) e `createPendingPayment` recebe `expiresAt: turn.cutoffAt`.

`cancelCheckout`: depois de `const day = await catalog.lockServiceDayById(trx, first.serviceDayId, "share");`:

```ts
    const turn = (await catalog.lockShift(trx, first.serviceDayId, first.shift as Shift, "share"))!;
```

e a condição de corte passa a `if (turn.status !== "open" || !turn.beforeCutoff) throw new DomainError("cutoff_passed");` (a variável `day` pode sair se não for mais usada; a trava do dia continua, pela ordem de travas).

`views()` devolve `shift: h.shift as Shift` e `cutoffAt: h.cutoffAt.toISOString()` (agora o do turno).

Atualize o comentário de `lockCheckout` para a ordem nova: `service_days → service_day_shifts → checkouts → payments → wallets`.

`payments/repo.ts` — `paymentTarget` seleciona também `"checkouts.shift"`.

`payments/service.ts` — ramo de checkout do `confirmPayment`:

```ts
  const { checkoutId, serviceDayId, shift } = payment;
  if (checkoutId === null || serviceDayId === null || shift === null) throw new Error(`payment ${payment.id} has no target`);
  // Checkout: travas service_days → service_day_shifts → checkouts → payments → wallets (regra 16, por turno).
  await catalog.lockServiceDayById(trx, serviceDayId, "share");
  const turn = await catalog.lockShift(trx, serviceDayId, shift as Shift, "share");
  if (!turn) throw new Error(`shift ${shift} of service day ${serviceDayId} not found`);
  await orders.lockCheckout(trx, checkoutId);
  if (!(await repo.markPaid(trx, payment.id, input.paidAt))) return "already_processed";

  const onTime = turn.status === "open" && input.paidAt.getTime() <= turn.cutoffAt.getTime();
```

Atualize o comentário do `confirmPayment` com a ordem de travas da fase: `service_days → service_day_shifts → checkouts → topups → payments → guardian_students → counter_sales → wallets`.

- [ ] **Step 5: Web fixtures.** Nos testes da área do responsável (`order.test.tsx`, `wallet.test.tsx`, `LinkLanding.test.tsx`, `documents.test.tsx`), todo aluno de um `MeResponse` ganha `shift: "matutino"` e todo `CheckoutView` ganha `shift: "matutino"` (no `checkout()` de `order.test.tsx`, logo depois de `serviceDate`).

- [ ] **Step 6: Run tests and checks**

Run: `pnpm app:down; docker compose down; pnpm --filter @app-lanche/contracts test && pnpm test:api && pnpm --filter @app-lanche/web test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/auth.ts packages/contracts/src/checkout.ts packages/contracts/src/errors.ts apps/api/src/platform/errors.ts \
  apps/api/test/helpers.ts apps/api/src/modules/auth apps/api/src/modules/orders apps/api/src/modules/payments \
  apps/web/src/ui/messages.ts apps/web/src/areas/guardian
git commit -m "feat(orders): one checkout per shift with the shift's cutoff"
```

---

### Task 5: Tela do responsável com um pedido por turno

**Files:**
- Create: `apps/web/src/areas/guardian/ShiftOrder.tsx`
- Modify: `apps/web/src/areas/guardian/DayOrder.tsx`
- Test: `apps/web/src/areas/guardian/order.test.tsx`

**Interfaces:**
- Consumes: `GuardianServiceDay.shifts`, `MeResponse.students[].shift`, `CheckoutView.shift` (Tasks 3–4); `SHIFT_LABELS` (Task 2); `SHIFTS` (Task 1).
- Produces: `ShiftOrder({ serviceDate, items, shift, info, students, ordered, labelled })` — um cartão por turno com carrinho, corte e botão "Pagar" próprios; `DayOrder` agrupa os filhos por turno.

- [ ] **Step 1: Write the failing tests** — em `order.test.tsx`:

```tsx
const S3 = U(8);
const ME2 = {
  ...ME,
  students: [
    { id: S1, firstName: "Léo", className: "Maternal", shift: "matutino" },
    { id: S3, firstName: "Caio", className: "Jardim", shift: "vespertino" },
  ],
};
const AFTERNOON_CUTOFF = "2030-05-10T16:00:00.000Z";
const DAYS2 = {
  serviceDays: [
    {
      ...DAYS.serviceDays[0],
      cutoffAt: AFTERNOON_CUTOFF,
      shifts: [
        { shift: "matutino", cutoffAt: CUTOFF, acceptingOrders: true },
        { shift: "vespertino", cutoffAt: AFTERNOON_CUTOFF, acceptingOrders: true },
      ],
    },
  ],
};

describe("order per shift", () => {
  it("shows one card per shift, each with its own cutoff and payment", async () => {
    const fn = mockApi({
      "GET /api/v1/me": ok(ME2),
      "GET /api/v1/service-days": ok(DAYS2),
      [`GET /api/v1/checkouts?serviceDate=${DATE}`]: ok({ checkouts: [] }),
      "POST /api/v1/checkouts": ok(checkout("pending_payment", { shift: "vespertino" })),
    });
    renderAt("/pedido");
    expect(await screen.findByRole("heading", { name: "Manhã" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Tarde" })).toBeTruthy();
    expect(screen.getAllByText(/^Pedidos até/)).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Adicionar Misto quente para Caio" }));
    const pay = screen.getAllByRole("button", { name: /^Pagar/ });
    expect(pay).toHaveLength(2);
    expect((pay[0] as HTMLButtonElement).disabled).toBe(true); // manhã sem itens
    fireEvent.click(pay[1]!);
    await waitFor(() => expect(fn.mock.calls.some((c) => c[1]?.method === "POST")).toBe(true));
    const post = fn.mock.calls.find((c) => c[1]?.method === "POST")!;
    expect(JSON.parse(post[1]!.body as string)).toEqual({ serviceDate: DATE, orders: [{ studentId: S3, items: [{ menuItemId: MISTO, qty: 1 }] }] });
  });

  it("says when a shift no longer takes orders or has no snack that day", async () => {
    mockApi({
      "GET /api/v1/me": ok(ME2),
      "GET /api/v1/service-days": ok({
        serviceDays: [{ ...DAYS2.serviceDays[0], shifts: [{ shift: "matutino", cutoffAt: CUTOFF, acceptingOrders: false }] }],
      }),
      [`GET /api/v1/checkouts?serviceDate=${DATE}`]: ok({ checkouts: [] }),
    });
    renderAt("/pedido");
    expect(await screen.findByText(/^Pedidos encerrados às/)).toBeTruthy();
    expect(screen.getByText("Não há lanche para a turma de Caio neste dia.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Pagar/ })).toBeNull();
  });

  it("keeps a single untitled card when every child is in the same shift", async () => {
    mockApi({
      "GET /api/v1/me": ok(ME),
      "GET /api/v1/service-days": ok(DAYS),
      [`GET /api/v1/checkouts?serviceDate=${DATE}`]: ok({ checkouts: [] }),
    });
    renderAt("/pedido");
    await screen.findByText("Léo");
    expect(screen.queryByRole("heading", { name: "Manhã" })).toBeNull();
    expect(screen.getAllByRole("button", { name: /^Pagar/ })).toHaveLength(1);
  });
});
```

(`renderAt` é o helper de rota que o arquivo já usa para `OrderHome`; se tiver outro nome, use-o.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @app-lanche/web exec vitest run src/areas/guardian/order.test.tsx`
Expected: FAIL (um só botão "Pagar", sem títulos de turno).

- [ ] **Step 3: Implementation**

`apps/web/src/areas/guardian/ShiftOrder.tsx` — o corpo atual de `DayOrder` (carrinho, `change`, `pay`, lista de itens por aluno) vira este componente, com estas diferenças:

```tsx
import { CheckoutView, type DayItem, type GuardianShift, type MeResponse, type Shift } from "@app-lanche/contracts";
import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ApiError, apiFetch } from "../../app/api";
import { errorMessage } from "../../ui/messages";
import { formatCents } from "../../ui/money";
import { SHIFT_LABELS } from "../../ui/shifts";

type Cart = Record<string, Record<string, number>>; // studentId → menuItemId → qty
type Props = {
  serviceDate: string;
  items: DayItem[];
  shift: Shift;
  info: GuardianShift | undefined;
  students: MeResponse["students"];
  ordered: Map<string, string>; // studentId → checkoutId
  labelled: boolean;
};

const time = (iso: string) => new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

/** Pedido de um turno: o checkout é de um turno só (spec F5C, B.1). */
export function ShiftOrder({ serviceDate, items, shift, info, students, ordered, labelled }: Props) {
  // … estado cart/error/busy/keyRef, change(), orders, total e pay() iguais ao DayOrder atual, com
  //     body: { serviceDate, orders } …
  const names = students.map((s) => s.firstName).join(" e ");
  const open = info?.acceptingOrders === true;
  return (
    <section className="mb-3">
      {labelled && <h2 className="h5">{SHIFT_LABELS[shift]}</h2>}
      {!info ? (
        <p className="g-card g-muted">{`Não há lanche para a turma de ${names} neste dia.`}</p>
      ) : (
        <>
          <p className="g-muted">{open ? `Pedidos até ${time(info.cutoffAt)}` : `Pedidos encerrados às ${time(info.cutoffAt)}`}</p>
          {students.map((s) => (
            <article key={s.id} className="g-card">
              <h3 className="h6">{s.firstName}</h3>
              {/* "Pedido já feito · Ver pedido" quando ordered.has(s.id); senão, se `open`, a lista de itens com os
                  botões −/+ do DayOrder atual (mesmos aria-label); fechado e sem pedido: nada. */}
            </article>
          ))}
          {error && (
            <p role="alert" className="g-alert">
              {error}
            </p>
          )}
          {open && students.some((s) => !ordered.has(s.id)) && (
            <button type="button" className="btn btn-primary btn-lg w-100" disabled={total === 0 || busy} onClick={pay}>
              Pagar {formatCents(total)}
            </button>
          )}
        </>
      )}
    </section>
  );
}
```

O título de cada aluno passa de `h2` para `h3` (o `h2` agora é do turno). Copie o JSX da lista de itens e do "Pedido já feito" do `DayOrder` atual sem mudar texto nem `aria-label`.

`DayOrder.tsx` fica só com a busca dos checkouts do dia (o `useEffect` atual, que monta `ordered`) e o agrupamento:

```tsx
export function DayOrder({ day, me }: { day: GuardianServiceDay; me: MeResponse }) {
  const [ordered, setOrdered] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  // useEffect de /api/v1/checkouts?serviceDate=… igual ao atual
  const groups = SHIFTS.map((shift) => ({ shift, students: me.students.filter((s) => s.shift === shift) })).filter((g) => g.students.length > 0);
  return (
    <section>
      {groups.map((g) => (
        <ShiftOrder
          key={g.shift}
          serviceDate={day.serviceDate}
          items={day.items}
          shift={g.shift}
          info={day.shifts.find((s) => s.shift === g.shift)}
          students={g.students}
          ordered={ordered}
          labelled={groups.length > 1}
        />
      ))}
      {error && (
        <p role="alert" className="g-alert">
          {error}
        </p>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Run tests and checks**

Run: `pnpm --filter @app-lanche/web exec vitest run src/areas/guardian && pnpm typecheck && pnpm lint`
Expected: PASS (os testes antigos de `order.test.tsx` continuam passando: um turno só, sem título).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/areas/guardian/ShiftOrder.tsx apps/web/src/areas/guardian/DayOrder.tsx apps/web/src/areas/guardian/order.test.tsx
git commit -m "feat(guardian): one order card per shift"
```

---

### Task 6: Fechamento, romaneio e agenda por turno

**Files:**
- Create: `db/migrations/0013_shift_schedule.sql` (recria `list_due_actions()`); Regenerate: `apps/api/src/db/types.ts` (não deve mudar)
- Modify: `packages/contracts/src/{manifest.ts,events.ts,internal.ts}`, `manifest.test.ts`, `events.test.ts`
- Modify: `apps/api/src/modules/catalog/{repo,service}.ts` (`markShiftClosed`, `closeDayIfNoOpenShift`; sai `markServiceDayClosed`)
- Modify: `apps/api/src/modules/orders/{repo,service}.ts` (`expirePendingCheckouts`, `countLateCredited` e `checkoutIdsByStatus` por turno)
- Modify: `apps/api/src/modules/serviceDays/{repo,service,routes}.ts`, `apps/api/src/modules/internal/routes.ts`
- Test: `apps/api/src/modules/serviceDays/close.test.ts`, `apps/api/src/db/schema.test.ts`, `apps/api/src/modules/internal/schedule.test.ts`, `apps/api/test/n8n.test.ts`
- Modify: `n8n/code/events.js`, `n8n/code/schedule.js`; Regenerate: `n8n/workflows/*.json` (`pnpm n8n:build`); Modify: `docs/n8n.md`
- Modify: `apps/web/src/areas/admin/ServiceDaysAdmin.tsx` (situação por turno, "Fechar turno"), `catalogAdmin.test.tsx`
- Modify: `docs/superpowers/specs/2026-11-16-app-lanche-design.md` (6.2: exemplo do `close` e do `manifest`), `docs/superpowers/specs/2026-11-20-admin-turnos-avisos-design.md` (B.1: exemplo de `service_day.closed`)

**Interfaces:**
- Consumes: `catalog.lockShift`, `catalog.listShifts`, `LockedShift` (Task 3); `checkouts.shift` (Task 4); helpers `seedServiceDay({ shifts })`, `seedConfirmedOrders`, `moveCutoff` (Task 1).
- Produces (contracts):
  - `ManifestResponse = ManifestContent & { shift: Shift; status: "closed" | "finished"; closed_at; manifest_version; kitchen_phone }`;
  - `ServiceDayCloseResponse = { service_date: IsoDate; status: ServiceDayStatus; shifts: ManifestResponse[] }` (turnos já fechados/finalizados, matutino primeiro);
  - `ManifestQuery = { shift: Shift }` com padrão `"matutino"`;
  - `ServiceDayClosedEvent.data = { service_date, shift, orders, late_credits }`;
  - `DueActionName` (rota interna) continua `send_reminders | close_service_day | send_debt_notices`.
- Produces (`serviceDays/service.ts`):
  ```ts
  export async function closeShift(schoolId: string, serviceDate: string, shift: Shift, opts: { log: FastifyBaseLogger; reconcile?: boolean }): Promise<ManifestResponse>;
  export async function closeServiceDay(schoolId: string, serviceDate: string, opts: { log: FastifyBaseLogger; reconcile?: boolean; due?: "frozen" | "past_cutoff" }): Promise<ServiceDayCloseResponse>; // due padrão "past_cutoff"
  export async function getManifest(schoolId: string, serviceDate: string, shift: Shift): Promise<ManifestResponse>;
  export type DueAction = { action: "send_reminders" | "close_service_day" | "send_debt_notices" | "reconcile_topups" | "finish_shifts"; schoolId: string; serviceDate: string; overdue: boolean };
  ```
- Produces (`catalog/service.ts`): `markShiftClosed(trx, shiftId): Promise<void>`; `closeDayIfNoOpenShift(trx, serviceDayId): Promise<void>`.
- Produces (`orders/service.ts`): `expirePendingCheckouts(trx, schoolId, serviceDayId, shift)`, `countLateCredited(trx, serviceDayId, shift)`.
- Produces (rotas): `POST /api/admin/v1/service-days/:date/shifts/:shift/close` (`OFFICE`) → `ManifestResponse`; `POST /api/admin/v1/service-days/:date/close` e `POST /internal/v1/service-days/:school_id/:date/close` → `ServiceDayCloseResponse`; `GET …/:date/manifest?shift=` (admin e interna) → `ManifestResponse`.
- Produces (agenda): `list_due_actions()` com `close_service_day` por turno (dia entra quando algum turno aberto passou do congelamento; `overdue` = algum passou 10 min do corte), `send_reminders` por turno e a ação nova `finish_shifts` (consumida na Task 11).

- [ ] **Step 1: Write the failing tests**

`packages/contracts/src/manifest.test.ts` — o exemplo da spec 6.2 ganha `shift: "matutino"` e o teste passa a validar também o fechamento do dia:

```ts
import { ManifestResponse, ServiceDayCloseResponse } from "./manifest";

const MORNING = {
  shift: "matutino",
  status: "closed",
  closed_at: "2026-11-17T07:35:02-03:00",
  manifest_version: 1,
  kitchen_phone: "+5511988880000",
  totals: { orders: 142, by_item: [{ item: "Misto quente", qty: 61 }] },
  by_class: [
    {
      class: "Infantil 3A",
      orders: [{ order_id: "0193a3b0-0000-7000-8000-000000000001", student: "Léo", items: ["Misto quente"], restrictions: "sem lactose" }],
    },
  ],
  late_credits: 3,
};

describe("manifest contract", () => {
  it("accepts the close example from spec 6.2", () => {
    const example = { service_date: "2026-11-17", status: "open", shifts: [MORNING] };
    expect(ServiceDayCloseResponse.parse(example)).toEqual(example);
    expect(ManifestResponse.parse(MORNING)).toEqual(MORNING);
    expect(ManifestResponse.parse({ ...MORNING, status: "finished" }).status).toBe("finished");
    expect(() => ManifestResponse.parse({ ...MORNING, status: "open" })).toThrow();
    expect(() => ManifestResponse.parse({ ...MORNING, shift: undefined })).toThrow();
  });
});
```

`packages/contracts/src/events.test.ts` (acrescente):

```ts
  it("accepts the service_day.closed example from spec F5C B.1, one per shift", () => {
    const data = { service_date: "2026-11-17", shift: "vespertino", orders: 42, late_credits: 1 };
    expect(OutboxEvent.parse({ type: "service_day.closed", data })).toEqual({ type: "service_day.closed", data });
    expect(OutboxEvent.safeParse({ type: "service_day.closed", data: { ...data, shift: undefined } }).success).toBe(false);
  });
```

`apps/api/src/modules/serviceDays/close.test.ts`:
- no primeiro teste, `const manifest = (await closeServiceDay(schoolId, day.serviceDate, { log })).shifts[0]!;`, o `toMatchObject` ganha `shift: "matutino"`, a repetição passa a `expect((await closeServiceDay(schoolId, day.serviceDate, { log })).shifts[0]).toEqual(manifest);` e o evento esperado vira `{ service_date: day.serviceDate, shift: "matutino", orders: 2, late_credits: 0 }`;
- em "confirms charges paid at the gateway before closing", `expect(manifest.shifts[0]!.totals.orders).toBe(1);`;
- no teste de concorrência, `const manifest = (await closing).shifts[0]!;`;
- no teste das rotas, a leitura passa a `GET …/manifest?shift=matutino` e `expect(after.json()).toEqual(closed.json().shifts[0]);`.

E acrescente (importe `closeShift`, `seedConfirmedOrders`, `moveCutoff`):

```ts
describe("close per shift", () => {
  it("closes each shift on its own and closes the day with the last one", async () => {
    const schoolId = await createSchool();
    const day = await seedServiceDay(schoolId, { serviceDate: "2031-03-03", shifts: { matutino: -10, vespertino: 120 } });
    const morning = await seedConfirmedOrders(schoolId, { serviceDayId: day.serviceDayId, serviceDate: day.serviceDate, menuItemId: day.items[0]!.id, studentNames: ["Léo"], shift: "matutino" });
    const afternoon = await seedConfirmedOrders(schoolId, { serviceDayId: day.serviceDayId, serviceDate: day.serviceDate, menuItemId: day.items[0]!.id, studentNames: ["Bia"], shift: "vespertino" });

    const first = await closeServiceDay(schoolId, day.serviceDate, { log, reconcile: false, due: "frozen" });
    expect(first.status).toBe("open");
    expect(first.shifts.map((s) => [s.shift, s.status])).toEqual([["matutino", "closed"]]);
    expect(first.shifts[0]!.by_class.flatMap((c) => c.orders.map((o) => o.order_id))).toEqual(morning.orderIds);
    await expect(closeShift(schoolId, day.serviceDate, "vespertino", { log, reconcile: false })).rejects.toMatchObject({ code: "service_day_open" });

    await moveCutoff(day.serviceDayId, -600, "vespertino");
    const second = await closeServiceDay(schoolId, day.serviceDate, { log, reconcile: false, due: "frozen" });
    expect(second.status).toBe("closed");
    expect(second.shifts.map((s) => s.shift)).toEqual(["matutino", "vespertino"]);
    expect(second.shifts[0]).toEqual(first.shifts[0]); // romaneio imutável
    expect(second.shifts[1]!.by_class.flatMap((c) => c.orders.map((o) => o.order_id))).toEqual(afternoon.orderIds);
    const events = await adminDb().selectFrom("outboxEvents").select(sql<string>`data::text`.as("data")).where("schoolId", "=", schoolId).where("type", "=", "service_day.closed").orderBy("createdAt").execute();
    expect(events.map((e) => JSON.parse(e.data))).toEqual([
      { service_date: day.serviceDate, shift: "matutino", orders: 1, late_credits: 0 },
      { service_date: day.serviceDate, shift: "vespertino", orders: 1, late_credits: 0 },
    ]);
  });

  it("closes only frozen shifts on the automatic path and every shift past its cutoff on the staff path", async () => {
    const schoolId = await createSchool();
    const day = await seedServiceDay(schoolId, { serviceDate: "2031-03-04", shifts: { matutino: -2, vespertino: 120 } });
    await expect(closeServiceDay(schoolId, day.serviceDate, { log, reconcile: false, due: "frozen" })).rejects.toMatchObject({ code: "service_day_open" });
    const staff = await closeServiceDay(schoolId, day.serviceDate, { log, reconcile: false, due: "past_cutoff" });
    expect(staff.shifts.map((s) => s.shift)).toEqual(["matutino"]);
  });

  it("expires only the unpaid checkouts of the shift being closed", async () => {
    const schoolId = await createSchool();
    const day = await seedServiceDay(schoolId, { serviceDate: "2031-03-05", shifts: { matutino: 60, vespertino: 300 } });
    const f = await seedTwoShiftFamily(schoolId);
    const leo = await order(schoolId, f.guardianId, day.serviceDate, f.leo, [{ menuItemId: day.items[0]!.id, qty: 1 }]);
    const bia = await order(schoolId, f.guardianId, day.serviceDate, f.bia, [{ menuItemId: day.items[0]!.id, qty: 1 }]);
    await moveCutoff(day.serviceDayId, -1, "matutino");
    await closeShift(schoolId, day.serviceDate, "matutino", { log, reconcile: false });
    const status = async (id: string) => (await adminDb().selectFrom("checkouts").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status;
    expect(await status(leo.id)).toBe("expired");
    expect(await status(bia.id)).toBe("pending_payment");
  });

  it("never puts a payment in both the shift manifest and the wallet while the other shift stays open", async () => {
    let served = 0;
    let late = 0;
    for (let round = 0; round < 3; round++) {
      const schoolId = await createSchool();
      const day = await seedServiceDay(schoolId, { shifts: { matutino: 60, vespertino: 300 } });
      const pending: { checkoutId: string; paymentId: string; guardianId: string }[] = [];
      for (let i = 0; i < 12; i++) {
        const family = await seedFamily(schoolId, [`Aluno${i}`], { shift: "matutino" });
        const c = await order(schoolId, family.guardianId, day.serviceDate, family.studentIds[0]!, [{ menuItemId: day.items[0]!.id, qty: 1 }]);
        const p = await adminDb().selectFrom("payments").select("id").where("checkoutId", "=", c.id).executeTakeFirstOrThrow();
        pending.push({ checkoutId: c.id, paymentId: p.id, guardianId: family.guardianId });
      }
      await moveCutoff(day.serviceDayId, -1, "matutino");
      const paidAt = new Date(Date.now() - 120_000);
      const confirm = (p: (typeof pending)[number]) => withTenant(schoolId, (trx) => confirmPayment(trx, { schoolId, paymentId: p.paymentId, paidAt }));
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const half = pending.length / 2;
      const firstBatch = pending.slice(0, half).map(confirm);
      const started: Promise<unknown>[] = [...firstBatch];
      await sleep(20);
      const closing = closeShift(schoolId, day.serviceDate, "matutino", { log, reconcile: false });
      started.push(closing);
      await Promise.allSettled(firstBatch);
      await sleep(20);
      started.push(...pending.slice(half).map(confirm));
      const settled = await Promise.allSettled(started);
      expect(settled.filter((r) => r.status === "rejected")).toEqual([]);
      const manifest = await closing;
      const inManifest = new Set(manifest.by_class.flatMap((c) => c.orders.map((o) => o.order_id)));
      for (const p of pending) {
        const checkout = await adminDb().selectFrom("checkouts").select("status").where("id", "=", p.checkoutId).executeTakeFirstOrThrow();
        const orderRow = await adminDb().selectFrom("orders").select("id").where("checkoutId", "=", p.checkoutId).executeTakeFirstOrThrow();
        const credits = await adminDb().selectFrom("walletEntries").select("id").where("sourceId", "=", p.paymentId).where("kind", "=", "late_payment_credit").execute();
        const isServed = inManifest.has(orderRow.id);
        expect(isServed !== (credits.length === 1)).toBe(true);
        expect(checkout.status).toBe(isServed ? "paid" : "late_credited");
        expect(await walletLedgerMatches(schoolId, p.guardianId)).toBe(true);
        if (isServed) served += 1;
        else late += 1;
      }
      const afternoon = await adminDb().selectFrom("serviceDayShifts").select("status").where("id", "=", day.shiftIds.vespertino!).executeTakeFirstOrThrow();
      expect(afternoon.status).toBe("open");
    }
    expect(served).toBeGreaterThan(0);
    expect(late).toBeGreaterThan(0);
  });

  it("closes one shift through the admin route and serves its manifest", async () => {
    const schoolId = await createSchool();
    const day = await seedServiceDay(schoolId, { serviceDate: "2031-03-06", shifts: { matutino: -1, vespertino: 120 } });
    const { cookies } = await staffCookie(schoolId, "secretaria");
    const app = buildApp();
    const closed = await app.inject({ method: "POST", url: `/api/admin/v1/service-days/${day.serviceDate}/shifts/matutino/close`, cookies });
    expect(closed.statusCode).toBe(200);
    expect(closed.json()).toMatchObject({ shift: "matutino", status: "closed", manifest_version: 1 });
    const read = await app.inject({ method: "GET", url: `/api/admin/v1/service-days/${day.serviceDate}/manifest?shift=matutino`, cookies });
    expect(read.json()).toEqual(closed.json());
    const open = await app.inject({ method: "GET", url: `/api/admin/v1/service-days/${day.serviceDate}/manifest?shift=vespertino`, cookies });
    expect(open.json().error.code).toBe("service_day_open");
    const early = await app.inject({ method: "POST", url: `/api/admin/v1/service-days/${day.serviceDate}/shifts/vespertino/close`, cookies });
    expect(early.json().error.code).toBe("service_day_open");
    expect((await app.inject({ method: "POST", url: `/api/admin/v1/service-days/${day.serviceDate}/shifts/noite/close`, cookies })).statusCode).toBe(400);
  });
});
```

(`order`, `log`, `staffCookie`, `seedTwoShiftFamily`, `walletLedgerMatches` e `confirmPayment` já estão ou passam a estar importados no arquivo.)

`apps/api/src/db/schema.test.ts` (acrescente ao `describe("F5C shifts schema")`):

```ts
  it("lists a day for closing as soon as one of its shifts froze, and closed shifts for finishing after 23:00", async () => {
    const school = await createSchool();
    // Antecedência mínima (30 min): a tarde (corte em 120 min) ainda não entra na janela de lembrete.
    await adminDb().updateTable("schools").set({ reminderLeadMinutes: 30 }).where("id", "=", school).execute();
    await seedServiceDay(school, { serviceDate: "2031-04-01", shifts: { matutino: -6, vespertino: 120 } }); // manhã congelada
    await seedServiceDay(school, { serviceDate: "2031-04-02", shifts: { matutino: -11, vespertino: -11 } }); // atrasado
    const past = await seedServiceDay(school, { serviceDate: "2021-04-03", shifts: { matutino: -60 } });
    await markDayClosed(past.serviceDayId); // 23:00 de 2021 já passou
    const future = await seedServiceDay(school, { serviceDate: "2099-04-04", shifts: { matutino: -60 } });
    await markDayClosed(future.serviceDayId);
    const { rows } = await sql<{ action: string; serviceDate: string; overdue: boolean }>`
      SELECT action, service_date, overdue FROM list_due_actions() WHERE school_id = ${school}
      ORDER BY service_date, action`.execute(getDb());
    expect(rows).toEqual([
      { action: "finish_shifts", serviceDate: "2021-04-03", overdue: false },
      { action: "close_service_day", serviceDate: "2031-04-01", overdue: false },
      { action: "close_service_day", serviceDate: "2031-04-02", overdue: true },
    ]);
  });
```

(importe `markDayClosed`.)

`apps/api/src/modules/internal/schedule.test.ts`: em "closes the day once and returns the same manifest on repetition", a resposta passa a ser `ServiceDayCloseResponse` — `expect(first.json()).toMatchObject({ status: "closed", shifts: [{ shift: "matutino", status: "closed", manifest_version: 1, kitchen_phone: "+5511988880000" }] })`, a repetição continua `toEqual(first.json())` e a leitura do romaneio (se o teste a faz) compara com `first.json().shifts[0]`. Acrescente: um dia com turno fechado em 2021 (como acima) não aparece em `GET /internal/v1/schedule/due` (`finish_shifts` é só do job):

```ts
  it("keeps the safety finish out of the n8n schedule", async () => {
    const schoolId = await createSchool();
    const past = await seedServiceDay(schoolId, { serviceDate: "2021-04-05", shifts: { matutino: -60 } });
    await markDayClosed(past.serviceDayId);
    const res = await buildApp().inject(internalRequest("GET", "/internal/v1/schedule/due"));
    expect(res.json().due.filter((d: { school_id: string }) => d.school_id === schoolId)).toEqual([]);
  });
```

`apps/api/test/n8n.test.ts`:
- "closes the day without sending WhatsApp" continua igual (a soma dos turnos dá `orders: 0`);
- em "sends the kitchen summary from service_day.closed", o evento passa a `{ service_date: "2031-09-09", shift: "matutino", orders: 0, late_credits: 0 }` e o WhatsApp esperado `params: ["09/09 (manhã)", "0", "nenhum item"]`; acrescente no mesmo teste, depois do `dup`, um segundo evento **sem** `shift` (outro id) que também resolve o romaneio da manhã:

```ts
      const legacy = await withN8n(async () =>
        signedEventRequest({ ...envelope(crypto.randomUUID(), "service_day.closed", { service_date: "2031-09-09", orders: 0, late_credits: 0 }), school_id: schoolId }),
      );
      await h.run(code("events.json", "Verify and send"), { input: { json: { headers: legacy.headers } }, raw: legacy.body, staticData });
      expect(h.whatsapp).toHaveLength(2);
      expect(h.whatsapp[1]!.params[0]).toBe("09/09 (manhã)");
```

Web — em `catalogAdmin.test.tsx`, o teste "closes a day after confirming…" passa a:

```tsx
  it("closes a shift after confirming and reports the order count", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    const fn = mockApi({
      ...BASE,
      "GET /api/admin/v1/me": me("secretaria"),
      "GET /api/admin/v1/service-days": { status: 200, body: { serviceDays: [OPEN_DAY] } },
      "POST /api/admin/v1/service-days/2030-03-04/shifts/matutino/close": {
        status: 200,
        body: {
          shift: "matutino", status: "closed", closed_at: "2030-03-04T11:00:00.000Z", manifest_version: 1, kitchen_phone: null,
          totals: { orders: 3, by_item: [] }, by_class: [], late_credits: 0,
        },
      },
    });
    renderAdmin("/admin/lanche/dias");
    expect(await screen.findByText("Aberto")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Fechar turno — Manhã" }));
    expect(window.confirm).toHaveBeenCalledWith("Fechar o turno da manhã? Os pedidos não pagos expiram e o romaneio fica congelado.");
    await waitFor(() => expect(callOf(fn, "POST /api/admin/v1/service-days/2030-03-04/shifts/matutino/close")).toBeDefined());
    expect(await screen.findByText("Turno da manhã fechado: 3 pedidos.")).toBeTruthy();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @app-lanche/contracts test; pnpm app:down; docker compose down; pnpm --filter @app-lanche/api exec vitest run src/modules/serviceDays src/modules/internal src/db/schema.test.ts test/n8n.test.ts; pnpm --filter @app-lanche/web exec vitest run src/areas/admin/catalogAdmin.test.tsx`
Expected: FAIL (`closeShift` não existe; resposta sem `shifts`; agenda sem `finish_shifts`; botão "Fechar turno — Manhã" ausente).

- [ ] **Step 3: Migration** — `db/migrations/0013_shift_schedule.sql`

```sql
-- F5C Parte B: agenda por turno (spec 4.4). Mesma função e assinatura; nenhuma função SECURITY DEFINER nova.
-- send_reminders: abre quando algum turno aberto entra na antecedência da escola.
-- close_service_day: o dia entra quando algum turno aberto passou do congelamento; atrasado se passou 10 min do corte.
-- finish_shifts (novo, só do job /jobs/v1/shifts/safety-finish): turno fechado e não finalizado depois das 23:00 locais.
CREATE OR REPLACE FUNCTION list_due_actions()
RETURNS TABLE (action text, school_id uuid, service_date date, overdue boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT 'send_reminders'::text, d.school_id, d.service_date, false
  FROM service_days d JOIN schools s ON s.id = d.school_id
  WHERE d.status = 'open'
    AND EXISTS (
      SELECT 1 FROM service_day_shifts sh
      WHERE sh.service_day_id = d.id AND sh.status = 'open'
        AND now() >= sh.cutoff_at - make_interval(mins => s.reminder_lead_minutes)
        AND now() < sh.cutoff_at)
    AND NOT EXISTS (
      SELECT 1 FROM reminder_batches b
      WHERE b.school_id = d.school_id AND b.service_date = d.service_date AND b.completed_at IS NOT NULL)
  UNION ALL
  SELECT 'close_service_day'::text, d.school_id, d.service_date, bool_or(now() >= sh.cutoff_at + interval '10 minutes')
  FROM service_days d JOIN service_day_shifts sh ON sh.service_day_id = d.id
  WHERE sh.status = 'open' AND now() >= sh.freeze_at
  GROUP BY d.school_id, d.service_date
  UNION ALL
  -- Aviso de débito: no máximo a cada 3 dias enquanto negativo, só das 09:00 às 19:00 no fuso da escola.
  SELECT 'send_debt_notices'::text, s.id, (now() AT TIME ZONE s.timezone)::date, false
  FROM schools s
  WHERE (now() AT TIME ZONE s.timezone)::time >= time '09:00'
    AND (now() AT TIME ZONE s.timezone)::time < time '19:00'
    AND EXISTS (
      SELECT 1 FROM wallets w
      WHERE w.school_id = s.id AND w.balance_cents < 0
        AND (w.debt_notice_at IS NULL OR w.debt_notice_at <= now() - interval '3 days'))
  UNION ALL
  -- Recargas: conciliação e expiração pelo job do Cloud Scheduler, nunca pelo n8n (regra 21).
  SELECT 'reconcile_topups'::text, s.id, (now() AT TIME ZONE s.timezone)::date, false
  FROM schools s
  WHERE EXISTS (SELECT 1 FROM topups t WHERE t.school_id = s.id AND t.status = 'pending_payment')
     OR EXISTS (
       SELECT 1 FROM topups t JOIN payments p ON p.school_id = t.school_id AND p.topup_id = t.id
       WHERE t.school_id = s.id AND t.status IN ('cancelled', 'expired') AND t.created_at > now() - interval '24 hours'
         AND p.status IN ('pending', 'expired') AND p.provider_charge_id IS NOT NULL)
  UNION ALL
  SELECT 'finish_shifts'::text, d.school_id, d.service_date, false
  FROM service_days d JOIN schools s ON s.id = d.school_id
  WHERE EXISTS (SELECT 1 FROM service_day_shifts sh WHERE sh.service_day_id = d.id AND sh.status = 'closed')
    AND now() >= ((d.service_date + time '23:00') AT TIME ZONE s.timezone)
  ORDER BY 3, 2, 1
$$;
```

Rode o comando de tipos (Global Constraints); `types.ts` não deve mudar.

- [ ] **Step 4: Contracts**

`packages/contracts/src/manifest.ts`:

```ts
import { IsoDate } from "./common";
import { ServiceDayStatus } from "./catalog";
import { Shift } from "./shifts";

/** Romaneio de um turno, congelado no fechamento (regra 18). `status` é o do turno. */
export const ManifestResponse = ManifestContent.extend({
  shift: Shift,
  status: z.enum(["closed", "finished"]),
  closed_at: z.string().datetime({ offset: true }),
  manifest_version: z.number().int().positive(),
  kitchen_phone: z.string().nullable(),
});
export type ManifestResponse = z.infer<typeof ManifestResponse>;

/** Fechamento do dia (n8n, segurança, equipe): turnos já fechados ou finalizados, matutino primeiro. */
export const ServiceDayCloseResponse = z.object({
  service_date: IsoDate,
  status: ServiceDayStatus,
  shifts: z.array(ManifestResponse).min(1),
});
export type ServiceDayCloseResponse = z.infer<typeof ServiceDayCloseResponse>;

/** `?shift=` das rotas de leitura do romaneio; sem ele, o da manhã (eventos anteriores aos turnos). */
export const ManifestQuery = z.object({ shift: Shift.default("matutino") });
```

(Se `catalog.ts` importar algo de `manifest.ts`, mova `ServiceDayStatus` para `shifts.ts` para evitar ciclo; hoje não importa.)

`packages/contracts/src/events.ts` — `ServiceDayClosedEvent.data` ganha `shift: Shift` (importe de `./shifts`).

- [ ] **Step 5: API**

`catalog/repo.ts` — troque `markServiceDayClosed` por:

```ts
export async function markShiftClosed(trx: Trx, shiftId: string): Promise<void> {
  await trx.updateTable("serviceDayShifts").set({ status: "closed", closedAt: sql<Date>`now()` }).where("id", "=", shiftId).where("status", "=", "open").execute();
}

/** O dia fica `closed` quando nenhum turno está aberto (spec F5C, B.1). */
export async function closeDayIfNoOpenShift(trx: Trx, serviceDayId: string): Promise<void> {
  await sql`
    UPDATE service_days SET status = 'closed', closed_at = now()
    WHERE id = ${serviceDayId} AND status = 'open'
      AND NOT EXISTS (SELECT 1 FROM service_day_shifts WHERE service_day_id = ${serviceDayId} AND status = 'open')`.execute(trx);
}
```

`catalog/service.ts`: exporte `markShiftClosed = repo.markShiftClosed` e `closeDayIfNoOpenShift = repo.closeDayIfNoOpenShift`; remova `markServiceDayClosed`.

`orders/repo.ts` — `checkoutIdsByStatus(trx, serviceDayId, shift, status)` acrescenta `.where("shift", "=", shift)`. `orders/service.ts`:

```ts
export async function expirePendingCheckouts(trx: Trx, schoolId: string, serviceDayId: string, shift: Shift): Promise<number> {
  let expired = 0;
  for (const id of await repo.checkoutIdsByStatus(trx, serviceDayId, shift, "pending_payment")) {
    if (await expireCheckout(trx, schoolId, id)) expired += 1;
  }
  return expired;
}

export async function countLateCredited(trx: Trx, serviceDayId: string, shift: Shift): Promise<number> {
  return (await repo.checkoutIdsByStatus(trx, serviceDayId, shift, "late_credited")).length;
}
```

`serviceDays/repo.ts`:
- `manifestLines(trx, serviceDayId, shift)` acrescenta `.where("checkouts.shift", "=", shift)`;
- `insertManifest(trx, { schoolId, serviceDayId, shift, content })` (já da Task 1);
- `readManifest(trx, serviceDayId, shift)` acrescenta `.where("shift", "=", shift)`;
- o tipo de `action` em `listDueActions` ganha `"finish_shifts"`.

`serviceDays/service.ts` — substitua `response`, `closeServiceDay` e `getManifest` por:

```ts
async function manifestOf(trx: Trx, serviceDayId: string, turn: LockedShift, kitchenPhone: string | null): Promise<ManifestResponse> {
  const manifest = await repo.readManifest(trx, serviceDayId, turn.shift);
  return {
    shift: turn.shift,
    status: turn.status as "closed" | "finished",
    closed_at: turn.closedAt!.toISOString(),
    manifest_version: manifest.version,
    kitchen_phone: kitchenPhone,
    ...(JSON.parse(manifest.content) as ManifestContent),
  };
}

/** Fecha um turno já travado (FOR UPDATE, com o dia FOR UPDATE antes): expira os pendentes, congela o romaneio e avisa. */
async function closeLockedShift(trx: Trx, schoolId: string, serviceDate: string, serviceDayId: string, turn: LockedShift): Promise<void> {
  await orders.expirePendingCheckouts(trx, schoolId, serviceDayId, turn.shift);
  const content = buildManifest(
    await repo.manifestLines(trx, serviceDayId, turn.shift),
    await orders.countLateCredited(trx, serviceDayId, turn.shift),
  );
  await repo.insertManifest(trx, { schoolId, serviceDayId, shift: turn.shift, content: JSON.stringify(content) });
  await catalog.markShiftClosed(trx, turn.id);
  await catalog.closeDayIfNoOpenShift(trx, serviceDayId);
  await enqueueEvent(trx, schoolId, {
    type: "service_day.closed",
    data: { service_date: serviceDate, shift: turn.shift, orders: content.totals.orders, late_credits: content.late_credits },
  });
}

export async function closeShift(
  schoolId: string,
  serviceDate: string,
  shift: Shift,
  options: { log: FastifyBaseLogger; reconcile?: boolean },
): Promise<ManifestResponse> {
  if (options.reconcile !== false) await payments.reconcileServiceDay(schoolId, serviceDate, options.log);
  return withTenant(schoolId, async (trx) => {
    // Travas: service_days FOR UPDATE → service_day_shifts FOR UPDATE (regra 16) → checkouts → payments → wallets.
    const day = await catalog.lockServiceDayByDate(trx, serviceDate, "update");
    if (!day) throw new DomainError("not_found");
    const turn = await catalog.lockShift(trx, day.id, shift, "update");
    if (!turn) throw new DomainError("not_found");
    if (turn.status === "open") {
      // Fechar antes do corte transformaria pagamentos no prazo em crédito atrasado.
      if (turn.beforeCutoff) throw new DomainError("service_day_open");
      await closeLockedShift(trx, schoolId, serviceDate, day.id, turn);
    }
    const after = (await catalog.listShifts(trx, day.id)).find((s) => s.shift === shift)!;
    return manifestOf(trx, day.id, after, await repo.kitchenPhone(trx));
  });
}

/**
 * Fecha os turnos prontos do dia. `frozen` (n8n e segurança): passou do congelamento. `past_cutoff` (equipe): passou do corte.
 * Nenhum turno fechado no fim → service_day_open.
 */
export async function closeServiceDay(
  schoolId: string,
  serviceDate: string,
  options: { log: FastifyBaseLogger; reconcile?: boolean; due?: "frozen" | "past_cutoff" },
): Promise<ServiceDayCloseResponse> {
  if (options.reconcile !== false) await payments.reconcileServiceDay(schoolId, serviceDate, options.log);
  const due = options.due ?? "past_cutoff";
  return withTenant(schoolId, async (trx) => {
    const day = await catalog.lockServiceDayByDate(trx, serviceDate, "update");
    if (!day) throw new DomainError("not_found");
    for (const { shift } of await catalog.listShifts(trx, day.id)) {
      const turn = (await catalog.lockShift(trx, day.id, shift, "update"))!; // ordem fixa: matutino, vespertino
      const ready = due === "frozen" ? turn.frozen : !turn.beforeCutoff;
      if (turn.status === "open" && ready) await closeLockedShift(trx, schoolId, serviceDate, day.id, turn);
    }
    const done = (await catalog.listShifts(trx, day.id)).filter((s) => s.status !== "open");
    if (done.length === 0) throw new DomainError("service_day_open");
    const phone = await repo.kitchenPhone(trx);
    const shifts: ManifestResponse[] = [];
    for (const s of done) shifts.push(await manifestOf(trx, day.id, s, phone));
    const status = (await catalog.lockServiceDayById(trx, day.id, "share")).status;
    return { service_date: serviceDate, status, shifts };
  });
}

export async function getManifest(schoolId: string, serviceDate: string, shift: Shift): Promise<ManifestResponse> {
  return withTenant(schoolId, async (trx) => {
    const day = await catalog.lockServiceDayByDate(trx, serviceDate, "share");
    if (!day) throw new DomainError("not_found");
    const turn = await catalog.lockShift(trx, day.id, shift, "share");
    if (!turn) throw new DomainError("not_found");
    if (turn.status === "open") throw new DomainError("service_day_open");
    return manifestOf(trx, day.id, turn, await repo.kitchenPhone(trx));
  });
}
```

`kdsManifest` (substituído na Task 7) fica, por ora, lendo o turno `matutino`: `repo.manifestLines(trx, day.id, "matutino")`, `orders.countLateCredited(trx, day.id, "matutino")` e `repo.readManifest(trx, day.id, "matutino")`.

`safetyClose` chama `closeServiceDay(d.schoolId, d.serviceDate, { log: opts.log, due: "frozen" })`. `DueAction["action"]` ganha `"finish_shifts"`.

`serviceDays/routes.ts`:

```ts
const ShiftParams = z.object({ date: IsoDate, shift: Shift });

  app.post("/api/admin/v1/service-days/:date/close", { config: { auth: OFFICE } }, async (req) =>
    service.closeServiceDay(req.session!.schoolId, DateParams.parse(req.params).date, { log: req.log, due: "past_cutoff" }),
  );

  // Naturalmente idempotente: repetir devolve o mesmo romaneio (sem Idempotency-Key, como o fechamento do dia).
  app.post("/api/admin/v1/service-days/:date/shifts/:shift/close", { config: { auth: OFFICE } }, async (req) => {
    const p = ShiftParams.parse(req.params);
    return service.closeShift(req.session!.schoolId, p.date, p.shift, { log: req.log });
  });

  app.get("/api/admin/v1/service-days/:date/manifest", { config: { auth: OFFICE } }, async (req) =>
    service.getManifest(req.session!.schoolId, DateParams.parse(req.params).date, ManifestQuery.parse(req.query).shift),
  );
```

`internal/routes.ts`:

```ts
/** Conciliação de recargas e finalização de segurança são de jobs do Cloud Scheduler, não do n8n. */
type N8nAction = Exclude<serviceDays.DueAction["action"], "reconcile_topups" | "finish_shifts">;
const forN8n = (d: serviceDays.DueAction): d is serviceDays.DueAction & { action: N8nAction } =>
  d.action !== "reconcile_topups" && d.action !== "finish_shifts";

  app.post("/internal/v1/service-days/:school_id/:date/close", INTERNAL, async (req) => {
    const p = DayParams.parse(req.params);
    return serviceDays.closeServiceDay(p.school_id, p.date, { log: req.log, due: "frozen" });
  });

  app.get("/internal/v1/service-days/:school_id/:date/manifest", INTERNAL, async (req) => {
    const p = DayParams.parse(req.params);
    return serviceDays.getManifest(p.school_id, p.date, ManifestQuery.parse(req.query).shift);
  });
```

- [ ] **Step 6: n8n**

`n8n/code/events.js`, ramo `service_day.closed`:

```js
  case "service_day.closed": {
    // Resumo da cozinha por turno, qualquer que seja o fechamento; evento sem turno (anterior aos turnos) é o da manhã.
    const shift = d.shift || "matutino";
    const m = ensureOk(await api(this, "GET", `/internal/v1/service-days/${event.school_id}/${d.service_date}/manifest?shift=${shift}`), "manifest");
    if (m.kitchen_phone && $env.WA_TEMPLATE_KITCHEN) {
      const items = m.totals.by_item.map((i) => `${i.qty}x ${i.item}`).join("; ") || "nenhum item";
      const label = shift === "vespertino" ? "tarde" : "manhã";
      await send.call(this, m.kitchen_phone, $env.WA_TEMPLATE_KITCHEN, [`${dayMonth(d.service_date)} (${label})`, m.totals.orders, items]);
    }
    break;
  }
```

`n8n/code/schedule.js`, em `closeDay`:

```js
  const m = ensureOk(res, "close");
  // O resumo da cozinha sai do evento service_day.closed (um por turno), qualquer que seja o fechamento.
  return { closed: true, orders: m.shifts.reduce((n, s) => n + s.totals.orders, 0) };
```

Run: `pnpm n8n:build` (regrava `n8n/workflows/*.json`). Em `docs/n8n.md`, a linha do resumo da cozinha passa a: "o resumo da cozinha sai do evento `service_day.closed`, **um por turno** (campo `shift`), qualquer que seja o fechamento. O fluxo lê o romaneio do turno em `GET /internal/v1/service-days/{school_id}/{date}/manifest?shift={shift}` (sem `shift`: manhã) e manda o mesmo modelo, com o primeiro parâmetro `DD/MM (manhã)` ou `DD/MM (tarde)`; falha na leitura ou no envio responde 500 e a outbox tenta de novo."

- [ ] **Step 7: Admin "Dias de serviço" por turno** — em `ServiceDaysAdmin.tsx`:
  - a coluna "Corte" e a "Situação" viram uma coluna "Turnos", com uma linha por turno do dia:

```tsx
const SHIFT_STATUS: Record<ShiftStatus, { label: string; tone: "success" | "warning" | "secondary" }> = {
  open: { label: "Aberto", tone: "success" },
  closed: { label: "Fechado (romaneio pronto)", tone: "warning" },
  finished: { label: "Finalizado", tone: "secondary" },
};

                  <td>
                    <ul className="list-unstyled mb-0">
                      {d.shifts.map((s) => (
                        <li key={s.shift} className="d-flex flex-wrap align-items-center gap-2 mb-1">
                          <span>{`${SHIFT_LABELS[s.shift]} — corte ${formatTime(s.cutoffAt)}`}</span>
                          <StatusBadge tone={SHIFT_STATUS[s.status].tone}>{SHIFT_STATUS[s.status].label}</StatusBadge>
                          {s.status === "open" && (
                            <Button size="sm" outline color="danger" type="button" disabled={busy} onClick={() => closeShift(d, s.shift)}>
                              Fechar turno<span className="visually-hidden">{` — ${SHIFT_LABELS[s.shift]}`}</span>
                            </Button>
                          )}
                        </li>
                      ))}
                    </ul>
                  </td>
```

  - `close(day)` vira:

```ts
  async function closeShift(day: ServiceDay, shift: Shift) {
    const name = SHIFT_LABELS[shift].toLowerCase();
    if (!window.confirm(`Fechar o turno da ${name}? Os pedidos não pagos expiram e o romaneio fica congelado.`)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const manifest = await apiFetch(`/api/admin/v1/service-days/${day.serviceDate}/shifts/${shift}/close`, ManifestResponse, { method: "POST" });
      const message = `Turno da ${name} fechado: ${manifest.totals.orders} pedidos.`;
      setNotice(message);
      announce(message);
      await reload();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }
```

  - a situação do dia some da tabela (cada turno mostra a sua).

- [ ] **Step 8: Specs (regra 23).** Na spec principal, 6.2: o exemplo de `POST …/close` passa a

```json
{ "service_date": "2026-11-17", "status": "closed",
  "shifts": [
    { "shift": "matutino", "status": "closed", "closed_at": "2026-11-17T07:35:02-03:00", "manifest_version": 1,
      "kitchen_phone": "+5511988880000",
      "totals": { "orders": 142, "by_item": [ { "item": "Misto quente", "qty": 61 } ] },
      "by_class": [
        { "class": "Infantil 3A",
          "orders": [ { "order_id": "0193…", "student": "Léo", "items": ["Misto quente"], "restrictions": "sem lactose" } ] }
      ],
      "late_credits": 3 } ] }
```

e o texto: "Fecha os turnos já congelados (`freeze_at`) e devolve os romaneios de todos os turnos fechados do dia; `409 service_day_open` se nenhum. Idempotente. O resumo da cozinha sai do evento `service_day.closed`, um por turno." O `GET …/manifest` vira "`?shift=matutino|vespertino` (padrão matutino): o romaneio daquele turno (um item de `shifts` acima); `409` se o turno ainda está aberto." Na spec F5C, em B.1, acrescente o exemplo de evento: `{ "type": "service_day.closed", "data": { "service_date": "2026-11-17", "shift": "vespertino", "orders": 42, "late_credits": 1 } }`.

- [ ] **Step 9: Run tests and checks**

Run: `pnpm app:down; docker compose down; pnpm --filter @app-lanche/contracts test && pnpm test:api && pnpm --filter @app-lanche/web test && pnpm typecheck && pnpm lint`
Expected: PASS (os testes de KDS e de painel que chamam `closeServiceDay` sem usar o retorno continuam passando).

- [ ] **Step 10: Commit**

```bash
git add db/migrations/0013_shift_schedule.sql packages/contracts/src/manifest.ts packages/contracts/src/manifest.test.ts \
  packages/contracts/src/events.ts packages/contracts/src/events.test.ts \
  apps/api/src/modules/catalog apps/api/src/modules/orders apps/api/src/modules/serviceDays apps/api/src/modules/internal \
  apps/api/src/db/schema.test.ts apps/api/test/n8n.test.ts n8n/code n8n/workflows docs/n8n.md \
  apps/web/src/areas/admin/ServiceDaysAdmin.tsx apps/web/src/areas/admin/catalogAdmin.test.tsx \
  docs/superpowers/specs/2026-11-16-app-lanche-design.md docs/superpowers/specs/2026-11-20-admin-turnos-avisos-design.md
git commit -m "feat(service-days): close, manifest and schedule per shift"
```

---

### Task 7: KDS por turno (romaneio, entregas e abas no tablet)

**Files:**
- Modify: `packages/contracts/src/kds.ts`, `kds.test.ts`
- Modify: `apps/api/src/modules/serviceDays/service.ts` (`kdsManifest`), `apps/api/src/modules/kds/repo.ts` (`deliverableOrders`)
- Test: `apps/api/src/modules/kds/sync.test.ts`
- Modify: `apps/web/src/areas/kds/{db.ts,state.ts,sync.ts,KdsBoard.tsx}`; Create: `apps/web/src/areas/kds/ShiftBoard.tsx`
- Test: `apps/web/src/areas/kds/state.test.ts`; Create: `apps/web/src/areas/kds/ShiftBoard.test.tsx`
- Create: `e2e/shifts.spec.ts`
- Modify: `docs/superpowers/specs/2026-11-20-admin-turnos-avisos-design.md` (B.3: exemplo do romaneio do tablet), `docs/superpowers/specs/2026-11-16-app-lanche-design.md` (7.2: store `manifest` por data com os turnos)

**Interfaces:**
- Consumes: `catalog.listShifts` (Task 3); `repo.manifestLines/readManifest(…, shift)`, `orders.countLateCredited(…, shift)`, `closeShift` (Task 6); `SHIFT_LABELS` (Task 2).
- Produces (contracts):
  ```ts
  export const KdsShiftManifest = z.object({ shift: Shift, status: ShiftStatus, manifestVersion: z.number().int().positive().nullable(), content: ManifestContent });
  export const KdsManifestResponse = z.object({ serviceDate: IsoDate, shifts: z.array(KdsShiftManifest).min(1) }); // matutino primeiro
  ```
- Produces (web): `ManifestRow = KdsManifestResponse & { fetchedAt: string }` (store `manifest`, chave `serviceDate`, Dexie versão 3); `mergeManifest(local: KdsManifestResponse | undefined, server: KdsManifestResponse): KdsManifestResponse` e `pickShift<T extends { shift: Shift; status: ShiftStatus }>(shifts: T[], selected: Shift | null): T | undefined` em `state.ts`; componente `ShiftBoard({ shift, delivered, onTap })` (a Task 9 acrescenta `onFinish`).
- Produces (API): entrega aceita quando o **turno** do pedido está fechado (antes: o dia).

- [ ] **Step 1: Write the failing tests**

`packages/contracts/src/kds.test.ts` (acrescente):

```ts
  it("accepts the spec F5C B.3 example of a tablet manifest with two shifts", () => {
    const content = { totals: { orders: 1, by_item: [{ item: "Misto quente", qty: 1 }] }, by_class: [{ class: "Infantil 3A", orders: [{ order_id: "0193a3b0-0000-7000-8000-000000000001", student: "Léo", items: ["Misto quente"], restrictions: null }] }], late_credits: 0 };
    const example = {
      serviceDate: "2026-11-23",
      shifts: [
        { shift: "matutino", status: "closed", manifestVersion: 1, content },
        { shift: "vespertino", status: "open", manifestVersion: null, content: { totals: { orders: 0, by_item: [] }, by_class: [], late_credits: 0 } },
      ],
    };
    expect(KdsManifestResponse.parse(example)).toEqual(example);
    expect(() => KdsManifestResponse.parse({ serviceDate: "2026-11-23", shifts: [] })).toThrow();
  });
```

`apps/api/src/modules/kds/sync.test.ts`:
- em "serves a preview while open and the frozen manifest after close": `toMatchObject({ serviceDate: "2031-11-03", shifts: [{ shift: "matutino", status: "open", manifestVersion: null }] })`, `preview.json().shifts[0].content.by_class[0].orders[0].order_id` e, depois do fechamento, `toMatchObject({ shifts: [{ status: "closed", manifestVersion: 1 }] })`.
- acrescente (importe `closeShift`, `seedServiceDay`, `seedConfirmedOrders`):

```ts
describe("kds per shift", () => {
  it("serves each shift and accepts deliveries only for a closed shift", async () => {
    const schoolId = await createSchool();
    await seedTenant(schoolId);
    const { cookies } = await kitchenCookie(schoolId);
    const day = await seedServiceDay(schoolId, { serviceDate: "2031-11-20", shifts: { matutino: -30, vespertino: 120 } });
    const morning = await seedConfirmedOrders(schoolId, { serviceDayId: day.serviceDayId, serviceDate: day.serviceDate, menuItemId: day.items[0]!.id, studentNames: ["Léo"], shift: "matutino" });
    const afternoon = await seedConfirmedOrders(schoolId, { serviceDayId: day.serviceDayId, serviceDate: day.serviceDate, menuItemId: day.items[0]!.id, studentNames: ["Bia"], shift: "vespertino" });
    await closeShift(schoolId, day.serviceDate, "matutino", { log, reconcile: false });
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: `/api/kds/v1/manifest/${day.serviceDate}`, cookies });
    const body = res.json();
    expect(body.shifts.map((s: { shift: string; status: string; manifestVersion: number | null }) => [s.shift, s.status, s.manifestVersion])).toEqual([
      ["matutino", "closed", 1],
      ["vespertino", "open", null],
    ]);
    expect(body.shifts[0].content.by_class[0].orders.map((o: { order_id: string }) => o.order_id)).toEqual(morning.orderIds);
    expect(body.shifts[1].content.by_class[0].orders.map((o: { order_id: string }) => o.order_id)).toEqual(afternoon.orderIds);
    const a = ev(morning.orderIds[0]!, "delivered", t(0));
    const b = ev(afternoon.orderIds[0]!, "delivered", t(1));
    const sent = await app.inject({ method: "POST", url: "/api/kds/v1/events", cookies, payload: { events: [a, b] } });
    expect(sent.json()).toEqual({ accepted: [a.eventId], rejected: [b.eventId] });
  });
});
```

`apps/web/src/areas/kds/state.test.ts` (acrescente; importe `mergeManifest`, `pickShift`):

```ts
const EMPTY = { totals: { orders: 0, by_item: [] }, by_class: [], late_credits: 0 };
const shift = (s: "matutino" | "vespertino", status: "open" | "closed" | "finished") => ({ shift: s, status, manifestVersion: status === "open" ? null : 1, content: EMPTY });

describe("shift helpers", () => {
  it("never moves a shift back to an earlier state when merging the server's manifest", () => {
    const local = { serviceDate: "2031-11-05", shifts: [shift("matutino", "finished"), shift("vespertino", "open")] };
    const server = { serviceDate: "2031-11-05", shifts: [shift("matutino", "closed"), shift("vespertino", "closed")] };
    expect(mergeManifest(local, server).shifts.map((s) => s.status)).toEqual(["finished", "closed"]);
    expect(mergeManifest(undefined, server)).toEqual(server);
  });

  it("keeps the chosen shift, otherwise the first not finished, otherwise the first", () => {
    const shifts = [shift("matutino", "finished"), shift("vespertino", "closed")];
    expect(pickShift(shifts, "matutino")?.shift).toBe("matutino");
    expect(pickShift(shifts, null)?.shift).toBe("vespertino");
    expect(pickShift([shift("matutino", "finished")], "vespertino")?.shift).toBe("matutino");
    expect(pickShift([], null)).toBeUndefined();
  });
});
```

`apps/web/src/areas/kds/ShiftBoard.test.tsx`:

```tsx
import type { KdsShiftManifest } from "@app-lanche/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShiftBoard } from "./ShiftBoard";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const O1 = "0193a3b0-0000-7000-8000-000000000001";
const O2 = "0193a3b0-0000-7000-8000-000000000002";
const O3 = "0193a3b0-0000-7000-8000-000000000003";
const SHIFT: KdsShiftManifest = {
  shift: "matutino",
  status: "closed",
  manifestVersion: 1,
  content: {
    totals: { orders: 3, by_item: [{ item: "Misto quente", qty: 3 }] },
    by_class: [
      { class: "Infantil 3A", orders: [{ order_id: O1, student: "Léo", items: ["Misto quente"], restrictions: "sem lactose" }, { order_id: O2, student: "Bia", items: ["Misto quente"], restrictions: null }] },
      { class: "Infantil 4B", orders: [{ order_id: O3, student: "Caio", items: ["Misto quente"], restrictions: null }] },
    ],
    late_credits: 0,
  },
};

function setup(overrides: Partial<Parameters<typeof ShiftBoard>[0]> = {}) {
  const onTap = vi.fn();
  render(<ShiftBoard shift={SHIFT} delivered={new Set([O1])} onTap={onTap} {...overrides} />);
  return { onTap };
}

describe("ShiftBoard", () => {
  it("lists the shift's orders and marks a pending one as delivered", () => {
    const { onTap } = setup();
    expect(screen.getByText("3 pedidos · 3x Misto quente")).toBeTruthy();
    expect(screen.getByTestId(`kds-order-${O1}`).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId(`kds-order-${O2}`));
    expect(onTap).toHaveBeenCalledWith(O2, true);
  });

  it("filters by class and by delivery state", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Infantil 4B" }));
    expect(screen.queryByTestId(`kds-order-${O1}`)).toBeNull();
    expect(screen.getByTestId(`kds-order-${O3}`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Todas as turmas" }));
    fireEvent.click(screen.getByRole("button", { name: "Entregues" }));
    expect(screen.getByTestId(`kds-order-${O1}`)).toBeTruthy();
    expect(screen.queryByTestId(`kds-order-${O2}`)).toBeNull();
  });

  it("shows the preview of an open shift with the cards disabled", () => {
    setup({ shift: { ...SHIFT, status: "open", manifestVersion: null } });
    expect(screen.getByTestId("kds-waiting")).toBeTruthy();
    expect((screen.getByTestId(`kds-order-${O2}`) as HTMLButtonElement).disabled).toBe(true);
  });
});
```

E2E — `e2e/shifts.spec.ts` (escola própria, independente de `kds.spec.ts`):

```ts
import { createHash, createHmac, randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";

test.describe.configure({ mode: "serial" });

const DB = "postgres://postgres:postgres@localhost:5432/app_lanche_e2e";
const SCHOOL = "0193a3b0-0000-7000-8000-00000000e2e2";
const SYNCED = /^0 pendentes · última sincronização \d{2}:\d{2}$/;

async function query<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: DB });
  await c.connect();
  try {
    return (await c.query<T>(sql, params)).rows;
  } finally {
    await c.end();
  }
}

async function pairingCode(code: string): Promise<void> {
  await query(
    `INSERT INTO devices (id, school_id, kind, pairing_code_hash, pairing_expires_at) VALUES (gen_random_uuid(), $1, 'kitchen', $2, now() + interval '30 minutes')`,
    [SCHOOL, createHash("sha256").update(code).digest("hex")],
  );
}

async function closeDay(date: string): Promise<void> {
  const path = `/internal/v1/service-days/${SCHOOL}/${date}/close`;
  const timestamp = new Date().toISOString();
  const signature = createHmac("sha256", "e2e-hmac-secret-with-at-least-32-chars!!").update(`POST\n${path}\n${timestamp}\n`).digest("hex");
  const res = await fetch(`http://localhost:8080${path}`, {
    method: "POST",
    headers: { authorization: "Bearer e2e-service-token-with-at-least-32-chars", "x-timestamp": timestamp, "x-signature": signature },
  });
  expect(res.status).toBe(200);
}

/** Hoje (fuso da escola), manhã e tarde já congeladas: 2 pedidos de manhã (Léo, Bia) e 1 à tarde (Caio). */
async function seed(): Promise<{ date: string; morning: string[]; afternoon: string }> {
  await query(`INSERT INTO schools (id, name) VALUES ($1, 'Escola Turnos') ON CONFLICT DO NOTHING`, [SCHOOL]);
  const [day] = await query<{ id: string; date: string }>(
    `INSERT INTO service_days (id, school_id, service_date, cutoff_at, freeze_at)
     VALUES (gen_random_uuid(), $1, (now() AT TIME ZONE 'America/Sao_Paulo')::date, now() - interval '30 minutes', now() - interval '25 minutes')
     RETURNING id, service_date::text AS date`,
    [SCHOOL],
  );
  for (const shift of ["matutino", "vespertino"]) {
    await query(
      `INSERT INTO service_day_shifts (id, school_id, service_day_id, shift, cutoff_at, freeze_at)
       VALUES (gen_random_uuid(), $1, $2, $3, now() - interval '30 minutes', now() - interval '25 minutes')`,
      [SCHOOL, day!.id, shift],
    );
  }
  const [item] = await query<{ id: string }>(`INSERT INTO menu_items (id, school_id, name, price_cents) VALUES (gen_random_uuid(), $1, 'Misto quente', 900) RETURNING id`, [SCHOOL]);
  const [guardian] = await query<{ id: string }>(`INSERT INTO guardians (id, school_id, phone_e164, first_name) VALUES (gen_random_uuid(), $1, '+5511999990199', 'Ana') RETURNING id`, [SCHOOL]);
  const orders: Record<string, string[]> = { matutino: [], vespertino: [] };
  const plan: [string, string, string[]][] = [["matutino", "Infantil 3A", ["Léo", "Bia"]], ["vespertino", "Infantil 5C", ["Caio"]]];
  for (const [shift, className, names] of plan) {
    const [cls] = await query<{ id: string }>(`INSERT INTO classes (id, school_id, name, shift) VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id`, [SCHOOL, className, shift]);
    const [checkout] = await query<{ id: string }>(
      `INSERT INTO checkouts (id, school_id, guardian_id, service_day_id, shift, status, total_cents) VALUES (gen_random_uuid(), $1, $2, $3, $4, 'paid', $5) RETURNING id`,
      [SCHOOL, guardian!.id, day!.id, shift, 900 * names.length],
    );
    for (const [i, name] of names.entries()) {
      const [student] = await query<{ id: string }>(
        `INSERT INTO students (id, school_id, class_id, external_code, first_name) VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING id`,
        [SCHOOL, cls!.id, `T-${shift}-${i}`, name],
      );
      await query(`INSERT INTO guardian_students (school_id, guardian_id, student_id, financial) VALUES ($1, $2, $3, true)`, [SCHOOL, guardian!.id, student!.id]);
      const [order] = await query<{ id: string }>(
        `INSERT INTO orders (id, school_id, checkout_id, student_id, service_date, status) VALUES (gen_random_uuid(), $1, $2, $3, $4::date, 'confirmed') RETURNING id`,
        [SCHOOL, checkout!.id, student!.id, day!.date],
      );
      await query(`INSERT INTO order_items (id, school_id, order_id, menu_item_id, qty, unit_price_cents) VALUES (gen_random_uuid(), $1, $2, $3, 1, 900)`, [SCHOOL, order!.id, item!.id]);
      orders[shift]!.push(order!.id);
    }
  }
  await closeDay(day!.date);
  return { date: day!.date, morning: orders.matutino!, afternoon: orders.vespertino![0]! };
}

let data: Awaited<ReturnType<typeof seed>>;
test.beforeAll(async () => {
  data = await seed();
});

async function pair(page: Page, code: string, date: string): Promise<void> {
  await pairingCode(code);
  await page.goto(`/kds?date=${date}`);
  await page.getByTestId("kds-pair-code").fill(code);
  await page.getByTestId("kds-pair-submit").click();
}

test("shows one shift at a time, with Manhã and Tarde tabs", async ({ page }) => {
  await pair(page, "KDSTRN23", data.date);
  await expect(page.getByTestId("kds-shift-tab-matutino")).toHaveText("Manhã", { timeout: 20_000 });
  await expect(page.getByTestId(`kds-order-${data.morning[0]}`)).toBeVisible();
  await expect(page.getByTestId(`kds-order-${data.afternoon}`)).toHaveCount(0);
  await page.getByTestId("kds-shift-tab-vespertino").click();
  await expect(page.getByTestId(`kds-order-${data.afternoon}`)).toBeEnabled();
  await expect(page.getByTestId(`kds-order-${data.morning[0]}`)).toHaveCount(0);
});

test("a tablet still on the v2 database keeps its pending delivery after the upgrade to v3", async ({ browser }) => {
  const code = "KDSTRN45";
  await pairingCode(code);
  const eventId = randomUUID();
  const context = await browser.newContext({ timezoneId: "America/Sao_Paulo" });
  const page = await context.newPage();
  await page.route("**/e2e-blank", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>blank</title>" }));
  await page.goto("/e2e-blank");
  await page.evaluate(
    async ({ code, eventId, orderId, serviceDate }) => {
      const res = await fetch("/api/kds/v1/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
      if (!res.ok) throw new Error(`pair failed: ${res.status}`);
      const { deviceId } = (await res.json()) as { deviceId: string };
      const occurredAt = new Date().toISOString();
      await new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("app-lanche-kds", 20); // Dexie versão 2
        open.onupgradeneeded = () => {
          const db = open.result;
          db.createObjectStore("manifest", { keyPath: "serviceDate" });
          db.createObjectStore("orderState", { keyPath: "orderId" }).createIndex("serviceDate", "serviceDate");
          const outbox = db.createObjectStore("outbox", { keyPath: "eventId" });
          outbox.createIndex("occurredAt", "occurredAt");
          outbox.createIndex("serviceDate", "serviceDate");
          outbox.createIndex("kind", "kind");
          db.createObjectStore("meta", { keyPath: "key" });
          db.createObjectStore("roster", { keyPath: "studentId" }).createIndex("guardianId", "guardianId");
          db.createObjectStore("counterSales", { keyPath: "saleId" }).createIndex("serviceDate", "serviceDate");
        };
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction(["manifest", "orderState", "outbox", "meta"], "readwrite");
          tx.objectStore("meta").put({ key: "deviceId", value: deviceId });
          // Romaneio no formato da v2 (um por dia, sem turnos): o upgrade o descarta e baixa de novo.
          tx.objectStore("manifest").put({
            serviceDate, status: "closed", manifestVersion: 1, fetchedAt: occurredAt,
            content: { totals: { orders: 0, by_item: [] }, by_class: [], late_credits: 0 },
          });
          tx.objectStore("orderState").put({ orderId, serviceDate, state: "delivered", occurredAt, eventId });
          tx.objectStore("outbox").put({ eventId, orderId, type: "delivered", occurredAt, serviceDate, kind: "delivery" });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      });
    },
    { code, eventId, orderId: data.afternoon, serviceDate: data.date },
  );

  await page.goto(`/kds?date=${data.date}`);
  await page.getByTestId("kds-shift-tab-vespertino").click({ timeout: 20_000 });
  await expect(page.getByTestId(`kds-order-${data.afternoon}`)).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("kds-badge")).toHaveText(SYNCED, { timeout: 30_000 });
  const stored = await query<{ event_id: string }>(`SELECT event_id FROM delivery_events WHERE event_id = $1`, [eventId]);
  expect(stored).toHaveLength(1);
  const [order] = await query<{ status: string }>(`SELECT status FROM orders WHERE id = $1`, [data.afternoon]);
  expect(order!.status).toBe("delivered");
  await context.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @app-lanche/contracts test; pnpm app:down; docker compose down; pnpm --filter @app-lanche/api exec vitest run src/modules/kds; pnpm --filter @app-lanche/web exec vitest run src/areas/kds`
Expected: FAIL (`shifts` ausente no romaneio; a entrega da manhã é recusada porque hoje a regra olha o dia, ainda aberto; `ShiftBoard`/`mergeManifest`/`pickShift` não existem).

- [ ] **Step 3: Contracts** — em `packages/contracts/src/kds.ts`:

```ts
import { Shift, ShiftStatus } from "./shifts";

/** Turno no tablet: romaneio congelado (closed/finished) ou prévia dos confirmados (open). */
export const KdsShiftManifest = z.object({
  shift: Shift,
  status: ShiftStatus,
  manifestVersion: z.number().int().positive().nullable(),
  content: ManifestContent,
});
export type KdsShiftManifest = z.infer<typeof KdsShiftManifest>;

/** GET /api/kds/v1/manifest/:date — um item por turno do dia, matutino primeiro. */
export const KdsManifestResponse = z.object({ serviceDate: IsoDate, shifts: z.array(KdsShiftManifest).min(1) });
export type KdsManifestResponse = z.infer<typeof KdsManifestResponse>;
```

- [ ] **Step 4: API**

`serviceDays/service.ts`:

```ts
/** KDS: cada turno com o romaneio congelado ou, aberto, a prévia dos pedidos já confirmados. */
export async function kdsManifest(schoolId: string, serviceDate: string): Promise<KdsManifestResponse> {
  return withTenant(schoolId, async (trx) => {
    const day = await catalog.lockServiceDayByDate(trx, serviceDate, "share");
    if (!day) throw new DomainError("not_found");
    const shifts: KdsShiftManifest[] = [];
    for (const turn of await catalog.listShifts(trx, day.id)) {
      if (turn.status === "open") {
        const content = buildManifest(await repo.manifestLines(trx, day.id, turn.shift), await orders.countLateCredited(trx, day.id, turn.shift));
        shifts.push({ shift: turn.shift, status: "open", manifestVersion: null, content });
      } else {
        const manifest = await repo.readManifest(trx, day.id, turn.shift);
        shifts.push({ shift: turn.shift, status: turn.status, manifestVersion: manifest.version, content: JSON.parse(manifest.content) as ManifestContent });
      }
    }
    return { serviceDate, shifts };
  });
}
```

`kds/repo.ts` — `deliverableOrders` trava os dias e depois os turnos (`FOR SHARE`) e decide pelo turno:

```ts
/** Pedidos do lote que aceitam entrega: turno fechado, estado confirmado ou entregue. Trava dias e turnos (FOR SHARE) antes. */
export async function deliverableOrders(trx: Trx, orderIds: string[]): Promise<Set<string>> {
  if (orderIds.length === 0) return new Set();
  await sql`
    SELECT d.id FROM service_days d
    WHERE d.id IN (SELECT c.service_day_id FROM orders o JOIN checkouts c ON c.id = o.checkout_id WHERE o.id = ANY(${orderIds}::uuid[]))
    ORDER BY d.id FOR SHARE`.execute(trx);
  await sql`
    SELECT sh.id FROM service_day_shifts sh
    WHERE (sh.service_day_id, sh.shift) IN (
      SELECT c.service_day_id, c.shift FROM orders o JOIN checkouts c ON c.id = o.checkout_id WHERE o.id = ANY(${orderIds}::uuid[]))
    ORDER BY sh.service_day_id, sh.shift FOR SHARE`.execute(trx);
  const { rows } = await sql<{ id: string }>`
    SELECT o.id FROM orders o
    JOIN checkouts c ON c.id = o.checkout_id
    JOIN service_day_shifts sh ON sh.service_day_id = c.service_day_id AND sh.shift = c.shift
    WHERE o.id = ANY(${orderIds}::uuid[]) AND sh.status = 'closed' AND o.status IN ('confirmed', 'delivered')
    ORDER BY o.id FOR UPDATE OF o`.execute(trx);
  return new Set(rows.map((r) => r.id));
}
```

- [ ] **Step 5: Tablet — Dexie versão 3 e helpers**

`apps/web/src/areas/kds/db.ts`: `ManifestRow` continua `KdsManifestResponse & { fetchedAt: string }` (o tipo muda com o contrato). Depois da `version(2)`:

```ts
    // v3 (F5C, turnos): mesmos stores e chaves; o romaneio passa a ter um item por turno. O conteúdo antigo é cache e
    // não serve mais: o upgrade o descarta e a próxima sincronização baixa de novo. A outbox fica intacta.
    this.version(3)
      .stores({
        manifest: "serviceDate",
        orderState: "orderId, serviceDate",
        outbox: "eventId, occurredAt, serviceDate, kind",
        meta: "key",
        roster: "studentId, guardianId",
        counterSales: "saleId, serviceDate",
      })
      .upgrade((tx) => tx.table("manifest").clear());
```

`apps/web/src/areas/kds/state.ts`:

```ts
import type { KdsManifestResponse, Shift, ShiftStatus } from "@app-lanche/contracts";

const RANK: Record<ShiftStatus, number> = { open: 0, closed: 1, finished: 2 };

/** Romaneio do servidor sobre o local: um turno nunca volta a um estado anterior (finalizar offline ainda não enviado). */
export function mergeManifest(local: KdsManifestResponse | undefined, server: KdsManifestResponse): KdsManifestResponse {
  return {
    serviceDate: server.serviceDate,
    shifts: server.shifts.map((s) => {
      const mine = local?.shifts.find((l) => l.shift === s.shift);
      return mine && RANK[mine.status] > RANK[s.status] ? { ...s, status: mine.status } : s;
    }),
  };
}

/** Turno na tela: o escolhido; senão o primeiro ainda não finalizado; senão o primeiro. */
export function pickShift<T extends { shift: Shift; status: ShiftStatus }>(shifts: T[], selected: Shift | null): T | undefined {
  return shifts.find((s) => s.shift === selected) ?? shifts.find((s) => s.status !== "finished") ?? shifts[0];
}
```

`apps/web/src/areas/kds/sync.ts` — `pullManifest`:

```ts
async function pullManifest(serviceDate: string, deviceId: string): Promise<void> {
  const current = await kdsDb.manifest.get(serviceDate);
  // Com todos os turnos finalizados nada mais muda no romaneio (regra 18).
  if (current?.shifts.every((s) => s.status === "finished")) return;
  try {
    const res = await apiFetch(`/api/kds/v1/manifest/${serviceDate}`, KdsManifestResponse);
    if (!(await stillPaired(deviceId))) return;
    await kdsDb.transaction("rw", kdsDb.manifest, kdsDb.meta, async () => {
      const local = await kdsDb.manifest.get(serviceDate);
      await kdsDb.manifest.put({ ...mergeManifest(local, res), fetchedAt: new Date().toISOString() });
      await kdsDb.meta.delete(`noService:${serviceDate}`);
    });
  } catch (err) {
    // … ramo 404 igual ao atual …
  }
}
```

- [ ] **Step 6: Tablet — `ShiftBoard` e abas**

`apps/web/src/areas/kds/ShiftBoard.tsx` recebe o quadro de um turno, movido de `KdsBoard` (filtros, aviso de prévia, totais e cartões):

```tsx
import type { KdsShiftManifest } from "@app-lanche/contracts";
import { useEffect, useState, type ReactNode } from "react";
import { Nav, NavItem, NavLink } from "reactstrap";
import { validClassFilter, visibleGroups, type StateFilter } from "./filters";

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

type Props = {
  shift: KdsShiftManifest;
  delivered: ReadonlySet<string>;
  onTap: (orderId: string, delivered: boolean) => void;
};

/** Quadro de entregas de um turno. Só tela: lê as props, nunca o IndexedDB nem a API (regra 32). */
export function ShiftBoard({ shift, delivered, onTap }: Props) {
  const [classFilter, setClassFilter] = useState<string | null>(null);
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const content = shift.content;
  const classes = content.by_class.map((c) => c.class);
  const classList = classes.join("\n");
  useEffect(() => {
    setClassFilter((current) => validClassFilter(current, classList.split("\n")));
  }, [classList]);
  const groups = visibleGroups(content.by_class, delivered, { className: classFilter, state: stateFilter });
  const open = shift.status === "open";

  return (
    <>
      {open && (
        <div className="alert alert-warning" data-testid="kds-waiting">
          Prévia parcial — aguardando fechamento. As entregas podem ser marcadas depois do fechamento.
        </div>
      )}
      <p className="fs-5 fw-semibold mb-3">
        {content.totals.orders} pedidos · {content.totals.by_item.map((i) => `${i.qty}x ${i.item}`).join(" · ")}
      </p>
      {/* filtros "Filtrar por turma" e "Filtrar por entrega": o JSX atual de KdsBoard, sem mudança */}
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
                    disabled={open}
                    onClick={() => onTap(o.order_id, !isDelivered)}
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
  );
}
```

(Copie os dois `<div role="group" …>` de filtros de `KdsBoard.tsx` para o lugar do comentário, sem mudar texto.)

`KdsBoard.tsx`: saem `STATE_FILTERS`, `FilterPill`, os estados `classFilter`/`stateFilter`, o `useEffect` do filtro e o JSX movido. Entram:

```tsx
  const [selectedShift, setSelectedShift] = useState<Shift | null>(null);
  const current = manifest ? pickShift(manifest.shifts, selectedShift) : undefined;
  const tabs = manifest && manifest.shifts.length > 1 ? manifest.shifts : [];
```

e, dentro de `view === "board"`, no lugar dos blocos `manifest && !closed` e `manifest && (…)`:

```tsx
        {tabs.length > 0 && (
          <Nav pills className="mb-3" role="group" aria-label="Turno">
            {tabs.map((s) => (
              <NavItem key={s.shift}>
                <NavLink
                  tag="button"
                  type="button"
                  data-testid={`kds-shift-tab-${s.shift}`}
                  active={current?.shift === s.shift}
                  aria-pressed={current?.shift === s.shift}
                  onClick={() => setSelectedShift(s.shift)}
                >
                  {SHIFT_LABELS[s.shift]}
                </NavLink>
              </NavItem>
            ))}
          </Nav>
        )}
        {current && <ShiftBoard key={current.shift} shift={current} delivered={delivered} onTap={(id, d) => void tap(id, d)} />}
```

(`closed` e `classes` deixam de existir em `KdsBoard`; os blocos "Não há serviço…" e "Carregando o romaneio…" ficam.)

- [ ] **Step 7: Specs (regra 23).** Na spec F5C, B.3, acrescente o exemplo do teste de contrato:

````markdown
`GET /api/kds/v1/manifest/{date}` devolve um item por turno (matutino primeiro); turno aberto traz a prévia:

```json
{ "serviceDate": "2026-11-23",
  "shifts": [
    { "shift": "matutino", "status": "closed", "manifestVersion": 1,
      "content": { "totals": { "orders": 1, "by_item": [{ "item": "Misto quente", "qty": 1 }] },
                   "by_class": [{ "class": "Infantil 3A", "orders": [{ "order_id": "0193…", "student": "Léo", "items": ["Misto quente"], "restrictions": null }] }],
                   "late_credits": 0 } },
    { "shift": "vespertino", "status": "open", "manifestVersion": null,
      "content": { "totals": { "orders": 0, "by_item": [] }, "by_class": [], "late_credits": 0 } } ] }
```

No tablet, o Dexie vai para a versão 3: mesmo store `manifest` (chave `serviceDate`), agora com os turnos; o upgrade descarta o romaneio antigo e mantém a outbox.
````

Na spec principal, 7.2, a linha do store `manifest` passa a "Romaneio da data, um item por turno (estado e versão de cada um)".

- [ ] **Step 8: Run tests and checks**

Run: `pnpm app:down; docker compose down; pnpm --filter @app-lanche/contracts test && pnpm test:api && pnpm --filter @app-lanche/web test && pnpm typecheck && pnpm lint`, depois `pnpm db:up && pnpm test:e2e; docker compose down`
Expected: PASS (inclusive `kds.spec.ts` e `counter.spec.ts` antigos, com um turno só e sem abas).

- [ ] **Step 9: Commit**

```bash
git add packages/contracts/src/kds.ts packages/contracts/src/kds.test.ts apps/api/src/modules/serviceDays/service.ts \
  apps/api/src/modules/kds/repo.ts apps/api/src/modules/kds/sync.test.ts apps/web/src/areas/kds e2e/shifts.spec.ts \
  docs/superpowers/specs/2026-11-20-admin-turnos-avisos-design.md docs/superpowers/specs/2026-11-16-app-lanche-design.md
git commit -m "feat(kds): manifest per shift, shift tabs and Dexie v3"
```

---

### Task 8: "Finalizar turno" na API (tablet e secretaria)

**Files:**
- Modify: `packages/contracts/src/{kds.ts,shifts.ts,errors.ts}`, `kds.test.ts`
- Modify: `apps/api/src/platform/errors.ts` (`shift_not_closed: 409`)
- Modify: `apps/api/src/modules/catalog/{repo,service}.ts` (`markShiftFinished`)
- Modify: `apps/api/src/modules/orders/{repo,service}.ts` (`markNotCollected`, `countNotCollected`)
- Modify: `apps/api/src/modules/serviceDays/{service,routes}.ts` (`finishShiftInTrx`, `finishShift`, rota)
- Modify: `apps/api/src/modules/kds/{repo,service}.ts`
- Create: `apps/api/src/modules/kds/finish.test.ts`
- Modify: `apps/web/src/areas/admin/ServiceDaysAdmin.tsx` ("Finalizar turno"), `catalogAdmin.test.tsx`; `apps/web/src/ui/messages.ts`
- Modify: `docs/superpowers/specs/2026-11-20-admin-turnos-avisos-design.md` (B.3: exemplo do evento), `docs/superpowers/specs/2026-11-16-app-lanche-design.md` (5.2: estado `not_collected`; 7.3: tipo `shift_finished`)

**Interfaces:**
- Consumes: `catalog.lockShift`, `catalog.lockServiceDayByDate/ById` (Task 3); `closeShift` (Task 6); `deliverableOrders` por turno (Task 7).
- Produces (contracts):
  ```ts
  export const KdsDeliveryEvent = z.object({ eventId: Uuid, orderId: Uuid, type: DeliveryEventType, occurredAt: IsoDateTime });
  export const KdsShiftFinishedEvent = z.object({ eventId: Uuid, type: z.literal("shift_finished"), serviceDate: IsoDate, shift: Shift, occurredAt: IsoDateTime });
  export const KdsEvent = z.union([KdsDeliveryEvent, KdsShiftFinishedEvent]); // KdsEventsRequest = { events: KdsEvent[] (1..100) }
  export const KdsChangeEvent = KdsDeliveryEvent.extend({ deviceId: Uuid });
  export const FinishShiftResponse = z.object({ shift: Shift, status: z.literal("finished"), notCollectedOrders: z.number().int().nonnegative() }); // em shifts.ts
  ```
  Erro novo `shift_not_closed` (409).
- Produces (`serviceDays/service.ts`):
  ```ts
  export type FinishActor = { kind: "kitchen"; deviceId: string } | { kind: "staff"; staffUserId: string } | { kind: "system" };
  export type FinishOutcome = "finished" | "already_finished" | "not_closed" | "not_found";
  /** Trava dia (FOR SHARE) e turno (FOR UPDATE); closed → finished; confirmed → not_collected. */
  export async function finishShiftInTrx(trx: Trx, schoolId: string, serviceDayId: string, shift: Shift, actor: FinishActor): Promise<FinishOutcome>;
  export async function finishShift(session: SessionClaims, serviceDate: string, shift: Shift): Promise<FinishShiftResponse>;
  ```
- Produces (rota): `POST /api/admin/v1/service-days/:date/shifts/:shift/finish` (`OFFICE`, naturalmente idempotente) → `FinishShiftResponse`; `POST /api/kds/v1/events` aceita `shift_finished`.
- Produces (`orders/service.ts`): `markNotCollected(trx, serviceDayId, shift): Promise<number>`, `countNotCollected(trx, serviceDayId, shift): Promise<number>`.

- [ ] **Step 1: Write the failing tests**

`packages/contracts/src/kds.test.ts` (acrescente):

```ts
  it("accepts the shift_finished example from spec F5C B.3 next to deliveries", () => {
    const finish = { eventId: "0193a3b0-0000-7000-8000-0000000000f1", type: "shift_finished", serviceDate: "2026-11-23", shift: "matutino", occurredAt: "2026-11-23T12:10:00.000Z" };
    const delivery = { eventId: "0193a3b0-0000-7000-8000-0000000000f2", orderId: "0193a3b0-0000-7000-8000-000000000001", type: "delivered", occurredAt: "2026-11-23T12:05:00.000Z" };
    expect(KdsEventsRequest.parse({ events: [delivery, finish] })).toEqual({ events: [delivery, finish] });
    expect(() => KdsEventsRequest.parse({ events: [{ ...finish, shift: "noite" }] })).toThrow();
    expect(() => KdsEventsRequest.parse({ events: [{ ...finish, type: "delivered" }] })).toThrow();
  });
```

`apps/api/src/modules/kds/finish.test.ts`:

```ts
import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { describe, expect, it } from "vitest";
import { adminDb, createSchool, kitchenCookie, seedConfirmedOrders, seedServiceDay, staffCookie } from "../../../test/helpers";
import { buildApp } from "../../app";
import { closeShift } from "../serviceDays/service";

const log = { warn: () => undefined, info: () => undefined, error: () => undefined } as never;
const BASE_MS = Date.now() - 60 * 60_000;
const t = (seconds: number) => new Date(BASE_MS + seconds * 1000).toISOString();
const deliver = (orderId: string, at: string, type: "delivered" | "undelivered" = "delivered") => ({ eventId: uuidv7(), orderId, type, occurredAt: at });
const finish = (serviceDate: string, shift: "matutino" | "vespertino", at: string, eventId = uuidv7()) => ({ eventId, type: "shift_finished" as const, serviceDate, shift, occurredAt: at });

/** Manhã fechada com 3 pedidos (Léo, Bia, Caio) e tarde aberta. */
async function closedMorning(serviceDate: string) {
  const schoolId = await createSchool();
  const day = await seedServiceDay(schoolId, { serviceDate, shifts: { matutino: -30, vespertino: 120 } });
  const { orderIds } = await seedConfirmedOrders(schoolId, { serviceDayId: day.serviceDayId, serviceDate, menuItemId: day.items[0]!.id, studentNames: ["Léo", "Bia", "Caio"] });
  await closeShift(schoolId, serviceDate, "matutino", { log, reconcile: false });
  return { schoolId, day, orderIds };
}

const statuses = async (ids: string[]) =>
  Object.fromEntries((await adminDb().selectFrom("orders").select(["id", "status"]).where("id", "in", ids).execute()).map((o) => [o.id, o.status]));

const post = (cookies: Record<string, string>, events: unknown[]) =>
  buildApp().inject({ method: "POST", url: "/api/kds/v1/events", cookies, payload: { events } });

describe("finish shift from the tablet", () => {
  it("finishes the shift once and turns the undelivered orders into not collected", async () => {
    const { schoolId, day, orderIds } = await closedMorning("2031-12-01");
    const [leo, bia, caio] = orderIds as [string, string, string];
    const { cookies, deviceId } = await kitchenCookie(schoolId);
    const d = deliver(leo, t(0));
    const f = finish(day.serviceDate, "matutino", t(10));
    const res = await post(cookies, [d, f]);
    expect(res.json()).toEqual({ accepted: [d.eventId, f.eventId], rejected: [] });
    expect(await statuses(orderIds)).toEqual({ [leo]: "delivered", [bia]: "not_collected", [caio]: "not_collected" });
    const shift = await adminDb().selectFrom("serviceDayShifts").selectAll().where("id", "=", day.shiftIds.matutino!).executeTakeFirstOrThrow();
    expect(shift).toMatchObject({ status: "finished", finishedByDeviceId: deviceId, finishedByStaffId: null });
    expect(shift.finishedAt).not.toBeNull();
    const afternoon = await adminDb().selectFrom("serviceDayShifts").select("status").where("id", "=", day.shiftIds.vespertino!).executeTakeFirstOrThrow();
    expect(afternoon.status).toBe("open");
    const audit = await adminDb().selectFrom("auditLog").select(sql<string>`detail::text`.as("detail")).where("schoolId", "=", schoolId).where("action", "=", "shift.finished").execute();
    expect(audit.map((a) => JSON.parse(a.detail))).toEqual([{ service_day_id: day.serviceDayId, shift: "matutino", not_collected: 2 }]);
  });

  it("is idempotent by event id and when a second tablet also finishes", async () => {
    const { schoolId, day, orderIds } = await closedMorning("2031-12-02");
    const one = await kitchenCookie(schoolId);
    const two = await kitchenCookie(schoolId);
    const f1 = finish(day.serviceDate, "matutino", t(0));
    expect((await post(one.cookies, [f1])).json().accepted).toEqual([f1.eventId]);
    expect((await post(one.cookies, [f1])).json().accepted).toEqual([f1.eventId]);
    const f2 = finish(day.serviceDate, "matutino", t(5));
    expect((await post(two.cookies, [f2])).json().accepted).toEqual([f2.eventId]);
    const events = await adminDb().selectFrom("shiftEvents").select("eventId").where("schoolId", "=", schoolId).execute();
    expect(events.map((e) => e.eventId).sort()).toEqual([f1.eventId, f2.eventId].sort());
    const shift = await adminDb().selectFrom("serviceDayShifts").select("finishedByDeviceId").where("id", "=", day.shiftIds.matutino!).executeTakeFirstOrThrow();
    expect(shift.finishedByDeviceId).toBe(one.deviceId);
    expect(Object.values(await statuses(orderIds))).toEqual(["not_collected", "not_collected", "not_collected"]);
    const audits = await adminDb().selectFrom("auditLog").select("id").where("schoolId", "=", schoolId).where("action", "=", "shift.finished").execute();
    expect(audits).toHaveLength(1);
  });

  it("rejects finishing an open or unknown shift and an event from the future", async () => {
    const { schoolId, day } = await closedMorning("2031-12-03");
    const { cookies } = await kitchenCookie(schoolId);
    const open = finish(day.serviceDate, "vespertino", t(0));
    const unknown = finish("2031-12-31", "matutino", t(0));
    const ahead = finish(day.serviceDate, "matutino", new Date(Date.now() + 10 * 60_000).toISOString());
    expect((await post(cookies, [open, unknown, ahead])).json()).toEqual({ accepted: [], rejected: [open.eventId, unknown.eventId, ahead.eventId] });
    const shift = await adminDb().selectFrom("serviceDayShifts").select("status").where("id", "=", day.shiftIds.matutino!).executeTakeFirstOrThrow();
    expect(shift.status).toBe("closed");
    expect(await adminDb().selectFrom("shiftEvents").select("eventId").where("schoolId", "=", schoolId).execute()).toEqual([]);
  });

  it("still accepts a delivery recorded offline before the finish, and an undelivery puts it back to not collected", async () => {
    const { schoolId, day, orderIds } = await closedMorning("2031-12-04");
    const [leo] = orderIds as [string];
    const { cookies } = await kitchenCookie(schoolId);
    await post(cookies, [finish(day.serviceDate, "matutino", t(10))]);
    expect((await statuses([leo]))[leo]).toBe("not_collected");
    const late = deliver(leo, t(5)); // outro tablet, sem rede, entregou antes da finalização
    expect((await post(cookies, [late])).json().accepted).toEqual([late.eventId]);
    expect((await statuses([leo]))[leo]).toBe("delivered");
    const undo = deliver(leo, t(20), "undelivered");
    expect((await post(cookies, [undo])).json().accepted).toEqual([undo.eventId]);
    expect((await statuses([leo]))[leo]).toBe("not_collected");
  });

  it("never leaves an order confirmed when deliveries race the finish", async () => {
    const schoolId = await createSchool();
    const day = await seedServiceDay(schoolId, { serviceDate: "2031-12-05", shifts: { matutino: -30 } });
    const names = Array.from({ length: 10 }, (_, i) => `Aluno${i}`);
    const { orderIds } = await seedConfirmedOrders(schoolId, { serviceDayId: day.serviceDayId, serviceDate: day.serviceDate, menuItemId: day.items[0]!.id, studentNames: names });
    await closeShift(schoolId, day.serviceDate, "matutino", { log, reconcile: false });
    const a = await kitchenCookie(schoolId);
    const b = await kitchenCookie(schoolId);
    const deliveries = orderIds.slice(0, 5).map((id, i) => post(a.cookies, [deliver(id, t(i))]));
    const settled = await Promise.allSettled([...deliveries, post(b.cookies, [finish(day.serviceDate, "matutino", t(3))])]);
    expect(settled.every((r) => r.status === "fulfilled" && r.value.statusCode === 200)).toBe(true);
    const after = await statuses(orderIds);
    for (const id of orderIds.slice(0, 5)) expect(after[id]).toBe("delivered");
    for (const id of orderIds.slice(5)) expect(after[id]).toBe("not_collected");
  });
});

describe("finish shift from the admin", () => {
  it("finishes a closed shift, repeats without effect and refuses an open one", async () => {
    const { schoolId, day } = await closedMorning("2031-12-06");
    const { cookies, staffUserId } = await staffCookie(schoolId, "secretaria");
    const app = buildApp();
    const url = (shift: string) => `/api/admin/v1/service-days/${day.serviceDate}/shifts/${shift}/finish`;
    const open = await app.inject({ method: "POST", url: url("vespertino"), cookies });
    expect(open.statusCode).toBe(409);
    expect(open.json().error.code).toBe("shift_not_closed");
    const first = await app.inject({ method: "POST", url: url("matutino"), cookies });
    expect(first.json()).toEqual({ shift: "matutino", status: "finished", notCollectedOrders: 3 });
    expect((await app.inject({ method: "POST", url: url("matutino"), cookies })).json()).toEqual(first.json());
    const shift = await adminDb().selectFrom("serviceDayShifts").select(["finishedByStaffId", "finishedByDeviceId"]).where("id", "=", day.shiftIds.matutino!).executeTakeFirstOrThrow();
    expect(shift).toEqual({ finishedByStaffId: staffUserId, finishedByDeviceId: null });
    const kitchen = await staffCookie(schoolId, "cozinha");
    expect((await app.inject({ method: "POST", url: url("matutino"), cookies: kitchen.cookies })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/api/admin/v1/service-days/2031-01-01/shifts/matutino/finish`, cookies })).statusCode).toBe(404);
  });
});
```

Web — em `catalogAdmin.test.tsx` (acrescente):

```tsx
  it("finishes a closed shift after confirming", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    const closedDay = { ...OPEN_DAY, shifts: [{ ...OPEN_DAY.shifts[0], status: "closed" }] };
    const fn = mockApi({
      ...BASE,
      "GET /api/admin/v1/me": me("secretaria"),
      "GET /api/admin/v1/service-days": { status: 200, body: { serviceDays: [closedDay] } },
      "POST /api/admin/v1/service-days/2030-03-04/shifts/matutino/finish": { status: 200, body: { shift: "matutino", status: "finished", notCollectedOrders: 2 } },
    });
    renderAdmin("/admin/lanche/dias");
    expect(await screen.findByText("Fechado (romaneio pronto)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Finalizar turno — Manhã" }));
    expect(window.confirm).toHaveBeenCalledWith("Finalizar o turno da manhã? Os pedidos ainda não entregues passam a \"não retirado\".");
    await waitFor(() => expect(callOf(fn, "POST /api/admin/v1/service-days/2030-03-04/shifts/matutino/finish")).toBeDefined());
    expect(await screen.findByText("Turno da manhã finalizado: 2 não retirados.")).toBeTruthy();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @app-lanche/contracts test; pnpm app:down; docker compose down; pnpm --filter @app-lanche/api exec vitest run src/modules/kds; pnpm --filter @app-lanche/web exec vitest run src/areas/admin/catalogAdmin.test.tsx`
Expected: FAIL (`shift_finished` recusado pelo schema; rota 404; botão ausente).

- [ ] **Step 3: Contracts and errors**

`packages/contracts/src/kds.ts` — `KdsEvent` vira a união do bloco Interfaces (com `KdsDeliveryEvent` e `KdsShiftFinishedEvent` exportados e seus tipos); `KdsChangeEvent = KdsDeliveryEvent.extend({ deviceId: Uuid })`; `KdsEventsRequest` não muda de forma. `packages/contracts/src/shifts.ts` ganha `FinishShiftResponse`. `errors.ts`: `"shift_not_closed"` depois de `"shift_not_offered"`; `platform/errors.ts`: `shift_not_closed: 409`. `apps/web/src/ui/messages.ts`: `STAFF_MESSAGES.shift_not_closed = "O turno precisa estar fechado (romaneio pronto) para ser finalizado."`.

- [ ] **Step 4: API**

`catalog/repo.ts`:

```ts
/** closed → finished (regra 12): sem linha atualizada, outro tablet, a secretaria ou o job já finalizou. */
export async function markShiftFinished(trx: Trx, shiftId: string, by: { deviceId: string | null; staffUserId: string | null }): Promise<boolean> {
  const row = await trx
    .updateTable("serviceDayShifts")
    .set({ status: "finished", finishedAt: sql<Date>`now()`, finishedByDeviceId: by.deviceId, finishedByStaffId: by.staffUserId })
    .where("id", "=", shiftId)
    .where("status", "=", "closed")
    .returning("id")
    .executeTakeFirst();
  return row !== undefined;
}
```

(`catalog/service.ts`: `export const markShiftFinished = repo.markShiftFinished;`)

`orders/repo.ts` e `orders/service.ts` (o serviço só reexporta):

```ts
/** Pedidos confirmados (sem entrega) de um turno finalizado → not_collected. */
export async function markNotCollected(trx: Trx, serviceDayId: string, shift: Shift): Promise<number> {
  const res = await sql`
    UPDATE orders o SET status = 'not_collected'
    FROM checkouts c
    WHERE c.id = o.checkout_id AND c.service_day_id = ${serviceDayId} AND c.shift = ${shift} AND o.status = 'confirmed'`.execute(trx);
  return Number(res.numAffectedRows ?? 0);
}

export async function countNotCollected(trx: Trx, serviceDayId: string, shift: Shift): Promise<number> {
  const { rows } = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM orders o JOIN checkouts c ON c.id = o.checkout_id
    WHERE c.service_day_id = ${serviceDayId} AND c.shift = ${shift} AND o.status = 'not_collected'`.execute(trx);
  return rows[0]!.n;
}
```

`serviceDays/service.ts`:

```ts
export type FinishActor = { kind: "kitchen"; deviceId: string } | { kind: "staff"; staffUserId: string } | { kind: "system" };
export type FinishOutcome = "finished" | "already_finished" | "not_closed" | "not_found";

/**
 * "Finalizar turno" (spec F5C, B.3). Travas: service_days FOR SHARE → service_day_shifts FOR UPDATE → orders.
 * Entregas travam o turno FOR SHARE: nunca se intercalam com a finalização.
 */
export async function finishShiftInTrx(trx: Trx, schoolId: string, serviceDayId: string, shift: Shift, actor: FinishActor): Promise<FinishOutcome> {
  await catalog.lockServiceDayById(trx, serviceDayId, "share");
  const turn = await catalog.lockShift(trx, serviceDayId, shift, "update");
  if (!turn) return "not_found";
  if (turn.status === "open") return "not_closed";
  const by = {
    deviceId: actor.kind === "kitchen" ? actor.deviceId : null,
    staffUserId: actor.kind === "staff" ? actor.staffUserId : null,
  };
  if (!(await catalog.markShiftFinished(trx, turn.id, by))) return "already_finished";
  const notCollected = await orders.markNotCollected(trx, serviceDayId, shift);
  await audit(trx, {
    schoolId,
    actorKind: actor.kind,
    actorId: by.deviceId ?? by.staffUserId,
    action: "shift.finished",
    detail: { service_day_id: serviceDayId, shift, not_collected: notCollected },
  });
  return "finished";
}

export async function finishShift(session: SessionClaims, serviceDate: string, shift: Shift): Promise<FinishShiftResponse> {
  return withTenant(session.schoolId, async (trx) => {
    const day = await catalog.lockServiceDayByDate(trx, serviceDate, "share");
    if (!day) throw new DomainError("not_found");
    const outcome = await finishShiftInTrx(trx, session.schoolId, day.id, shift, { kind: "staff", staffUserId: session.sub });
    if (outcome === "not_found") throw new DomainError("not_found");
    if (outcome === "not_closed") throw new DomainError("shift_not_closed");
    return { shift, status: "finished", notCollectedOrders: await orders.countNotCollected(trx, day.id, shift) };
  });
}
```

(`audit` vem de `../../platform/audit`; `SessionClaims` de `../../platform/session`. O `actorKind` `"kitchen"` e `"system"` já existem no `CHECK` de `audit_log`.)

`serviceDays/routes.ts`:

```ts
  // Naturalmente idempotente (closed → finished uma vez; repetir só relê): sem Idempotency-Key.
  app.post("/api/admin/v1/service-days/:date/shifts/:shift/finish", { config: { auth: OFFICE } }, async (req) => {
    const p = ShiftParams.parse(req.params);
    return service.finishShift(req.session!, p.date, p.shift);
  });
```

`kds/repo.ts`:
- `deliverableOrders`: `sh.status IN ('closed', 'finished') AND o.status IN ('confirmed', 'delivered', 'not_collected')`;
- `applyLatestState`:

```ts
/**
 * Aplica o evento vencedor (maior occurred_at, empate pelo maior event_id). Entregue → delivered, inclusive depois de
 * finalizar (not_collected → delivered). Desfeito → confirmed, ou not_collected se o turno já foi finalizado.
 */
export async function applyLatestState(trx: Trx, orderIds: string[]): Promise<void> {
  if (orderIds.length === 0) return;
  await sql`
    WITH latest AS (
      SELECT DISTINCT ON (order_id) order_id, type
      FROM delivery_events
      WHERE order_id = ANY(${orderIds}::uuid[])
      ORDER BY order_id, occurred_at DESC, event_id DESC
    )
    UPDATE orders o
    SET status = CASE WHEN l.type = 'delivered' THEN 'delivered' WHEN sh.status = 'finished' THEN 'not_collected' ELSE 'confirmed' END
    FROM latest l, checkouts c, service_day_shifts sh
    WHERE o.id = l.order_id AND c.id = o.checkout_id AND sh.service_day_id = c.service_day_id AND sh.shift = c.shift
      AND ((l.type = 'delivered' AND o.status IN ('confirmed', 'not_collected')) OR (l.type = 'undelivered' AND o.status = 'delivered'))`.execute(trx);
}
```

- e os gravadores do evento de turno:

```ts
/** Grava o shift_finished (PK = event_id, regra 36). Devolve se o evento existe nesta escola depois do insert. */
export async function insertShiftEvent(
  trx: Trx,
  row: { eventId: string; schoolId: string; serviceDayShiftId: string; deviceId: string; occurredAt: string },
): Promise<boolean> {
  await trx
    .insertInto("shiftEvents")
    .values({ ...row, type: "shift_finished", occurredAt: new Date(row.occurredAt) })
    .onConflict((oc) => oc.column("eventId").doNothing())
    .execute();
  return (await trx.selectFrom("shiftEvents").select("eventId").where("eventId", "=", row.eventId).executeTakeFirst()) !== undefined;
}

export async function shiftEventExists(trx: Trx, eventId: string): Promise<boolean> {
  return (await trx.selectFrom("shiftEvents").select("eventId").where("eventId", "=", eventId).executeTakeFirst()) !== undefined;
}
```

`kds/service.ts` — `recordEvents` separa as entregas (lógica atual, numa transação) dos `shift_finished` (uma transação cada, depois):

```ts
type DeliveryInput = Extract<KdsEvent, { orderId: string }>;
type FinishInput = Extract<KdsEvent, { type: "shift_finished" }>;

async function recordDeliveries(schoolId: string, deviceId: string, events: DeliveryInput[]): Promise<Set<string>> {
  if (events.length === 0) return new Set();
  return withTenant(schoolId, async (trx) => {
    // … corpo atual de recordEvents (relógio, deliverableOrders, insertEvents, existingEventIds, applyLatestState) …
    return present; // ids aceitos
  });
}

/** shift_finished: repetido → aceito; turno inexistente, aberto ou evento do futuro → recusado. */
async function recordShiftFinished(schoolId: string, deviceId: string, ev: FinishInput): Promise<boolean> {
  return withTenant(schoolId, async (trx) => {
    if (await repo.shiftEventExists(trx, ev.eventId)) return true;
    if (Date.parse(ev.occurredAt) > (await repo.dbNow(trx)).getTime() + MAX_CLOCK_AHEAD_MS) return false;
    const day = await catalog.lockServiceDayByDate(trx, ev.serviceDate, "share");
    if (!day) return false;
    const turn = await catalog.lockShift(trx, day.id, ev.shift, "update");
    if (!turn || turn.status === "open") return false;
    if (!(await repo.insertShiftEvent(trx, { eventId: ev.eventId, schoolId, serviceDayShiftId: turn.id, deviceId, occurredAt: ev.occurredAt }))) return false;
    await serviceDays.finishShiftInTrx(trx, schoolId, day.id, ev.shift, { kind: "kitchen", deviceId });
    return true;
  });
}

export async function recordEvents(schoolId: string, deviceId: string, body: KdsEventsRequest): Promise<KdsEventsResponse> {
  const deliveries = body.events.filter((e): e is DeliveryInput => e.type !== "shift_finished");
  const finishes = body.events.filter((e): e is FinishInput => e.type === "shift_finished");
  // Entregas antes da finalização, cada parte na sua transação (o turno não é promovido de SHARE para UPDATE).
  const ok = await recordDeliveries(schoolId, deviceId, deliveries);
  for (const f of finishes) if (await recordShiftFinished(schoolId, deviceId, f)) ok.add(f.eventId);
  return {
    accepted: body.events.filter((e) => ok.has(e.eventId)).map((e) => e.eventId),
    rejected: body.events.filter((e) => !ok.has(e.eventId)).map((e) => e.eventId),
  };
}
```

(`kds/service.ts` passa a importar `* as catalog from "../catalog/service"` e `* as serviceDays from "../serviceDays/service"`; não há ciclo: `serviceDays` não importa `kds`.)

- [ ] **Step 5: Admin** — em `ServiceDaysAdmin.tsx`, na linha de cada turno, ao lado do badge:

```tsx
                          {s.status === "closed" && (
                            <Button size="sm" outline color="secondary" type="button" disabled={busy} onClick={() => finishShift(d, s.shift)}>
                              Finalizar turno<span className="visually-hidden">{` — ${SHIFT_LABELS[s.shift]}`}</span>
                            </Button>
                          )}
```

```ts
  async function finishShift(day: ServiceDay, shift: Shift) {
    const name = SHIFT_LABELS[shift].toLowerCase();
    if (!window.confirm(`Finalizar o turno da ${name}? Os pedidos ainda não entregues passam a "não retirado".`)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiFetch(`/api/admin/v1/service-days/${day.serviceDate}/shifts/${shift}/finish`, FinishShiftResponse, { method: "POST" });
      const message = `Turno da ${name} finalizado: ${res.notCollectedOrders} não retirados.`;
      setNotice(message);
      announce(message);
      await reload();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }
```

- [ ] **Step 6: Specs (regra 23).** Na spec F5C, B.3, depois do item do `POST /api/kds/v1/events`, o exemplo do teste de contrato:

```json
{ "events": [
  { "eventId": "0193…f2", "orderId": "0193…01", "type": "delivered", "occurredAt": "2026-11-23T12:05:00.000Z" },
  { "eventId": "0193…f1", "type": "shift_finished", "serviceDate": "2026-11-23", "shift": "matutino", "occurredAt": "2026-11-23T12:10:00.000Z" } ] }
```

e "Turno inexistente, ainda aberto ou evento mais de 5 min à frente do relógio do banco: `rejected`. A secretaria também finaliza em `POST /api/admin/v1/service-days/{date}/shifts/{shift}/finish` (resposta `{ "shift": "matutino", "status": "finished", "notCollectedOrders": 2 }`)." Na spec principal: 5.2, linha de `orders`, acrescente `confirmed → not_collected` (turno finalizado) e `not_collected → delivered` (entrega registrada depois); 7.3, item 3, acrescente o evento `{ event_id, type: "shift_finished", service_date, shift, occurred_at }` (spec F5C, B.3).

- [ ] **Step 7: Run tests and checks**

Run: `pnpm app:down; docker compose down; pnpm --filter @app-lanche/contracts test && pnpm test:api && pnpm --filter @app-lanche/web test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/contracts/src/kds.ts packages/contracts/src/kds.test.ts packages/contracts/src/shifts.ts packages/contracts/src/errors.ts \
  apps/api/src/platform/errors.ts apps/api/src/modules/catalog apps/api/src/modules/orders apps/api/src/modules/serviceDays apps/api/src/modules/kds \
  apps/web/src/areas/admin/ServiceDaysAdmin.tsx apps/web/src/areas/admin/catalogAdmin.test.tsx apps/web/src/ui/messages.ts \
  docs/superpowers/specs/2026-11-20-admin-turnos-avisos-design.md docs/superpowers/specs/2026-11-16-app-lanche-design.md
git commit -m "feat(kds): finish a shift from the tablet or the office"
```

---

### Task 9: "Finalizar turno" no tablet (offline, com ordem de envio)

**Files:**
- Modify: `apps/web/src/areas/kds/{db.ts,state.ts,sync.ts,ShiftBoard.tsx,KdsBoard.tsx}`
- Test: `apps/web/src/areas/kds/state.test.ts`, `ShiftBoard.test.tsx`
- Modify: `e2e/shifts.spec.ts` (terceiro teste)

**Interfaces:**
- Consumes: `KdsShiftFinishedEvent`, `KdsEventsResponse` (Task 8); `ManifestRow`, `mergeManifest`, `pickShift`, `ShiftBoard` (Task 7).
- Produces (web):
  ```ts
  // db.ts
  export type ShiftFinishedOutboxRow = { kind: "shift_finished"; eventId: string; occurredAt: string; serviceDate: string; shift: Shift };
  export type OutboxRow = DeliveryOutboxRow | CounterSaleOutboxRow | CounterVoidOutboxRow | ShiftFinishedOutboxRow;
  export async function finishShift(serviceDate: string, shift: Shift): Promise<void>; // uma transação: manifest + outbox (regra 33)
  // state.ts
  export function finishesReadyToSend<T extends { serviceDate: string }>(finishes: T[], pendingDeliveries: { serviceDate: string }[]): T[];
  ```
  `ShiftBoard` ganha a prop `onFinish: () => void`.

- [ ] **Step 1: Write the failing tests**

`state.test.ts` (acrescente; importe `finishesReadyToSend`):

```ts
describe("finishesReadyToSend", () => {
  it("holds a finish while any delivery of the same date is still in the outbox", () => {
    const finishes = [{ eventId: "f1", serviceDate: "2031-11-05" }, { eventId: "f2", serviceDate: "2031-11-06" }];
    expect(finishesReadyToSend(finishes, [{ serviceDate: "2031-11-05" }]).map((f) => f.eventId)).toEqual(["f2"]);
    expect(finishesReadyToSend(finishes, []).map((f) => f.eventId)).toEqual(["f1", "f2"]);
  });
});
```

`ShiftBoard.test.tsx`: `setup` passa também `onFinish = vi.fn()` e devolve `{ onTap, onFinish }`; acrescente:

```tsx
  it("finishes a closed shift after confirming with the pending count", () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    const { onFinish } = setup();
    fireEvent.click(screen.getByTestId("kds-finish-shift"));
    expect(confirm).toHaveBeenCalledWith("Finalizar o turno da manhã? 2 pedidos ainda pendentes passarão a \"não retirado\".");
    expect(onFinish).toHaveBeenCalledOnce();
  });

  it("does not finish when the confirmation is declined, and hides the button on an open shift", () => {
    vi.stubGlobal("confirm", vi.fn(() => false));
    const { onFinish } = setup();
    fireEvent.click(screen.getByTestId("kds-finish-shift"));
    expect(onFinish).not.toHaveBeenCalled();
    cleanup();
    setup({ shift: { ...SHIFT, status: "open", manifestVersion: null } });
    expect(screen.queryByTestId("kds-finish-shift")).toBeNull();
  });

  it("shows pending orders of a finished shift as not collected and still lets them be delivered", () => {
    const { onTap } = setup({ shift: { ...SHIFT, status: "finished" } });
    expect(screen.getByTestId("kds-finished")).toBeTruthy();
    expect(screen.queryByTestId("kds-finish-shift")).toBeNull();
    expect(screen.getByTestId(`kds-order-${O2}`).textContent).toContain("Não retirado");
    fireEvent.click(screen.getByTestId(`kds-order-${O2}`));
    expect(onTap).toHaveBeenCalledWith(O2, true);
  });
```

`e2e/shifts.spec.ts` (acrescente no fim):

```ts
test("finishes the morning offline and sends the finish only after the delivery recorded before it", async ({ browser }) => {
  const context = await browser.newContext({ timezoneId: "America/Sao_Paulo" });
  const page = await context.newPage();
  await pair(page, "KDSTRN67", data.date);
  const [leo, bia] = data.morning as [string, string];
  await expect(page.getByTestId("kds-finish-shift")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("kds-badge")).toHaveText(SYNCED, { timeout: 30_000 });

  await context.setOffline(true);
  await page.getByTestId(`kds-order-${leo}`).click();
  page.once("dialog", (d) => void d.accept());
  await page.getByTestId("kds-finish-shift").click();
  await expect(page.getByTestId("kds-finished")).toBeVisible();
  await expect(page.getByTestId(`kds-order-${bia}`)).toContainText("Não retirado");
  await expect(page.getByTestId("kds-badge")).toContainText("2 pendentes");
  // Recarregar offline mantém o turno finalizado e a fila (IndexedDB + service worker).
  await page.reload();
  await expect(page.getByTestId("kds-finished")).toBeVisible();
  await expect(page.getByTestId("kds-badge")).toContainText("2 pendentes");
  const [before] = await query<{ status: string }>(`SELECT status FROM service_day_shifts WHERE school_id = $1 AND shift = 'matutino'`, [SCHOOL]);
  expect(before!.status).toBe("closed");

  await context.setOffline(false);
  await expect(page.getByTestId("kds-badge")).toHaveText(SYNCED, { timeout: 30_000 });
  const [shift] = await query<{ status: string; finished_by_device_id: string | null }>(
    `SELECT status, finished_by_device_id FROM service_day_shifts WHERE school_id = $1 AND shift = 'matutino'`,
    [SCHOOL],
  );
  expect(shift!.status).toBe("finished");
  expect(shift!.finished_by_device_id).not.toBeNull();
  const orders = await query<{ id: string; status: string }>(`SELECT id, status FROM orders WHERE id = ANY($1::uuid[])`, [[leo, bia]]);
  expect(Object.fromEntries(orders.map((o) => [o.id, o.status]))).toEqual({ [leo]: "delivered", [bia]: "not_collected" });
  // Ordem de envio: a entrega gravada antes chegou ao servidor antes da finalização.
  const [order] = await query<{ ok: boolean }>(
    `SELECT (SELECT max(received_at) FROM delivery_events WHERE order_id = $1) <= (SELECT min(received_at) FROM shift_events WHERE school_id = $2) AS ok`,
    [leo, SCHOOL],
  );
  expect(order!.ok).toBe(true);
  // A tarde segue só fechada.
  await page.getByTestId("kds-shift-tab-vespertino").click();
  await expect(page.getByTestId("kds-finish-shift")).toBeVisible();
  await context.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @app-lanche/web exec vitest run src/areas/kds`
Expected: FAIL (`finishesReadyToSend` não existe; botão `kds-finish-shift` ausente).

- [ ] **Step 3: Implementation**

`state.ts`:

```ts
/**
 * Finalizações que já podem ir ao servidor: nenhuma entrega da mesma data espera na outbox (spec F5C, B.3, mesma regra
 * do estorno da F5B). Comparar por data, e não por occurredAt, não depende do relógio, que nextOccurredAt pode adiantar.
 */
export function finishesReadyToSend<T extends { serviceDate: string }>(finishes: T[], pendingDeliveries: { serviceDate: string }[]): T[] {
  const blocked = new Set(pendingDeliveries.map((d) => d.serviceDate));
  return finishes.filter((f) => !blocked.has(f.serviceDate));
}
```

`db.ts`:

```ts
/** "Finalizar turno": `eventId` próprio (regra 36); o servidor responde por ele. */
export type ShiftFinishedOutboxRow = { kind: "shift_finished"; eventId: string; occurredAt: string; serviceDate: string; shift: Shift };
export type OutboxRow = DeliveryOutboxRow | CounterSaleOutboxRow | CounterVoidOutboxRow | ShiftFinishedOutboxRow;

/** Regra 33: uma transação marca o turno como finalizado no aparelho e grava o evento na outbox. Só turno fechado. */
export async function finishShift(serviceDate: string, shift: Shift): Promise<void> {
  await kdsDb.transaction("rw", kdsDb.manifest, kdsDb.outbox, async () => {
    const manifest = await kdsDb.manifest.get(serviceDate);
    if (manifest?.shifts.find((s) => s.shift === shift)?.status !== "closed") return;
    await kdsDb.manifest.put({ ...manifest, shifts: manifest.shifts.map((s) => (s.shift === shift ? { ...s, status: "finished" } : s)) });
    const row: ShiftFinishedOutboxRow = { kind: "shift_finished", eventId: crypto.randomUUID(), occurredAt: new Date().toISOString(), serviceDate, shift };
    await kdsDb.outbox.add(row);
  });
}
```

`sync.ts`:

```ts
/** shift_finished depois das entregas da mesma data (finishesReadyToSend). Recusado: o turno volta a "fechado" no aparelho. */
async function pushShiftFinishes(): Promise<void> {
  const ready = await kdsDb.transaction("r", kdsDb.outbox, async () => {
    const finishes = (await kdsDb.outbox.where("kind").equals("shift_finished").sortBy("occurredAt")) as ShiftFinishedOutboxRow[];
    const deliveries = await kdsDb.outbox.where("kind").equals("delivery").toArray();
    return finishesReadyToSend(finishes, deliveries);
  });
  for (const batch of chunk(ready, 100)) {
    const res = await apiFetch("/api/kds/v1/events", KdsEventsResponse, {
      method: "POST",
      body: { events: batch.map(({ eventId, serviceDate, shift, occurredAt }) => ({ eventId, type: "shift_finished", serviceDate, shift, occurredAt })) },
    });
    const rejected = new Set(res.rejected);
    await kdsDb.transaction("rw", kdsDb.outbox, kdsDb.manifest, async () => {
      for (const f of batch) {
        if (!rejected.has(f.eventId)) continue;
        const manifest = await kdsDb.manifest.get(f.serviceDate);
        if (manifest) {
          await kdsDb.manifest.put({ ...manifest, shifts: manifest.shifts.map((s) => (s.shift === f.shift && s.status === "finished" ? { ...s, status: "closed" } : s)) });
        }
      }
      await kdsDb.outbox.bulkDelete([...res.accepted, ...res.rejected]); // regra 34
    });
  }
}

async function pushOutbox(): Promise<void> {
  await pushDeliveries();
  await pushShiftFinishes();
  await pushCounterSales();
  await pushCounterVoids();
}
```

Um turno recusado volta a "fechado" e a próxima rodada baixa o estado do servidor (que, por `mergeManifest`, pode ser "finalizado" por outro tablet).

`ShiftBoard.tsx` — prop `onFinish: () => void`, e:

```tsx
  const finished = shift.status === "finished";
  const pending = content.by_class.reduce((n, c) => n + c.orders.filter((o) => !delivered.has(o.order_id)).length, 0);
  function confirmFinish() {
    const name = SHIFT_LABELS[shift.shift].toLowerCase();
    if (window.confirm(`Finalizar o turno da ${name}? ${pending} pedidos ainda pendentes passarão a "não retirado".`)) onFinish();
  }
```

  - antes dos totais:

```tsx
      {finished && (
        <div className="alert alert-secondary" data-testid="kds-finished">
          Turno finalizado. Os pedidos que faltaram aparecem como não retirados; uma entrega atrasada ainda pode ser marcada.
        </div>
      )}
      {shift.status === "closed" && (
        <Button color="danger" outline type="button" className="mb-3" data-testid="kds-finish-shift" onClick={confirmFinish}>
          Finalizar turno
        </Button>
      )}
```

  - no cartão: `{isDelivered ? "✓ Entregue" : finished ? "Não retirado" : "Pendente"}`.

(`Button` de `reactstrap`; `SHIFT_LABELS` de `../../ui/shifts`.)

`KdsBoard.tsx`:

```tsx
  async function finish(shift: Shift) {
    try {
      await finishShift(serviceDate, shift);
      setTapFailed(false);
    } catch (err) {
      console.warn("kds finish failed", err instanceof Error ? err.name : "unknown");
      setTapFailed(true);
    }
  }
```

e `<ShiftBoard … onFinish={() => void finish(current.shift)} />`. A mensagem do desparear com outbox cheia passa a "Há entregas, finalizações ou vendas do balcão ainda não sincronizadas. Conecte o tablet à internet e aguarde antes de desparear." (ajuste o teste que a compara, se houver; o `kds.spec.ts` só checa "não sincronizadas").

- [ ] **Step 4: Run tests and checks**

Run: `pnpm --filter @app-lanche/web exec vitest run src/areas/kds && pnpm typecheck && pnpm lint`, depois `pnpm db:up && pnpm test:e2e; docker compose down`
Expected: PASS (os três testes de `shifts.spec.ts` e os antigos).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/areas/kds e2e/shifts.spec.ts
git commit -m "feat(kds): finish a shift offline after its deliveries sync"
```

---

### Task 10: "Não retirados" (secretaria decide; crédito uma vez só)

**Files:**
- Create: `packages/contracts/src/uncollected.ts`, `uncollected.test.ts`; Modify: `packages/contracts/src/{wallet.ts,errors.ts,index.ts}`
- Modify: `apps/api/src/platform/errors.ts`; `apps/api/src/modules/wallet/service.ts` (`WalletSourceType` com `"order"`)
- Create: `apps/api/src/modules/uncollected/{repo,service,routes}.ts`, `uncollected.test.ts`; Modify: `apps/api/src/app.ts` (registrar)
- Modify: `apps/api/src/modules/dashboard/dashboard.test.ts` (não retirados)
- Create: `apps/web/src/areas/admin/UncollectedAdmin.tsx`, `uncollected.test.tsx`
- Modify: `apps/web/src/areas/admin/{LunchPages.tsx,AdminArea.tsx,adminNav.ts,adminLayout.test.tsx}`, `apps/web/src/ui/{walletLabels.ts,messages.ts}`
- Modify: `docs/superpowers/specs/2026-11-20-admin-turnos-avisos-design.md` (B.4: exemplos), `docs/superpowers/specs/2026-11-16-app-lanche-design.md` (5.7: tipo `uncollected_credit`)

**Interfaces:**
- Consumes: `catalog.lockServiceDayById`, `catalog.lockShift` (Task 3); `wallet.postEntry` (F5B; aceita `id`); `audit`; `idempotent`/`requestHash`/`idempotencyKeyFrom`; `useRequestKey` (web); helpers `seedConfirmedOrders`, `seedServiceDay` (Task 1); `closeShift` (Task 6); rota de finalizar (Task 8).
- Produces (contracts):
  ```ts
  export const UncollectedOrder = z.object({ orderId: Uuid, serviceDate: IsoDate, shift: Shift, className: z.string(), studentFirstName: z.string(),
    items: z.array(z.object({ name: z.string(), qty: z.number().int().positive() })).min(1), amountCents: Cents });
  export const UncollectedReview = UncollectedOrder.extend({ creditedCents: Cents, decidedAt: IsoDateTime });
  export const UncollectedListResponse = z.object({ pending: z.array(UncollectedOrder), toReview: z.array(UncollectedReview) });
  export const UncollectedDecisionRequest = z.object({ reason: z.string().trim().min(1).max(200).nullable().default(null) }).strict();
  export const UncollectedDecisionResponse = z.object({ orderId: Uuid, decision: z.enum(["credited", "kept"]), amountCents: Cents.nullable(), balanceCents: z.number().int().nullable() });
  ```
  `WalletEntryKind` com `"uncollected_credit"`; erros `order_not_uncollected` (409) e `uncollected_already_decided` (409).
- Produces (rotas, `OFFICE`): `GET /api/admin/v1/uncollected` → `UncollectedListResponse` (até 200 pendentes, data desc, turno, turma, aluno); `POST /api/admin/v1/uncollected/:orderId/credit` e `…/keep` (com `Idempotency-Key`) → `UncollectedDecisionResponse`; `POST /api/admin/v1/uncollected/:orderId/review` (naturalmente idempotente) → 204.
- Produces (web): página `/admin/lanche/nao-retirados` ("Não retirados"), item de menu depois de "Contas"; `ENTRY_LABELS.uncollected_credit = "Lanche não retirado — devolvido"`.

- [ ] **Step 1: Write the failing tests**

`packages/contracts/src/uncollected.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { UncollectedDecisionRequest, UncollectedDecisionResponse, UncollectedListResponse } from "./uncollected";

const ORDER = {
  orderId: "0193a3b0-0000-7000-8000-000000000001",
  serviceDate: "2026-11-23",
  shift: "matutino",
  className: "Infantil 3A",
  studentFirstName: "Léo",
  items: [{ name: "Misto quente", qty: 1 }],
  amountCents: 900,
};

describe("uncollected contracts", () => {
  it("accepts the spec B.4 examples", () => {
    const list = { pending: [ORDER], toReview: [{ ...ORDER, creditedCents: 900, decidedAt: "2026-11-23T18:00:00.000Z" }] };
    expect(UncollectedListResponse.parse(list)).toEqual(list);
    const credited = { orderId: ORDER.orderId, decision: "credited", amountCents: 900, balanceCents: 1500 };
    expect(UncollectedDecisionResponse.parse(credited)).toEqual(credited);
    expect(UncollectedDecisionResponse.parse({ orderId: ORDER.orderId, decision: "kept", amountCents: null, balanceCents: null }).decision).toBe("kept");
  });

  it("takes an optional reason of up to 200 characters", () => {
    expect(UncollectedDecisionRequest.parse({})).toEqual({ reason: null });
    expect(UncollectedDecisionRequest.parse({ reason: "  faltou  " })).toEqual({ reason: "faltou" });
    expect(() => UncollectedDecisionRequest.parse({ reason: "" })).toThrow();
    expect(() => UncollectedDecisionRequest.parse({ reason: "x".repeat(201) })).toThrow();
    expect(() => UncollectedDecisionRequest.parse({ reason: null, guardianId: ORDER.orderId })).toThrow();
  });
});
```

`apps/api/src/modules/uncollected/uncollected.test.ts`:

```ts
import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { describe, expect, it } from "vitest";
import { adminDb, createSchool, kitchenCookie, seedConfirmedOrders, seedServiceDay, staffCookie, walletLedgerMatches } from "../../../test/helpers";
import { buildApp } from "../../app";
import { closeShift } from "../serviceDays/service";

const log = { warn: () => undefined, info: () => undefined, error: () => undefined } as never;

/** Manhã fechada e finalizada pela secretaria: Léo e Bia não retirados (900 cada). */
async function finishedMorning(serviceDate: string) {
  const schoolId = await createSchool();
  const day = await seedServiceDay(schoolId, { serviceDate, shifts: { matutino: -30 } });
  const seeded = await seedConfirmedOrders(schoolId, { serviceDayId: day.serviceDayId, serviceDate, menuItemId: day.items[0]!.id, studentNames: ["Léo", "Bia"] });
  await closeShift(schoolId, serviceDate, "matutino", { log, reconcile: false });
  const staff = await staffCookie(schoolId, "secretaria");
  await buildApp().inject({ method: "POST", url: `/api/admin/v1/service-days/${serviceDate}/shifts/matutino/finish`, cookies: staff.cookies });
  return { schoolId, day, ...seeded, cookies: staff.cookies, staffUserId: staff.staffUserId, itemName: day.items[0]!.name };
}

const decide = (cookies: Record<string, string>, orderId: string, action: "credit" | "keep", body: object = {}, key: string | null = uuidv7()) =>
  buildApp().inject({
    method: "POST",
    url: `/api/admin/v1/uncollected/${orderId}/${action}`,
    cookies,
    headers: key ? { "idempotency-key": key } : {},
    payload: body,
  });

describe("uncollected orders", () => {
  it("lists them by day, shift and class with the first name, items and amount", async () => {
    const s = await finishedMorning("2031-12-10");
    const res = await buildApp().inject({ method: "GET", url: "/api/admin/v1/uncollected", cookies: s.cookies });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      pending: ["Bia", "Léo"].map((name) => ({
        orderId: expect.any(String),
        serviceDate: "2031-12-10",
        shift: "matutino",
        className: "Infantil 3A",
        studentFirstName: name,
        items: [{ name: s.itemName, qty: 1 }],
        amountCents: 900,
      })),
      toReview: [],
    });
    const kitchen = await staffCookie(s.schoolId, "cozinha");
    expect((await buildApp().inject({ method: "GET", url: "/api/admin/v1/uncollected", cookies: kitchen.cookies })).statusCode).toBe(403);
  });

  it("credits the student's current financial guardian once, audited, and replays the same key", async () => {
    const s = await finishedMorning("2031-12-11");
    const [leo] = s.orderIds as [string];
    // Troca o responsável financeiro de Léo antes de decidir: o crédito vai para o atual.
    const { studentId } = await adminDb().selectFrom("orders").select("studentId").where("id", "=", leo).executeTakeFirstOrThrow();
    const other = uuidv7();
    await adminDb().insertInto("guardians").values({ id: other, schoolId: s.schoolId, phoneE164: "+5511977770001", firstName: "Rui" }).execute();
    await adminDb().insertInto("guardianStudents").values({ schoolId: s.schoolId, guardianId: other, studentId, financial: false }).execute();
    await buildApp().inject({ method: "PUT", url: `/api/admin/v1/students/${studentId}/financial-guardian`, cookies: s.cookies, payload: { guardianId: other } });

    const key = uuidv7();
    const first = await decide(s.cookies, leo, "credit", { reason: "faltou à aula" }, key);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ orderId: leo, decision: "credited", amountCents: 900, balanceCents: 900 });
    expect((await decide(s.cookies, leo, "credit", { reason: "faltou à aula" }, key)).json()).toEqual(first.json());
    const again = await decide(s.cookies, leo, "credit");
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("uncollected_already_decided");

    const entries = await adminDb().selectFrom("walletEntries").innerJoin("wallets", "wallets.id", "walletEntries.walletId")
      .select(["wallets.guardianId", "walletEntries.amountCents", "walletEntries.sourceType"]).where("walletEntries.kind", "=", "uncollected_credit").where("walletEntries.sourceId", "=", leo).execute();
    expect(entries).toEqual([{ guardianId: other, amountCents: 900, sourceType: "order" }]);
    expect(await walletLedgerMatches(s.schoolId, other)).toBe(true);
    const decision = await adminDb().selectFrom("uncollectedDecisions").selectAll().where("orderId", "=", leo).executeTakeFirstOrThrow();
    expect(decision).toMatchObject({ decision: "credited", guardianId: other, amountCents: 900, reason: "faltou à aula", staffUserId: s.staffUserId });
    const audit = await adminDb().selectFrom("auditLog").select(sql<string>`detail::text`.as("detail")).where("schoolId", "=", s.schoolId).where("action", "=", "uncollected.credited").execute();
    expect(audit.map((a) => JSON.parse(a.detail))).toEqual([{ order_id: leo, decision_id: decision.id, has_reason: true }]);
    const list = await buildApp().inject({ method: "GET", url: "/api/admin/v1/uncollected", cookies: s.cookies });
    expect(list.json().pending.map((o: { orderId: string }) => o.orderId)).not.toContain(leo);
  });

  it("keeps without refund, removes it from the list and refuses a later credit", async () => {
    const s = await finishedMorning("2031-12-12");
    const [, bia] = s.orderIds as [string, string];
    const kept = await decide(s.cookies, bia, "keep");
    expect(kept.json()).toEqual({ orderId: bia, decision: "kept", amountCents: null, balanceCents: null });
    expect((await decide(s.cookies, bia, "credit")).json().error.code).toBe("uncollected_already_decided");
    expect(await adminDb().selectFrom("walletEntries").select("id").where("sourceId", "=", bia).execute()).toEqual([]);
    const audit = await adminDb().selectFrom("auditLog").select("id").where("schoolId", "=", s.schoolId).where("action", "=", "uncollected.kept").execute();
    expect(audit).toHaveLength(1);
  });

  it("refuses an order that is not uncollected, an unknown one and a request without a key", async () => {
    const s = await finishedMorning("2031-12-13");
    const [leo] = s.orderIds as [string];
    expect((await decide(s.cookies, leo, "credit", {}, null)).statusCode).toBe(400);
    expect((await decide(s.cookies, uuidv7(), "credit")).statusCode).toBe(404);
    await adminDb().updateTable("orders").set({ status: "delivered" }).where("id", "=", leo).execute();
    const res = await decide(s.cookies, leo, "credit");
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("order_not_uncollected");
  });

  it("credits only once when two staff members click at the same time", async () => {
    const s = await finishedMorning("2031-12-14");
    const [leo] = s.orderIds as [string];
    const results = await Promise.all([decide(s.cookies, leo, "credit"), decide(s.cookies, leo, "credit"), decide(s.cookies, leo, "keep")]);
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(2);
    const decisions = await adminDb().selectFrom("uncollectedDecisions").select("decision").where("orderId", "=", leo).execute();
    expect(decisions).toHaveLength(1);
    const credits = await adminDb().selectFrom("walletEntries").select("id").where("sourceId", "=", leo).execute();
    expect(credits).toHaveLength(decisions[0]!.decision === "credited" ? 1 : 0);
  });

  it("accepts a delivery after the credit and flags it for review without undoing the credit", async () => {
    const s = await finishedMorning("2031-12-15");
    const [leo] = s.orderIds as [string];
    await decide(s.cookies, leo, "credit");
    const { cookies } = await kitchenCookie(s.schoolId);
    const ev = { eventId: uuidv7(), orderId: leo, type: "delivered", occurredAt: new Date(Date.now() - 60_000).toISOString() };
    expect((await buildApp().inject({ method: "POST", url: "/api/kds/v1/events", cookies, payload: { events: [ev] } })).json().accepted).toEqual([ev.eventId]);
    const order = await adminDb().selectFrom("orders").select("status").where("id", "=", leo).executeTakeFirstOrThrow();
    expect(order.status).toBe("delivered");
    const list = await buildApp().inject({ method: "GET", url: "/api/admin/v1/uncollected", cookies: s.cookies });
    expect(list.json().toReview).toEqual([expect.objectContaining({ orderId: leo, creditedCents: 900, studentFirstName: "Léo" })]);
    const credit = await adminDb().selectFrom("walletEntries").select("amountCents").where("sourceId", "=", leo).execute();
    expect(credit).toEqual([{ amountCents: 900 }]);
    const review = await buildApp().inject({ method: "POST", url: `/api/admin/v1/uncollected/${leo}/review`, cookies: s.cookies });
    expect(review.statusCode).toBe(204);
    expect((await buildApp().inject({ method: "POST", url: `/api/admin/v1/uncollected/${leo}/review`, cookies: s.cookies })).statusCode).toBe(204);
    const after = await buildApp().inject({ method: "GET", url: "/api/admin/v1/uncollected", cookies: s.cookies });
    expect(after.json().toReview).toEqual([]);
    expect((await buildApp().inject({ method: "POST", url: `/api/admin/v1/uncollected/${uuidv7()}/review`, cookies: s.cookies })).statusCode).toBe(404);
  });
});
```

`apps/api/src/modules/dashboard/dashboard.test.ts` (acrescente; importe `closeShift` de `../serviceDays/service`):

```ts
  it("counts orders not collected after a shift is finished", async () => {
    const schoolId = await createSchool();
    const today = await localDate(schoolId, 0);
    const day = await seedClosedDayWithOrders(schoolId, { serviceDate: today, studentNames: ["Léo", "Bia", "Caio"] });
    await adminDb().updateTable("orders").set({ status: "delivered" }).where("id", "=", day.orderIds[0]!).execute();
    await closeShift(schoolId, today, "matutino", { log: buildApp().log, reconcile: false });
    const { cookies } = await staffCookie(schoolId, "secretaria");
    await buildApp().inject({ method: "POST", url: `/api/admin/v1/service-days/${today}/shifts/matutino/finish`, cookies });
    const body = (await get(cookies)).json();
    expect(body.snacks).toMatchObject({ paidOrders: 3, deliveredOrders: 1, notCollectedOrders: 2 });
  });
```

Web — `apps/web/src/areas/admin/uncollected.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminLayout } from "./AdminLayout";
import { UncollectedPage } from "./LunchPages";

type Reply = { status: number; body?: unknown };
const O1 = "0193a000-0000-7000-8000-000000000101";
const O2 = "0193a000-0000-7000-8000-000000000102";
const ORDER = (orderId: string, studentFirstName: string) => ({
  orderId, serviceDate: "2030-03-04", shift: "matutino", className: "Infantil 3A", studentFirstName, items: [{ name: "Misto quente", qty: 1 }], amountCents: 900,
});

function mockApi(replies: Record<string, Reply>) {
  const fn = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url, init) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    const reply = replies[key];
    if (!reply) throw new Error(`unexpected request ${key}`);
    return reply.status === 204 ? new Response(null, { status: 204 }) : new Response(JSON.stringify(reply.body), { status: reply.status });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const ME = { status: 200, body: { id: "0193a000-0000-7000-8000-000000000001", email: "ana@escola.test", role: "secretaria", schoolName: "Escola Sol" } };

function renderPage() {
  render(
    <MemoryRouter initialEntries={["/admin/lanche/nao-retirados"]}>
      <Routes>
        <Route path="/admin" element={<AdminLayout />}>
          <Route path="lanche/nao-retirados" element={<UncollectedPage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("uncollected page", () => {
  it("lists pending orders and credits one with an optional reason and an idempotency key", async () => {
    vi.stubGlobal("prompt", vi.fn(() => "faltou"));
    const fn = mockApi({
      "GET /api/admin/v1/me": ME,
      "GET /api/admin/v1/uncollected": { status: 200, body: { pending: [ORDER(O1, "Léo"), ORDER(O2, "Bia")], toReview: [] } },
      [`POST /api/admin/v1/uncollected/${O1}/credit`]: { status: 200, body: { orderId: O1, decision: "credited", amountCents: 900, balanceCents: 900 } },
    });
    renderPage();
    const row = (await screen.findByText("Léo")).closest("tr")!;
    expect(within(row).getByText("Manhã")).toBeTruthy();
    expect(within(row).getByText("1x Misto quente")).toBeTruthy();
    expect(within(row).getByText("R$ 9,00")).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "Devolver como crédito" }));
    await waitFor(() => expect(fn.mock.calls.some((c) => c[0] === `/api/admin/v1/uncollected/${O1}/credit`)).toBe(true));
    const call = fn.mock.calls.find((c) => c[0] === `/api/admin/v1/uncollected/${O1}/credit`)!;
    expect(JSON.parse(call[1]!.body as string)).toEqual({ reason: "faltou" });
    expect(new Headers(call[1]!.headers).get("idempotency-key")).toBeTruthy();
    expect(await screen.findByText("Léo: R$ 9,00 devolvidos como crédito.")).toBeTruthy();
  });

  it("keeps without refund and cancels when the prompt is dismissed", async () => {
    const prompt = vi.fn<() => string | null>(() => null);
    vi.stubGlobal("prompt", prompt);
    const fn = mockApi({
      "GET /api/admin/v1/me": ME,
      "GET /api/admin/v1/uncollected": { status: 200, body: { pending: [ORDER(O1, "Léo")], toReview: [] } },
      [`POST /api/admin/v1/uncollected/${O1}/keep`]: { status: 200, body: { orderId: O1, decision: "kept", amountCents: null, balanceCents: null } },
    });
    renderPage();
    const row = (await screen.findByText("Léo")).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Manter sem devolução" }));
    expect(fn.mock.calls.some((c) => c[1]?.method === "POST")).toBe(false);
    prompt.mockReturnValue("");
    fireEvent.click(within(row).getByRole("button", { name: "Manter sem devolução" }));
    await waitFor(() => expect(fn.mock.calls.some((c) => c[0] === `/api/admin/v1/uncollected/${O1}/keep`)).toBe(true));
    const call = fn.mock.calls.find((c) => c[0] === `/api/admin/v1/uncollected/${O1}/keep`)!;
    expect(JSON.parse(call[1]!.body as string)).toEqual({ reason: null });
  });

  it("shows orders delivered after a refund for review and marks them as reviewed", async () => {
    const fn = mockApi({
      "GET /api/admin/v1/me": ME,
      "GET /api/admin/v1/uncollected": { status: 200, body: { pending: [], toReview: [{ ...ORDER(O1, "Léo"), creditedCents: 900, decidedAt: "2030-03-04T18:00:00.000Z" }] } },
      [`POST /api/admin/v1/uncollected/${O1}/review`]: { status: 204 },
    });
    renderPage();
    expect(await screen.findByText("Nenhum pedido pendente de decisão.")).toBeTruthy();
    const row = screen.getByText("Léo").closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Marcar como conferido" }));
    await waitFor(() => expect(fn.mock.calls.some((c) => c[0] === `/api/admin/v1/uncollected/${O1}/review`)).toBe(true));
  });
});
```

Em `adminLayout.test.tsx`, a lista de links do menu da secretaria passa a terminar em `"Contas", "Não retirados"` e acrescente `expect(menu().getByRole("link", { name: "Não retirados" }).getAttribute("href")).toBe("/admin/lanche/nao-retirados");`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @app-lanche/contracts test; pnpm app:down; docker compose down; pnpm --filter @app-lanche/api exec vitest run src/modules/uncollected src/modules/dashboard; pnpm --filter @app-lanche/web exec vitest run src/areas/admin`
Expected: FAIL (módulo inexistente; rota 404; página e item de menu ausentes).

- [ ] **Step 3: Contracts** — `packages/contracts/src/uncollected.ts` com o bloco Interfaces (importe `Cents`, `IsoDate`, `IsoDateTime`, `Uuid` de `./common` e `Shift` de `./shifts`; exporte os tipos inferidos de mesmo nome); `export * from "./uncollected";` em `index.ts`. `wallet.ts`: `"uncollected_credit"` no fim de `WalletEntryKind`. `errors.ts`: `"order_not_uncollected"`, `"uncollected_already_decided"` (depois de `"shift_not_closed"`); `platform/errors.ts`: ambos `409`. `apps/web/src/ui/messages.ts` (`STAFF_MESSAGES`): `order_not_uncollected: "Este pedido não está mais como não retirado. Atualize a página."`, `uncollected_already_decided: "Já existe uma decisão para este pedido."`. `apps/web/src/ui/walletLabels.ts`: `uncollected_credit: "Lanche não retirado — devolvido"`.

- [ ] **Step 4: API** — `apps/api/src/modules/uncollected/repo.ts`:

```ts
import type { Shift } from "@app-lanche/contracts";
import { sql } from "kysely";
import type { Trx } from "../../db/index";

type Row = { orderId: string; serviceDate: string; shift: Shift; className: string; studentFirstName: string; items: { name: string; qty: number }[]; amountCents: number };

const SELECT = sql`
  o.id AS order_id, o.service_date::text AS service_date, c.shift, cl.name AS class_name, st.first_name AS student_first_name,
  (SELECT json_agg(json_build_object('name', mi.name, 'qty', oi.qty) ORDER BY mi.name)
     FROM order_items oi JOIN menu_items mi ON mi.id = oi.menu_item_id WHERE oi.order_id = o.id) AS items,
  (SELECT sum(oi.qty * oi.unit_price_cents)::bigint FROM order_items oi WHERE oi.order_id = o.id) AS amount_cents`;

const FROM = sql`
  FROM orders o
  JOIN checkouts c ON c.id = o.checkout_id
  JOIN students st ON st.id = o.student_id
  JOIN classes cl ON cl.id = st.class_id`;

/** Não retirados ainda sem decisão: data mais recente primeiro, depois turno, turma e aluno. */
export async function listPending(trx: Trx): Promise<Row[]> {
  const { rows } = await sql<Row>`
    SELECT ${SELECT} ${FROM}
    WHERE o.status = 'not_collected' AND NOT EXISTS (SELECT 1 FROM uncollected_decisions u WHERE u.order_id = o.id)
    ORDER BY o.service_date DESC, c.shift, cl.name, st.first_name, o.id
    LIMIT 200`.execute(trx);
  return rows;
}

/** Devolvidos como crédito e depois entregues (tablet sem rede): a secretaria confere. */
export async function listToReview(trx: Trx): Promise<(Row & { creditedCents: number; decidedAt: Date })[]> {
  const { rows } = await sql<Row & { creditedCents: number; decidedAt: Date }>`
    SELECT ${SELECT}, u.amount_cents AS credited_cents, u.decided_at ${FROM}
    JOIN uncollected_decisions u ON u.order_id = o.id
    WHERE u.decision = 'credited' AND u.reviewed_at IS NULL AND o.status = 'delivered'
    ORDER BY o.service_date DESC, c.shift, cl.name, st.first_name, o.id
    LIMIT 200`.execute(trx);
  return rows;
}

export async function orderTarget(trx: Trx, orderId: string) {
  const { rows } = await sql<{ serviceDayId: string; shift: Shift; studentId: string; amountCents: number }>`
    SELECT c.service_day_id, c.shift, o.student_id,
      (SELECT sum(oi.qty * oi.unit_price_cents)::bigint FROM order_items oi WHERE oi.order_id = o.id) AS amount_cents
    FROM orders o JOIN checkouts c ON c.id = o.checkout_id WHERE o.id = ${orderId}`.execute(trx);
  return rows[0];
}

/** Trava o pedido depois do dia e do turno (mesma ordem das entregas do tablet). */
export async function lockOrderStatus(trx: Trx, orderId: string): Promise<string> {
  const row = await trx.selectFrom("orders").select("status").where("id", "=", orderId).forUpdate().executeTakeFirstOrThrow();
  return row.status;
}

export async function decisionExists(trx: Trx, orderId: string): Promise<boolean> {
  return (await trx.selectFrom("uncollectedDecisions").select("id").where("orderId", "=", orderId).executeTakeFirst()) !== undefined;
}

/** Responsável financeiro atual do aluno, travado FOR SHARE antes da carteira (ordem da F5B). */
export async function lockFinancialGuardian(trx: Trx, studentId: string): Promise<string | null> {
  const { rows } = await sql<{ guardianId: string }>`
    SELECT guardian_id FROM guardian_students WHERE student_id = ${studentId} AND financial FOR SHARE`.execute(trx);
  return rows[0]?.guardianId ?? null;
}

export async function insertDecision(
  trx: Trx,
  row: { id: string; schoolId: string; orderId: string; decision: "credited" | "kept"; guardianId: string | null; walletEntryId: string | null; amountCents: number | null; reason: string | null; staffUserId: string },
): Promise<boolean> {
  const inserted = await trx
    .insertInto("uncollectedDecisions")
    .values(row)
    .onConflict((oc) => oc.columns(["schoolId", "orderId"]).doNothing())
    .returning("id")
    .executeTakeFirst();
  return inserted !== undefined;
}

export async function markReviewed(trx: Trx, orderId: string, staffUserId: string): Promise<"reviewed" | "already" | "missing"> {
  const res = await sql`
    UPDATE uncollected_decisions SET reviewed_at = now(), reviewed_by_staff_id = ${staffUserId}
    WHERE order_id = ${orderId} AND decision = 'credited' AND reviewed_at IS NULL`.execute(trx);
  if (Number(res.numAffectedRows ?? 0) === 1) return "reviewed";
  return (await decisionExists(trx, orderId)) ? "already" : "missing";
}
```

`apps/api/src/modules/uncollected/service.ts`:

```ts
import type { UncollectedDecisionRequest, UncollectedDecisionResponse, UncollectedListResponse } from "@app-lanche/contracts";
import { uuidv7 } from "uuidv7";
import { withTenant, type Trx } from "../../db/index";
import { audit } from "../../platform/audit";
import { DomainError } from "../../platform/errors";
import { idempotent, requestHash } from "../../platform/idempotency";
import type { SessionClaims } from "../../platform/session";
import * as catalog from "../catalog/service";
import * as wallet from "../wallet/service";
import * as repo from "./repo";

export async function listUncollected(session: SessionClaims): Promise<UncollectedListResponse> {
  return withTenant(session.schoolId, async (trx) => ({
    pending: await repo.listPending(trx),
    toReview: (await repo.listToReview(trx)).map((r) => ({ ...r, decidedAt: r.decidedAt.toISOString() })),
  }));
}

/**
 * Decisão da secretaria sobre um pedido não retirado (spec F5C, B.4). Travas: service_days → service_day_shifts (FOR SHARE)
 * → orders (FOR UPDATE) → guardian_students (FOR SHARE) → wallets (postEntry, FOR UPDATE).
 */
async function decide(trx: Trx, session: SessionClaims, orderId: string, decision: "credited" | "kept", reason: string | null): Promise<UncollectedDecisionResponse> {
  const schoolId = session.schoolId;
  const target = await repo.orderTarget(trx, orderId);
  if (!target) throw new DomainError("not_found");
  await catalog.lockServiceDayById(trx, target.serviceDayId, "share");
  await catalog.lockShift(trx, target.serviceDayId, target.shift, "share");
  if ((await repo.lockOrderStatus(trx, orderId)) !== "not_collected") throw new DomainError("order_not_uncollected");
  if (await repo.decisionExists(trx, orderId)) throw new DomainError("uncollected_already_decided");
  const id = uuidv7();
  let response: UncollectedDecisionResponse = { orderId, decision, amountCents: null, balanceCents: null };
  let credit: { guardianId: string; walletEntryId: string; amountCents: number } | null = null;
  if (decision === "credited") {
    const guardianId = await repo.lockFinancialGuardian(trx, target.studentId);
    if (!guardianId) throw new DomainError("invalid_order");
    const walletEntryId = uuidv7();
    const posted = await wallet.postEntry(trx, {
      schoolId, guardianId, kind: "uncollected_credit", amountCents: target.amountCents, sourceType: "order", sourceId: orderId, id: walletEntryId,
    });
    // O índice único parcial por pedido já tinha a entrada (outra decisão em corrida): nada foi lançado.
    if (!posted.posted) throw new DomainError("uncollected_already_decided");
    credit = { guardianId, walletEntryId, amountCents: target.amountCents };
    response = { orderId, decision, amountCents: target.amountCents, balanceCents: posted.balanceCents };
  }
  const inserted = await repo.insertDecision(trx, {
    id, schoolId, orderId, decision, reason, staffUserId: session.sub,
    guardianId: credit?.guardianId ?? null, walletEntryId: credit?.walletEntryId ?? null, amountCents: credit?.amountCents ?? null,
  });
  // Outra decisão gravada em corrida: a exceção desfaz também o crédito desta transação.
  if (!inserted) throw new DomainError("uncollected_already_decided");
  await audit(trx, { schoolId, actorKind: "staff", actorId: session.sub, action: `uncollected.${decision}`, detail: { order_id: orderId, decision_id: id, has_reason: reason !== null } });
  return response;
}

async function decideOnce(session: SessionClaims, key: string, orderId: string, decision: "credited" | "kept", body: UncollectedDecisionRequest) {
  const hash = requestHash({ route: `POST /api/admin/v1/uncollected/:id/${decision === "credited" ? "credit" : "keep"}`, actorId: session.sub, body: { orderId, ...body } });
  return withTenant(session.schoolId, async (trx) => {
    const { response } = await idempotent(trx, { schoolId: session.schoolId, key, requestHash: hash }, () => decide(trx, session, orderId, decision, body.reason));
    return response;
  });
}

export const creditUncollected = (session: SessionClaims, key: string, orderId: string, body: UncollectedDecisionRequest) => decideOnce(session, key, orderId, "credited", body);
export const keepUncollected = (session: SessionClaims, key: string, orderId: string, body: UncollectedDecisionRequest) => decideOnce(session, key, orderId, "kept", body);

export async function reviewUncollected(session: SessionClaims, orderId: string): Promise<void> {
  await withTenant(session.schoolId, async (trx) => {
    const result = await repo.markReviewed(trx, orderId, session.sub);
    if (result === "missing") throw new DomainError("not_found");
    if (result === "reviewed") await audit(trx, { schoolId: session.schoolId, actorKind: "staff", actorId: session.sub, action: "uncollected.reviewed", detail: { order_id: orderId } });
  });
}
```

(Na corrida de dois "Devolver" com chaves diferentes, a segunda transação espera a trava `FOR UPDATE` do pedido; ao seguir, `decisionExists` já vê a decisão gravada e devolve 409. O 409 do `insertDecision` e do `posted === false` cobre a corrida que escapasse dessa trava.)

`apps/api/src/modules/uncollected/routes.ts`:

```ts
import { UncollectedDecisionRequest, Uuid } from "@app-lanche/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RouteAuth } from "../../app";
import { idempotencyKeyFrom } from "../../platform/idempotency";
import * as service from "./service";

const OFFICE: RouteAuth = { kind: "staff", roles: ["admin", "secretaria"] };
const OrderParams = z.object({ orderId: Uuid });

export async function uncollectedRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/admin/v1/uncollected", { config: { auth: OFFICE } }, async (req) => service.listUncollected(req.session!));

  app.post("/api/admin/v1/uncollected/:orderId/credit", { config: { auth: OFFICE } }, async (req) =>
    service.creditUncollected(req.session!, idempotencyKeyFrom(req), OrderParams.parse(req.params).orderId, UncollectedDecisionRequest.parse(req.body ?? {})),
  );

  app.post("/api/admin/v1/uncollected/:orderId/keep", { config: { auth: OFFICE } }, async (req) =>
    service.keepUncollected(req.session!, idempotencyKeyFrom(req), OrderParams.parse(req.params).orderId, UncollectedDecisionRequest.parse(req.body ?? {})),
  );

  // Naturalmente idempotente: só grava reviewed_at uma vez (sem Idempotency-Key).
  app.post("/api/admin/v1/uncollected/:orderId/review", { config: { auth: OFFICE } }, async (req, reply) => {
    await service.reviewUncollected(req.session!, OrderParams.parse(req.params).orderId);
    return reply.status(204).send();
  });
}
```

Em `apps/api/src/app.ts`, `app.register(uncollectedRoutes);` depois de `serviceDayRoutes`. Em `wallet/service.ts`, `WalletSourceType` ganha `"order"`.

- [ ] **Step 5: Web**

`apps/web/src/areas/admin/UncollectedAdmin.tsx`:

```tsx
import { UncollectedDecisionResponse, UncollectedListResponse, type UncollectedOrder } from "@app-lanche/contracts";
import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Card, CardBody, CardHeader, Table } from "reactstrap";
import { z } from "zod";
import { ApiError, apiFetch } from "../../app/api";
import { announce, StatusNotice } from "../../theme/notify";
import { formatIsoDate } from "../../ui/dates";
import { staffErrorMessage } from "../../ui/messages";
import { formatCents } from "../../ui/money";
import { SHIFT_LABELS } from "../../ui/shifts";
import { useRequestKey } from "./useRequestKey";

const items = (o: UncollectedOrder) => o.items.map((i) => `${i.qty}x ${i.name}`).join(", ");

function Cells({ o }: { o: UncollectedOrder }) {
  return (
    <>
      <td>{formatIsoDate(o.serviceDate)}</td>
      <td>{SHIFT_LABELS[o.shift]}</td>
      <td>{o.className}</td>
      <td>{o.studentFirstName}</td>
      <td>{items(o)}</td>
      <td className="text-end">{formatCents(o.amountCents)}</td>
    </>
  );
}

const HEAD = (
  <tr>
    <th>Data</th>
    <th>Turno</th>
    <th>Turma</th>
    <th>Aluno</th>
    <th>Itens</th>
    <th className="text-end">Valor</th>
    <th>
      <span className="visually-hidden">Ações</span>
    </th>
  </tr>
);

/** Pedidos pagos e não retirados (spec F5C, B.4): a secretaria decide, pedido a pedido. */
export function UncollectedAdmin() {
  const [data, setData] = useState<UncollectedListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { keyFor, succeeded, once } = useRequestKey();
  const fail = (err: unknown) => setError(staffErrorMessage(err instanceof ApiError ? err.code : "internal_error"));

  const reload = useCallback(() => apiFetch("/api/admin/v1/uncollected", UncollectedListResponse).then(setData, fail), []);
  useEffect(() => void reload(), [reload]);

  function decide(o: UncollectedOrder, action: "credit" | "keep") {
    const answer = window.prompt("Motivo (opcional):", "");
    if (answer === null) return;
    const body = { reason: answer.trim() || null };
    void once(async () => {
      setError(null);
      setNotice(null);
      try {
        const res = await apiFetch(`/api/admin/v1/uncollected/${o.orderId}/${action}`, UncollectedDecisionResponse, {
          method: "POST",
          body,
          idempotencyKey: keyFor({ orderId: o.orderId, action, body }),
        });
        succeeded();
        const message =
          res.decision === "credited"
            ? `${o.studentFirstName}: ${formatCents(res.amountCents!)} devolvidos como crédito.`
            : `${o.studentFirstName}: mantido sem devolução.`;
        setNotice(message);
        announce(message);
        await reload();
      } catch (err) {
        fail(err);
      }
    });
  }

  async function review(o: UncollectedOrder) {
    try {
      await apiFetch(`/api/admin/v1/uncollected/${o.orderId}/review`, z.undefined(), { method: "POST" });
      await reload();
    } catch (err) {
      fail(err);
    }
  }

  return (
    <>
      {error && (
        <Alert color="danger" fade={false}>
          {error}
        </Alert>
      )}
      <StatusNotice message={notice} />
      <Card tag="section" className="main-card mb-3">
        <CardHeader tag="h2" className="h6 mb-0">
          Pendentes de decisão
        </CardHeader>
        <CardBody>
          {data && data.pending.length === 0 ? (
            <p className="mb-0">Nenhum pedido pendente de decisão.</p>
          ) : (
            <Table responsive hover striped className="mb-0">
              <thead>{HEAD}</thead>
              <tbody>
                {data?.pending.map((o) => (
                  <tr key={o.orderId}>
                    <Cells o={o} />
                    <td className="text-end text-nowrap">
                      <Button size="sm" color="primary" type="button" className="me-2" onClick={() => decide(o, "credit")}>
                        Devolver como crédito
                      </Button>
                      <Button size="sm" outline color="secondary" type="button" onClick={() => decide(o, "keep")}>
                        Manter sem devolução
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>
      {data && data.toReview.length > 0 && (
        <Card tag="section" className="main-card mb-3">
          <CardHeader tag="h2" className="h6 mb-0">
            Entregues depois da devolução — conferir
          </CardHeader>
          <CardBody>
            <p>O crédito não é desfeito automaticamente. Confira com a família e ajuste a carteira, se for o caso.</p>
            <Table responsive hover striped className="mb-0">
              <thead>{HEAD}</thead>
              <tbody>
                {data.toReview.map((o) => (
                  <tr key={o.orderId}>
                    <Cells o={o} />
                    <td className="text-end">
                      <Button size="sm" outline color="secondary" type="button" onClick={() => void review(o)}>
                        Marcar como conferido
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </CardBody>
        </Card>
      )}
    </>
  );
}
```

`LunchPages.tsx`:

```tsx
export function UncollectedPage() {
  return (
    <OfficeOnly>
      <PageTitle heading="Não retirados" subheading="Pedidos pagos que não foram retirados: devolver como crédito ou manter." icon="pe-7s-attention" />
      <UncollectedAdmin />
    </OfficeOnly>
  );
}
```

`AdminArea.tsx`: `<Route path="lanche/nao-retirados" element={<UncollectedPage />} />`. `adminNav.ts`, depois de `accounts` na lista de admin/secretaria:

```ts
    { to: "/admin/lanche/nao-retirados", label: "Não retirados", icon: "pe-7s-attention", isActive: under("/admin/lanche/nao-retirados") },
```

(Se `formatIsoDate` de `ui/dates` tiver outro formato que não `DD/MM/AAAA`, use o `formatDate` de `ServiceDaysAdmin`.)

- [ ] **Step 6: Specs (regra 23).** Em B.4 da spec F5C, acrescente os exemplos do teste de contrato (`GET /api/admin/v1/uncollected` com um pendente e um "para conferir"; resposta de "Devolver como crédito" `{ "orderId": "0193…", "decision": "credited", "amountCents": 900, "balanceCents": 1500 }`) e: "O motivo, opcional (até 200 caracteres), fica na decisão (`uncollected_decisions`); a auditoria registra o id da decisão. Pedido devolvido e depois entregue aparece em 'Entregues depois da devolução — conferir' até 'Marcar como conferido'." Na spec principal, 5.7, a lista de tipos ganha `uncollected_credit`.

- [ ] **Step 7: Run tests and checks**

Run: `pnpm app:down; docker compose down; pnpm --filter @app-lanche/contracts test && pnpm test:api && pnpm --filter @app-lanche/web test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/contracts/src/uncollected.ts packages/contracts/src/uncollected.test.ts packages/contracts/src/wallet.ts packages/contracts/src/errors.ts packages/contracts/src/index.ts \
  apps/api/src/platform/errors.ts apps/api/src/modules/wallet/service.ts apps/api/src/modules/uncollected apps/api/src/app.ts \
  apps/api/src/modules/dashboard/dashboard.test.ts \
  apps/web/src/areas/admin/UncollectedAdmin.tsx apps/web/src/areas/admin/uncollected.test.tsx apps/web/src/areas/admin/LunchPages.tsx \
  apps/web/src/areas/admin/AdminArea.tsx apps/web/src/areas/admin/adminNav.ts apps/web/src/areas/admin/adminLayout.test.tsx \
  apps/web/src/ui/walletLabels.ts apps/web/src/ui/messages.ts \
  docs/superpowers/specs/2026-11-20-admin-turnos-avisos-design.md docs/superpowers/specs/2026-11-16-app-lanche-design.md
git commit -m "feat(uncollected): office decides refunds for orders not collected"
```

---

### Task 11: Lembretes por turno e finalização de segurança (job)

**Files:**
- Modify: `apps/api/src/modules/reminders/{repo,service}.ts`; Test: `apps/api/src/modules/internal/reminders.test.ts`
- Modify: `packages/contracts/src/internal.ts` (`SafetyFinishResponse`), `packages/contracts/src/internal.test.ts`
- Modify: `apps/api/src/modules/serviceDays/{repo,service}.ts` (`safetyFinish`), `apps/api/src/modules/jobs/routes.ts`
- Test: `apps/api/src/modules/serviceDays/finishJob.test.ts` (novo), `apps/api/src/modules/jobs/jobs.test.ts`
- Modify: `docs/deploy.md` (job `shift-safety-finish`), `docs/superpowers/specs/2026-11-16-app-lanche-design.md` (5.6 e 6.2: corte e lembrete por turno)

**Interfaces:**
- Consumes: `list_due_actions()` com `finish_shifts` (Task 6); `finishShiftInTrx`, `FinishActor` (Task 8); `catalog.listShifts`, `catalog.lockServiceDayByDate` (Task 3).
- Produces (contracts): `SafetyFinishResponse = z.object({ finished: z.number().int().nonnegative(), failed: z.number().int().nonnegative() })`.
- Produces (`serviceDays/service.ts`): `safetyFinish(opts: { log: FastifyBaseLogger; schoolIds?: string[] }): Promise<SafetyFinishResponse>`; constante `SAFETY_FINISH_LOCAL_TIME = "23:00"` (a mesma da agenda).
- Produces (rota): `POST /jobs/v1/shifts/safety-finish` (`job`, cabeçalho `X-Job-Token`).
- Produces (lembretes): `reminders.repo.candidates(trx, { batchId, serviceDayId, serviceDate, cursor, limit })` devolve também `cutoffAt: Date` e `cutoffLocalTime: string` por responsável; `ReminderRecipient` não muda.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/modules/internal/reminders.test.ts` (acrescente; importe `seedTwoShiftFamily`, `seedFamily`):

```ts
  it("reminds only children whose shift still takes orders, with the earliest cutoff among them", async () => {
    const schoolId = await createSchool();
    const day = await seedServiceDay(schoolId, { serviceDate: "2031-05-20", shifts: { matutino: 60, vespertino: 300 } });
    const both = await seedTwoShiftFamily(schoolId); // Léo manhã, Bia tarde
    const morningOnly = await seedFamily(schoolId, ["Caio"], { className: "Infantil 3A", shift: "matutino" });
    const shifts = Object.fromEntries(
      (await adminDb().selectFrom("serviceDayShifts").select(["shift", "cutoffAt"]).where("serviceDayId", "=", day.serviceDayId).execute()).map((s) => [s.shift, s.cutoffAt.toISOString()]),
    );
    const app = buildApp();
    const open = (await app.inject(prepare(schoolId, { service_date: day.serviceDate, cursor: null }))).json();
    const byGuardian = Object.fromEntries(open.recipients.map((r: { guardian_id: string }) => [r.guardian_id, r]));
    expect(byGuardian[both.guardianId]).toMatchObject({ students: ["Bia", "Léo"], cutoff_at: shifts.matutino });
    expect(byGuardian[morningOnly.guardianId]).toMatchObject({ students: ["Caio"], cutoff_at: shifts.matutino });

    // Manhã encerrada: só quem tem filho na tarde, com o corte da tarde.
    const schoolB = await createSchool();
    const dayB = await seedServiceDay(schoolB, { serviceDate: "2031-05-21", shifts: { matutino: -1, vespertino: 300 } });
    const bothB = await seedTwoShiftFamily(schoolB);
    await seedFamily(schoolB, ["Caio"], { className: "Infantil 3A", shift: "matutino" });
    const afternoon = (await app.inject(prepare(schoolB, { service_date: dayB.serviceDate, cursor: null }))).json();
    const cutoffB = await adminDb().selectFrom("serviceDayShifts").select("cutoffAt").where("id", "=", dayB.shiftIds.vespertino!).executeTakeFirstOrThrow();
    expect(afternoon.recipients).toEqual([
      expect.objectContaining({ guardian_id: bothB.guardianId, students: ["Bia"], cutoff_at: cutoffB.cutoffAt.toISOString() }),
    ]);
  });
```

`packages/contracts/src/internal.test.ts` (acrescente):

```ts
  it("describes the safety finish job result", () => {
    expect(SafetyFinishResponse.parse({ finished: 2, failed: 0 })).toEqual({ finished: 2, failed: 0 });
    expect(() => SafetyFinishResponse.parse({ finished: -1, failed: 0 })).toThrow();
  });
```

`apps/api/src/modules/serviceDays/finishJob.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { adminDb, createSchool, seedConfirmedOrders, seedServiceDay } from "../../../test/helpers";
import { buildApp } from "../../app";
import { closeShift, safetyFinish } from "./service";

const log = buildApp().log;

async function closedShiftOn(schoolId: string, serviceDate: string) {
  const day = await seedServiceDay(schoolId, { serviceDate, shifts: { matutino: -30 } });
  const { orderIds } = await seedConfirmedOrders(schoolId, { serviceDayId: day.serviceDayId, serviceDate, menuItemId: day.items[0]!.id, studentNames: ["Léo"] });
  await closeShift(schoolId, serviceDate, "matutino", { log, reconcile: false });
  return { day, orderIds };
}

describe("safetyFinish", () => {
  it("finishes closed shifts after 23:00 school time, once, and leaves earlier ones alone", async () => {
    const schoolId = await createSchool();
    const past = await closedShiftOn(schoolId, "2021-06-01"); // 23:00 de 2021 já passou
    const future = await closedShiftOn(schoolId, "2099-06-01"); // 23:00 ainda não chegou
    expect(await safetyFinish({ log, schoolIds: [schoolId] })).toEqual({ finished: 1, failed: 0 });
    expect(await safetyFinish({ log, schoolIds: [schoolId] })).toEqual({ finished: 0, failed: 0 });
    const shift = await adminDb().selectFrom("serviceDayShifts").select(["status", "finishedByDeviceId", "finishedByStaffId"]).where("id", "=", past.day.shiftIds.matutino!).executeTakeFirstOrThrow();
    expect(shift).toEqual({ status: "finished", finishedByDeviceId: null, finishedByStaffId: null });
    const order = await adminDb().selectFrom("orders").select("status").where("id", "=", past.orderIds[0]!).executeTakeFirstOrThrow();
    expect(order.status).toBe("not_collected");
    const later = await adminDb().selectFrom("serviceDayShifts").select("status").where("id", "=", future.day.shiftIds.matutino!).executeTakeFirstOrThrow();
    expect(later.status).toBe("closed");
    const audit = await adminDb().selectFrom("auditLog").select(["actorKind", "actorId"]).where("schoolId", "=", schoolId).where("action", "=", "shift.finished").execute();
    expect(audit).toEqual([{ actorKind: "system", actorId: null }]);
  });

  it("does not touch an open shift of the same day", async () => {
    const schoolId = await createSchool();
    const day = await seedServiceDay(schoolId, { serviceDate: "2021-06-02", shifts: { matutino: -30, vespertino: -20 } });
    await closeShift(schoolId, day.serviceDate, "matutino", { log, reconcile: false });
    expect(await safetyFinish({ log, schoolIds: [schoolId] })).toEqual({ finished: 1, failed: 0 });
    const afternoon = await adminDb().selectFrom("serviceDayShifts").select("status").where("id", "=", day.shiftIds.vespertino!).executeTakeFirstOrThrow();
    expect(afternoon.status).toBe("open");
  });
});
```

`apps/api/src/modules/jobs/jobs.test.ts` (acrescente):

```ts
  it("runs the shift safety finish with the job token", async () => {
    const spy = vi.spyOn(serviceDays, "safetyFinish").mockResolvedValue({ finished: 2, failed: 0 });
    const res = await buildApp().inject({ method: "POST", url: "/jobs/v1/shifts/safety-finish", headers: { "x-job-token": TOKEN } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ finished: 2, failed: 0 });
    expect(spy).toHaveBeenCalledOnce();
    expect((await buildApp().inject({ method: "POST", url: "/jobs/v1/shifts/safety-finish" })).statusCode).toBe(401);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @app-lanche/contracts test; pnpm app:down; docker compose down; pnpm --filter @app-lanche/api exec vitest run src/modules/internal/reminders.test.ts src/modules/serviceDays/finishJob.test.ts src/modules/jobs`
Expected: FAIL (lembrete inclui o Caio da manhã encerrada e usa o corte do dia; `safetyFinish` e a rota não existem).

- [ ] **Step 3: Reminders** — `reminders/repo.ts`, `candidates`:

```ts
/**
 * Responsáveis com ao menos um filho ativo sem pedido confirmado/entregue na data, num turno ainda aberto e antes do
 * corte (spec F5C, B.1), que ainda não constam como `sent`/`failed` no lote nem como `prepared` há menos de 15 min.
 * `cutoff_at` = menor corte entre os turnos dos filhos ainda sem pedido. Traz `limit + 1` para saber se há próxima página.
 */
export async function candidates(trx: Trx, input: { batchId: string; serviceDayId: string; serviceDate: string; cursor: string | null; limit: number }) {
  const { rows } = await sql<{ guardianId: string; phone: string; firstName: string; students: string[]; cutoffAt: Date; cutoffLocalTime: string }>`
    SELECT g.id AS guardian_id, g.phone_e164 AS phone, g.first_name,
           array_agg(st.first_name ORDER BY st.first_name, st.id) AS students,
           min(sh.cutoff_at) FILTER (WHERE o.ordered IS NULL) AS cutoff_at,
           to_char(min(sh.cutoff_at) FILTER (WHERE o.ordered IS NULL) AT TIME ZONE (SELECT timezone FROM schools WHERE id = app_school_id()), 'HH24:MI') AS cutoff_local_time
    FROM guardians g
    JOIN guardian_students gs ON gs.guardian_id = g.id
    JOIN students st ON st.id = gs.student_id AND st.active
    JOIN classes cl ON cl.id = st.class_id
    JOIN service_day_shifts sh ON sh.service_day_id = ${input.serviceDayId}::uuid AND sh.shift = cl.shift
      AND sh.status = 'open' AND sh.cutoff_at > now()
    LEFT JOIN LATERAL (
      SELECT true AS ordered FROM orders o
      WHERE o.student_id = st.id AND o.service_date = ${input.serviceDate}::date AND o.status IN ('confirmed', 'delivered')
      LIMIT 1
    ) o ON true
    WHERE (${input.cursor}::uuid IS NULL OR g.id > ${input.cursor}::uuid)
      AND NOT EXISTS (
        SELECT 1 FROM message_deliveries md
        WHERE md.batch_id = ${input.batchId}::uuid AND md.guardian_id = g.id
          AND (md.status IN ('sent', 'failed') OR (md.status = 'prepared' AND md.updated_at > now() - interval '15 minutes')))
    GROUP BY g.id
    HAVING bool_or(o.ordered IS NULL)
    ORDER BY g.id
    LIMIT ${input.limit + 1}`.execute(trx);
  return rows;
}
```

Remova `cutoffLocalTime` do repo. Em `reminders/service.ts`, `repo.candidates` recebe `serviceDayId: day.id`, sai a chamada `repo.cutoffLocalTime` e cada destinatário usa `cutoff_at: g.cutoffAt.toISOString()` e `cutoff_local_time: g.cutoffLocalTime`. O link continua sendo criado por `auth.createMagicLink` (vale até o corte mais tarde do dia).

- [ ] **Step 4: Safety finish** — `packages/contracts/src/internal.ts`, junto de `SafetyCloseResponse`:

```ts
/** POST /jobs/v1/shifts/safety-finish */
export const SafetyFinishResponse = z.object({ finished: z.number().int().nonnegative(), failed: z.number().int().nonnegative() });
export type SafetyFinishResponse = z.infer<typeof SafetyFinishResponse>;
```

`serviceDays/repo.ts`:

```ts
/** Já passou das 23:00 da data do dia no fuso da escola (relógio do banco, regra 15)? */
export async function pastSafetyFinishTime(trx: Trx, serviceDayId: string): Promise<boolean> {
  const { rows } = await sql<{ due: boolean }>`
    SELECT now() >= ((d.service_date + time '23:00') AT TIME ZONE s.timezone) AS due
    FROM service_days d JOIN schools s ON s.id = d.school_id WHERE d.id = ${serviceDayId}`.execute(trx);
  return rows[0]?.due ?? false;
}
```

`serviceDays/service.ts`:

```ts
/** Igual à agenda (0013_shift_schedule.sql): turno fechado e não finalizado depois deste horário local é finalizado. */
export const SAFETY_FINISH_LOCAL_TIME = "23:00";

/** Rede de segurança (spec F5C, B.3): finaliza às 23:00 locais o turno fechado que ninguém finalizou. Escola a escola. */
export async function safetyFinish(opts: { log: FastifyBaseLogger; schoolIds?: string[] }): Promise<SafetyFinishResponse> {
  const due = (await listDueActions()).filter((d) => d.action === "finish_shifts" && (!opts.schoolIds || opts.schoolIds.includes(d.schoolId)));
  let finished = 0;
  let failed = 0;
  for (const d of due) {
    try {
      finished += await withTenant(d.schoolId, async (trx) => {
        const day = await catalog.lockServiceDayByDate(trx, d.serviceDate, "share");
        if (!day || !(await repo.pastSafetyFinishTime(trx, day.id))) return 0;
        let n = 0;
        for (const turn of await catalog.listShifts(trx, day.id)) {
          if (turn.status !== "closed") continue;
          if ((await finishShiftInTrx(trx, d.schoolId, day.id, turn.shift, { kind: "system" })) === "finished") n += 1;
        }
        return n;
      });
    } catch (err) {
      failed += 1;
      opts.log.error({ school_id: d.schoolId, service_date: d.serviceDate, err_name: err instanceof Error ? err.name : "UnknownError" }, "safety finish failed");
    }
  }
  return { finished, failed };
}
```

(Em `0013_shift_schedule.sql` o horário está escrito como `time '23:00'`; o comentário da constante aponta para lá. Se mudar um, mude o outro.)

`jobs/routes.ts`:

```ts
  app.post("/jobs/v1/shifts/safety-finish", JOB, async (req): Promise<SafetyFinishResponse> => serviceDays.safetyFinish({ log: req.log }));
```

- [ ] **Step 5: Docs** — `docs/deploy.md`, seção "Jobs e n8n": na lista do Cloud Scheduler acrescente "`shift-safety-finish`: `*/15 * * * *` para `/jobs/v1/shifts/safety-finish` (finaliza às 23:00, no fuso da escola, o turno fechado que ninguém finalizou; os pedidos sem entrega viram não retirados; spec F5C, B.3)." e no bloco de comandos:

```bash
gcloud scheduler jobs create http shift-safety-finish --schedule="*/15 * * * *" \
  --uri="$RUN_URL/jobs/v1/shifts/safety-finish" --http-method=POST \
  --headers="X-Job-Token=$JOBS_TOKEN" --location=southamerica-east1 --time-zone=America/Sao_Paulo
```

e um item na ordem de publicação desta fase: "**F5C Parte B:** aplique as migrações `0012` e `0013` antes de publicar a API; publique API e web juntas (o romaneio do tablet mudou de formato); rode `pnpm n8n:build` e reimporte `n8n/workflows/*.json`; crie o job `shift-safety-finish`."

Na spec principal: 5.6, depois do primeiro parágrafo, "Com turnos (spec F5C, B.1), corte, congelamento, fechamento e romaneio são por turno: `confirmPayment` e o checkout travam `service_day_shifts` `FOR SHARE` depois do dia; fechar trava o turno `FOR UPDATE`; `service_days.cutoff_at`/`freeze_at` espelham o turno mais tarde e o dia fica `closed` quando nenhum turno está aberto."; 6.2, no `reminders/prepare`: "Só entram filhos cujo turno ainda está aberto e antes do corte; `cutoff_at` é o menor corte entre os turnos dos filhos sem pedido."

- [ ] **Step 6: Run tests and checks**

Run: `pnpm app:down; docker compose down; pnpm --filter @app-lanche/contracts test && pnpm test:api && pnpm typecheck && pnpm lint`
Expected: PASS (inclusive `test/n8n.test.ts`, que usa o `prepare` real).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/reminders apps/api/src/modules/internal/reminders.test.ts packages/contracts/src/internal.ts packages/contracts/src/internal.test.ts \
  apps/api/src/modules/serviceDays apps/api/src/modules/jobs docs/deploy.md docs/superpowers/specs/2026-11-16-app-lanche-design.md
git commit -m "feat(jobs): shift safety finish and reminders per shift"
```

---

### Task 12: Verificação final e documentação local

**Files:**
- Modify: `docs/local.md` (onde ficam turnos, "Finalizar turno" e "Não retirados")
- Modify: `CLAUDE.md` **não** (nenhuma regra muda: a regra 16 vale por turno pela spec; se o revisor pedir, pergunte ao usuário antes)

**Interfaces:**
- Consumes: tudo das Tasks 1–11.
- Produces: branch verde de ponta a ponta.

- [ ] **Step 1: Docs locais.** Em `docs/local.md`, na seção do admin (Parte A), acrescente: "Turnos: o turno de cada turma fica no cartão 'Turmas e turnos' em Alunos e responsáveis (ou na coluna `turno` do CSV). Em Lanche → Dias de serviço, cada dia mostra os turnos com 'Fechar turno' e 'Finalizar turno'. Lanche → Não retirados lista os pedidos de turnos finalizados que ninguém retirou. No tablet, as abas Manhã/Tarde aparecem quando o dia tem os dois turnos; 'Finalizar turno' funciona sem rede. O seed de demonstração põe a turma Infantil 4B na tarde."

- [ ] **Step 2: Busca de pendências do plano**

Run: `grep -rn "markServiceDayClosed\|default_cutoff_time\|defaultCutoffTime\|cutoffTime\b" apps packages db e2e --include=*.ts --include=*.tsx --include=*.sql | grep -v node_modules | grep -v "db/migrations/000[1-9]\|db/migrations/001[01]"`
Expected: nenhuma linha (os nomes antigos sumiram fora das migrações já aplicadas).

- [ ] **Step 3: Suite completa**

Run: `pnpm app:down; docker compose down; pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS.

Run: `pnpm db:up && pnpm test:e2e; docker compose down`
Expected: PASS (`kds.spec.ts`, `counter.spec.ts`, `shifts.spec.ts`).

Run: `pnpm n8n:build && git diff --exit-code n8n/workflows`
Expected: sem diferença (os fluxos commitados já estão gerados).

- [ ] **Step 4: Conferência manual rápida** (`pnpm app:up`, seed de demonstração): abrir um dia para hoje com corte da manhã já passado e da tarde no futuro; pedir como Ana (manhã) e como Bruno (Caio, tarde) e ver um cartão por turno; fechar a manhã no admin; parear o tablet, ver as abas, marcar uma entrega sem rede, finalizar a manhã, voltar a rede; conferir "Não retirados" e devolver um como crédito; ver no extrato da família "Lanche não retirado — devolvido". `pnpm app:down` no fim.

- [ ] **Step 5: Commit**

```bash
git add docs/local.md
git commit -m "docs(local): where shifts, finishing and uncollected orders live"
```

---

## Self-review (feita ao escrever o plano)

- **Cobertura da spec (Parte B):** B.1 modelo → Tasks 1–4, 6; CSV `turno` → Task 2; dia com corte por turno → Task 3; `service_days` espelho e dia `closed` com todos os turnos → Tasks 3 e 6; romaneio com `shift` e imutável → Task 6; regras 15–17 por turno (FOR SHARE/UPDATE, crédito tardio) → Tasks 4 e 6 (teste de concorrência pagamento × fechamento do turno); `not_collected` e `uncollected_credit` com índice único parcial → Tasks 1, 8, 10. B.2 admin dias com situação por turno → Tasks 3, 6, 8. B.3 abas, botão com confirmação e contagem, transação IndexedDB, ordem de envio, idempotência e dois tablets, entrega depois de finalizar, rede de segurança 23:00 a cada 15 min → Tasks 7, 8, 9, 11. B.4 página "Não retirados", crédito com `FOR UPDATE` e `Idempotency-Key`, auditoria com motivo opcional, "Manter sem devolução" registrado, indicador do painel → Task 10. Testes da spec (corte e fechamento por turno, concorrência, finalização idempotente e de dois tablets, entrega depois da finalização, crédito uma vez, job, Playwright offline com fila) → Tasks 4, 6, 8, 9, 10, 11. Orientações 11 (lembretes) e 12 (link) → Tasks 11 e 4.
- **Placeholders:** os únicos trechos "copie o JSX atual" (Tasks 5 e 7) apontam o arquivo e o bloco exatos e dizem que o texto não muda.
- **Consistência de nomes:** `lockShift`/`listShifts`/`LockedShift` (Task 3) usados nas Tasks 4, 6, 7, 8, 10, 11; `closeShift`/`closeServiceDay({ due })`/`getManifest(…, shift)` (Task 6); `finishShiftInTrx`/`FinishActor`/`FinishOutcome` (Task 8) usados nas Tasks 8 e 11; `seedServiceDay({ shifts })` → `shiftIds`, `seedConfirmedOrders`, `seedTwoShiftFamily`, `moveCutoff`, `markDayClosed` (Tasks 1 e 4); `mergeManifest`/`pickShift`/`finishesReadyToSend`/`finishShift` (Tasks 7 e 9); `SHIFT_LABELS` (Task 2).

