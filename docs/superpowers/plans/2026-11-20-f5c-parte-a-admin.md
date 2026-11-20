# F5C Parte A — Admin reorganizado e painel de indicadores — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Menu do admin em grupos (Escola / Lanche), páginas próprias para dias, cardápio e tablets, importação CSV dentro de "Alunos e responsáveis" e página inicial com indicadores (valores em reais ocultos por padrão).

**Architecture:** Uma rota nova `GET /api/admin/v1/dashboard?period=today|7d|month` num módulo `dashboard` (SQL só no `repo.ts`, período resolvido pelo relógio do banco no fuso da escola, blocos por papel). Na web, o `AppSidebar` passa a aceitar títulos de grupo; `adminNav` monta os grupos; `MenuAdmin`, `ServiceDaysAdmin` e `KitchenDevicesAdmin` viram páginas em `/admin/lanche/*`; o formulário de importação sai da página inicial para um painel dentro de `StudentsAdmin`; a página inicial vira o painel.

**Tech Stack:** Fastify + Kysely (`sql` template) + PostgreSQL com RLS; zod em `packages/contracts`; React 19 + reactstrap (tema ArchitectUI) no admin; Vitest + Testcontainers; Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-20-admin-turnos-avisos-design.md` (Parte A). Regras do projeto: `CLAUDE.md`.

## Global Constraints

- Todo acesso ao banco dentro de `withTenant(schoolId, …)`; `school_id` vem da sessão (regras 1–2).
- Dinheiro em centavos inteiros; somas `bigint` no SQL com `::bigint` (o `sum` de `bigint` no Postgres devolve `numeric`); nunca `float` nem `toFixed` (regra 6).
- A única fonte de tempo para regra de negócio é o banco (`now()`), no fuso `schools.timezone` (regra 15).
- Mudou um contrato? Schema em `packages/contracts`, exemplo na spec e teste de contrato no mesmo commit (regra 23).
- Toda rota declara `kind` e papéis (regra 26). Respostas `/api/**` já levam `Cache-Control: private, no-store` pelo app.
- Nada de nome, telefone ou valor por aluno em log (regra 28).
- Texto de interface em português do Brasil; código, nomes e commits em inglês.
- Nenhuma dependência, tabela ou migração nova nesta parte.
- Valores ocultos: em reais aparece "R$ ••••"; botão "Mostrar valores" / "Ocultar valores" com `aria-pressed`; a escolha **não** é guardada (cada montagem da página começa oculta). Contagens e percentuais nunca são ocultados.
- Cozinha vê só o bloco Lanches, sem valores; o servidor manda `documents: null` e `money: null` para ela.
- Antes de cada commit: `pnpm typecheck && pnpm lint` e os testes do pacote tocado. Testes de API precisam do compose desligado nesta máquina WSL (`pnpm app:down`).

---

### Task 1: Contrato do painel

**Files:**
- Create: `packages/contracts/src/dashboard.ts`
- Create: `packages/contracts/src/dashboard.test.ts`
- Modify: `packages/contracts/src/index.ts` (exportar)
- Modify: `docs/superpowers/specs/2026-11-20-admin-turnos-avisos-design.md` (exemplo de resposta em A.3)

**Interfaces:**
- Produces: `DashboardPeriod` (`"today" | "7d" | "month"`), `DashboardQuery` (`{ period }` com padrão `"today"`), `DashboardResponse` e os tipos inferidos de mesmo nome.

- [ ] **Step 1: Write the failing test** — `packages/contracts/src/dashboard.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { DashboardQuery, DashboardResponse } from "./dashboard";

const SAMPLE = {
  period: "7d",
  from: "2026-11-14",
  to: "2026-11-20",
  snacks: { paidOrders: 42, deliveredOrders: 40, notCollectedOrders: 2, counterSales: 15, topItems: [{ name: "Misto quente", qty: 30 }] },
  documents: { published: 80, viewed: 61, batchesRendering: 0, batchesWithFailures: 1 },
  money: { pixReceivedCents: 125_000, counterCents: 22_500, creditsCents: 48_000, debtCents: 3_500, debtors: 3 },
};

describe("dashboard contracts", () => {
  it("defaults the period to today and refuses unknown periods", () => {
    expect(DashboardQuery.parse({})).toEqual({ period: "today" });
    expect(DashboardQuery.parse({ period: "month" })).toEqual({ period: "month" });
    expect(() => DashboardQuery.parse({ period: "year" })).toThrow();
  });

  it("accepts the spec example and the kitchen shape without documents and money", () => {
    expect(DashboardResponse.parse(SAMPLE)).toEqual(SAMPLE);
    expect(DashboardResponse.parse({ ...SAMPLE, documents: null, money: null }).money).toBeNull();
  });

  it("allows totals above the per-charge cap and zero, but no negatives, fractions or more than five top items", () => {
    expect(DashboardResponse.parse({ ...SAMPLE, money: { ...SAMPLE.money, pixReceivedCents: 50_000_000, debtCents: 0 } })).toBeTruthy();
    expect(() => DashboardResponse.parse({ ...SAMPLE, money: { ...SAMPLE.money, debtCents: -1 } })).toThrow();
    expect(() => DashboardResponse.parse({ ...SAMPLE, money: { ...SAMPLE.money, counterCents: 10.5 } })).toThrow();
    const six = Array.from({ length: 6 }, (_, i) => ({ name: `Item ${i}`, qty: 1 }));
    expect(() => DashboardResponse.parse({ ...SAMPLE, snacks: { ...SAMPLE.snacks, topItems: six } })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @app-lanche/contracts exec vitest run src/dashboard.test.ts`
Expected: FAIL (`Cannot find module './dashboard'`).

- [ ] **Step 3: Write the implementation** — `packages/contracts/src/dashboard.ts`

```ts
import { z } from "zod";
import { IsoDate } from "./common";

export const DashboardPeriod = z.enum(["today", "7d", "month"]);
export type DashboardPeriod = z.infer<typeof DashboardPeriod>;

/** GET /api/admin/v1/dashboard?period=… (padrão: hoje). */
export const DashboardQuery = z.object({ period: DashboardPeriod.default("today") });
export type DashboardQuery = z.infer<typeof DashboardQuery>;

const Count = z.number().int().nonnegative();
/** Totais do período: podem passar do teto de uma cobrança (`Cents`) e podem ser zero. */
const TotalCents = z.number().int().nonnegative();

/**
 * Indicadores da página inicial do admin (spec F5C, A.3). `from`/`to` são datas locais da escola, inclusivas.
 * `documents` e `money` são `null` para a cozinha.
 */
export const DashboardResponse = z.object({
  period: DashboardPeriod,
  from: IsoDate,
  to: IsoDate,
  snacks: z.object({
    paidOrders: Count,
    deliveredOrders: Count,
    notCollectedOrders: Count,
    counterSales: Count,
    topItems: z.array(z.object({ name: z.string(), qty: Count })).max(5),
  }),
  documents: z
    .object({ published: Count, viewed: Count, batchesRendering: Count, batchesWithFailures: Count })
    .nullable(),
  money: z
    .object({ pixReceivedCents: TotalCents, counterCents: TotalCents, creditsCents: TotalCents, debtCents: TotalCents, debtors: Count })
    .nullable(),
});
export type DashboardResponse = z.infer<typeof DashboardResponse>;
```

Em `packages/contracts/src/index.ts`, adicione `export * from "./dashboard";` em ordem alfabética com os demais.

- [ ] **Step 4: Spec example.** Em `docs/superpowers/specs/2026-11-20-admin-turnos-avisos-design.md`, ao fim da seção A.3 (antes de "## Parte B"), acrescente:

````markdown
Exemplo de resposta (`period=7d`, papel secretaria; para a cozinha `documents` e `money` vêm `null`):

```json
{
  "period": "7d", "from": "2026-11-14", "to": "2026-11-20",
  "snacks": { "paidOrders": 42, "deliveredOrders": 40, "notCollectedOrders": 2, "counterSales": 15,
              "topItems": [{ "name": "Misto quente", "qty": 30 }] },
  "documents": { "published": 80, "viewed": 61, "batchesRendering": 0, "batchesWithFailures": 1 },
  "money": { "pixReceivedCents": 125000, "counterCents": 22500, "creditsCents": 48000, "debtCents": 3500, "debtors": 3 }
}
```
````

- [ ] **Step 5: Run tests and checks**

Run: `pnpm --filter @app-lanche/contracts exec vitest run && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/dashboard.ts packages/contracts/src/dashboard.test.ts packages/contracts/src/index.ts docs/superpowers/specs/2026-11-20-admin-turnos-avisos-design.md
git commit -m "feat(contracts): admin dashboard query and response"
```

---

### Task 2: Rota de indicadores na API

**Files:**
- Create: `apps/api/src/modules/dashboard/repo.ts`
- Create: `apps/api/src/modules/dashboard/service.ts`
- Create: `apps/api/src/modules/dashboard/routes.ts`
- Create: `apps/api/src/modules/dashboard/dashboard.test.ts`
- Modify: `apps/api/src/app.ts` (registrar `dashboardRoutes` junto dos outros `app.register(...)`)

**Interfaces:**
- Consumes: `DashboardQuery`, `DashboardResponse`, `DashboardPeriod` (Task 1); `withTenant`, `Trx` de `../../db/index`; `SessionClaims` de `../../platform/session` (para equipe, `session.role` já vem relido do banco pelo `app.ts`); `RouteAuth` de `../../app`.
- Produces: `GET /api/admin/v1/dashboard` (qualquer papel de equipe).

Definições (valem para todo o SQL):
- Período em datas locais da escola: `today = (now() AT TIME ZONE timezone)::date`; `today` → `[today, today]`; `7d` → `[today - 6, today]`; `month` → `[primeiro dia do mês de today, today]`.
- Limites em instante: `fromTs = from::timestamp AT TIME ZONE timezone`, `toTs = (to + 1)::timestamp AT TIME ZONE timezone` (intervalo `[fromTs, toTs)`).
- Pedidos contam por `orders.service_date BETWEEN from AND to`: pagos = status em `confirmed`, `delivered`, `not_collected`; entregues = `delivered`; não retirados = `not_collected` (o status passa a existir na Parte B; até lá a contagem é zero).
- Balcão: `counter_sales` com `voided_at IS NULL` e `occurred_at` no intervalo.
- Itens mais pedidos: soma de `qty` dos itens de pedidos pagos do período + itens de lançamentos não estornados do período, por item do cardápio; ordem por quantidade desc, depois nome; no máximo 5.
- Documentos: documentos `rendered` de lotes `published` com `published_at` no intervalo; `viewed` = desses, os que têm ao menos uma linha em `document_views`. Lotes em geração (`document_batches.status = 'rendering'`) e lotes com documento `failed` não descartado contam o estado atual, sem período.
- Valores: Pix recebido = `payments` com `status = 'paid'` e `paid_at` no intervalo (pedidos e recargas); consumo no balcão = soma de `total_cents` dos lançamentos do período; créditos, débito e devedores = estado atual de `wallets` (`balance_cents > 0` soma créditos; `< 0` soma débito em valor positivo e conta devedores).

- [ ] **Step 1: Write the failing tests** — `apps/api/src/modules/dashboard/dashboard.test.ts`

```ts
import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { describe, expect, it } from "vitest";
import { adminDb, createSchool, kitchenCookie, seedClosedDayWithOrders, seedFamily, seedTenant, staffCookie } from "../../../test/helpers";
import { buildApp } from "../../app";
import { withTenant } from "../../db/index";
import { applySales } from "../counter/service";

/** Data local da escola deslocada em dias (texto YYYY-MM-DD). */
async function localDate(schoolId: string, offsetDays: number): Promise<string> {
  const { rows } = await sql<{ d: string }>`
    SELECT ((now() AT TIME ZONE timezone)::date + ${offsetDays}::int)::text AS d FROM schools WHERE id = ${schoolId}`.execute(adminDb());
  return rows[0]!.d;
}

async function firstOfMonth(schoolId: string, monthsBack: number): Promise<string> {
  const { rows } = await sql<{ d: string }>`
    SELECT (date_trunc('month', (now() AT TIME ZONE timezone)::date) - make_interval(months => ${monthsBack}))::date::text AS d
    FROM schools WHERE id = ${schoolId}`.execute(adminDb());
  return rows[0]!.d;
}

async function payCheckoutOf(schoolId: string, orderId: string, amountCents: number): Promise<void> {
  const { checkoutId } = await adminDb().selectFrom("orders").select("checkoutId").where("id", "=", orderId).executeTakeFirstOrThrow();
  await adminDb()
    .insertInto("payments")
    .values({ id: uuidv7(), schoolId, checkoutId, provider: "fake", method: "pix", amountCents, status: "paid", paidAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000) })
    .execute();
}

async function sell(schoolId: string, studentId: string, menuItemId: string, qty: number): Promise<string> {
  const { deviceId } = await kitchenCookie(schoolId);
  const id = uuidv7();
  await withTenant(schoolId, (trx) =>
    applySales(trx, schoolId, { source: "kitchen", deviceId }, [{ id, studentId, items: [{ menuItemId, qty }], occurredAt: null }], "record"),
  );
  return id;
}

const get = (cookies: Record<string, string>, period?: string) =>
  buildApp().inject({ method: "GET", url: `/api/admin/v1/dashboard${period ? `?period=${period}` : ""}`, cookies });

describe("admin dashboard", () => {
  it("counts today's orders, counter sales, top items and money for the office", async () => {
    const schoolId = await createSchool();
    const today = await localDate(schoolId, 0);
    const day = await seedClosedDayWithOrders(schoolId, { serviceDate: today, studentNames: ["Léo", "Bia"] });
    await adminDb().updateTable("orders").set({ status: "delivered" }).where("id", "=", day.orderIds[0]!).execute();
    await payCheckoutOf(schoolId, day.orderIds[0]!, 1800);
    const { name: mistoName, id: mistoId } = await adminDb()
      .selectFrom("orderItems").innerJoin("menuItems", "menuItems.id", "orderItems.menuItemId")
      .select(["menuItems.name", "menuItems.id"]).where("orderItems.orderId", "=", day.orderIds[0]!).executeTakeFirstOrThrow();
    const fam = await seedFamily(schoolId, ["Caio"]);
    await sell(schoolId, fam.studentIds[0]!, mistoId, 2); // 2 x 900 = 1800, wallet -1800
    const voided = await sell(schoolId, fam.studentIds[0]!, mistoId, 1);
    await adminDb().updateTable("counterSales").set({ voidedAt: new Date() }).where("id", "=", voided).execute();
    const { cookies } = await staffCookie(schoolId, "secretaria");

    const res = await get(cookies);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ period: "today", from: today, to: today });
    expect(body.snacks).toEqual({ paidOrders: 2, deliveredOrders: 1, notCollectedOrders: 0, counterSales: 1, topItems: [{ name: mistoName, qty: 4 }] });
    // A carteira de Caio levou 1800 + 900; o estorno feito à mão acima só marca voided_at (não grava counter_void),
    // então o débito continua 2700, mas o lançamento estornado sai das contagens e do consumo.
    expect(body.money).toEqual({ pixReceivedCents: 1800, counterCents: 1800, creditsCents: 0, debtCents: 2700, debtors: 1 });
    expect(body.documents).toEqual({ published: 0, viewed: 0, batchesRendering: 0, batchesWithFailures: 0 });
  });

  it("resolves 7 days and the current month in the school's local calendar", async () => {
    const schoolId = await createSchool();
    const today = await localDate(schoolId, 0);
    const firstDay = await firstOfMonth(schoolId, 0);
    const { rows } = await sql<{ d: string }>`
      SELECT (date_trunc('month', (now() AT TIME ZONE timezone)::date) - interval '1 day')::date::text AS d
      FROM schools WHERE id = ${schoolId}`.execute(adminDb());
    // Um pedido por aluno; o resultado depende do dia do mês em que o teste roda, então o esperado sai das datas.
    const dates: Record<string, string> = {
      Léo: await localDate(schoolId, -6), // sempre dentro de 7d
      Bia: await localDate(schoolId, -7), // sempre fora de 7d
      Caio: firstDay, // sempre dentro do mês
      Duda: rows[0]!.d, // sempre fora do mês
    };
    // Datas iguais (ex.: dia 1 = hoje-6) viram um só dia de serviço: service_days é único por data.
    const byDate = new Map<string, string[]>();
    for (const [name, d] of Object.entries(dates)) byDate.set(d, [...(byDate.get(d) ?? []), name]);
    for (const [serviceDate, studentNames] of byDate) await seedClosedDayWithOrders(schoolId, { serviceDate, studentNames });
    const inRange = (d: string, from: string, to: string) => d >= from && d <= to;
    const { cookies } = await staffCookie(schoolId, "admin");

    const week = (await get(cookies, "7d")).json();
    expect([week.from, week.to]).toEqual([dates.Léo, today]);
    expect(inRange(dates.Bia!, week.from, week.to)).toBe(false);
    expect(week.snacks.paidOrders).toBe(Object.values(dates).filter((d) => inRange(d, week.from, week.to)).length);

    const month = (await get(cookies, "month")).json();
    expect([month.from, month.to]).toEqual([firstDay, today]);
    expect(inRange(dates.Duda!, month.from, month.to)).toBe(false);
    expect(month.snacks.paidOrders).toBe(Object.values(dates).filter((d) => inRange(d, firstDay, today)).length);
  });

  it("counts published documents and how many were opened", async () => {
    const schoolId = await createSchool();
    const ids = await seedTenant(schoolId);
    await adminDb().updateTable("documentBatches").set({ status: "published", publishedAt: new Date() }).where("id", "=", ids.documentBatchId).execute();
    await adminDb()
      .updateTable("documents")
      .set({ status: "rendered", storagePath: `schools/${schoolId}/x.pdf`, sha256: "a".repeat(64), renderedAt: new Date(), leaseUntil: null })
      .where("id", "=", ids.documentId)
      .execute();
    await adminDb().insertInto("documentViews").values({ id: uuidv7(), schoolId, documentId: ids.documentId, guardianId: ids.guardianId }).execute();
    const { cookies } = await staffCookie(schoolId, "secretaria");

    const body = (await get(cookies, "today")).json();
    expect(body.documents).toEqual({ published: 1, viewed: 1, batchesRendering: 0, batchesWithFailures: 0 });
  });

  it("gives the kitchen only the snacks block", async () => {
    const schoolId = await createSchool();
    const { cookies } = await staffCookie(schoolId, "cozinha");
    const body = (await get(cookies)).json();
    expect(body.documents).toBeNull();
    expect(body.money).toBeNull();
    expect(body.snacks.paidOrders).toBe(0);
  });

  it("does not count another school's data", async () => {
    const a = await createSchool();
    const b = await createSchool();
    await seedClosedDayWithOrders(b, { serviceDate: await localDate(b, 0), studentNames: ["Léo"] });
    const { cookies } = await staffCookie(a, "admin");
    const body = (await get(cookies)).json();
    expect(body.snacks.paidOrders).toBe(0);
    expect(body.money).toMatchObject({ pixReceivedCents: 0, creditsCents: 0, debtCents: 0, debtors: 0 });
  });

  it("refuses an unknown period and anonymous visitors", async () => {
    const schoolId = await createSchool();
    const { cookies } = await staffCookie(schoolId, "admin");
    expect((await get(cookies, "year")).statusCode).toBe(400);
    expect((await get({})).statusCode).toBe(401);
  });
});
```

Notas para o implementador:
- `seedTenant` deixa o lote de documento num estado qualquer; ajuste o `updateTable("documents")` às colunas reais (`storage_path`, `sha256`, `rendered_at`, `lease_until`) e aos CHECKs de `0009_documents.sql` se o update falhar. Se o `seedTenant` inserir `payments` pagos hoje, o teste de documentos não confere `money` (de propósito).
- O teste de 7 dias/mês calcula o esperado a partir das datas, porque o resultado depende do dia do mês em que roda; ele cobre: hoje-6 conta em 7d, hoje-7 não; dia 1 do mês conta em `month`, último dia do mês anterior não.
- `firstOfMonth(schoolId, 0)` é o único uso dessa função; se o lint reclamar do parâmetro sempre 0, simplifique a função.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm app:down; pnpm --filter @app-lanche/api exec vitest run src/modules/dashboard/dashboard.test.ts`
Expected: FAIL (rota inexistente: 404 em vez de 200).

- [ ] **Step 3: Implement the repo** — `apps/api/src/modules/dashboard/repo.ts`

```ts
import type { DashboardPeriod } from "@app-lanche/contracts";
import { sql } from "kysely";
import type { Trx } from "../../db/index";

export type Period = { from: string; to: string; fromTs: Date; toTs: Date };

/** Datas locais da escola (inclusivas) e o intervalo de instantes [fromTs, toTs), pelo relógio do banco. */
export async function resolvePeriod(trx: Trx, period: DashboardPeriod): Promise<Period> {
  const { rows } = await sql<{ from: string; to: string; fromTs: Date; toTs: Date }>`
    WITH s AS (
      SELECT timezone AS tz, (now() AT TIME ZONE timezone)::date AS today FROM schools WHERE id = app_school_id()
    ), b AS (
      SELECT tz, today,
        CASE ${period}::text
          WHEN 'today' THEN today
          WHEN '7d' THEN today - 6
          ELSE date_trunc('month', today)::date
        END AS from_date
      FROM s
    )
    SELECT from_date::text AS "from", today::text AS "to",
      (from_date::timestamp AT TIME ZONE tz) AS from_ts,
      ((today + 1)::timestamp AT TIME ZONE tz) AS to_ts
    FROM b`.execute(trx);
  return rows[0]!;
}

export async function snackCounts(trx: Trx, p: Period) {
  const { rows } = await sql<{ paidOrders: number; deliveredOrders: number; notCollectedOrders: number; counterSales: number }>`
    SELECT
      (SELECT count(*) FROM orders WHERE service_date BETWEEN ${p.from}::date AND ${p.to}::date
         AND status IN ('confirmed', 'delivered', 'not_collected')) AS paid_orders,
      (SELECT count(*) FROM orders WHERE service_date BETWEEN ${p.from}::date AND ${p.to}::date
         AND status = 'delivered') AS delivered_orders,
      (SELECT count(*) FROM orders WHERE service_date BETWEEN ${p.from}::date AND ${p.to}::date
         AND status = 'not_collected') AS not_collected_orders,
      (SELECT count(*) FROM counter_sales WHERE voided_at IS NULL
         AND occurred_at >= ${p.fromTs} AND occurred_at < ${p.toTs}) AS counter_sales`.execute(trx);
  return rows[0]!;
}

export async function topItems(trx: Trx, p: Period) {
  const { rows } = await sql<{ name: string; qty: number }>`
    SELECT m.name, sum(x.qty)::bigint AS qty
    FROM (
      SELECT oi.menu_item_id, oi.qty FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.service_date BETWEEN ${p.from}::date AND ${p.to}::date
        AND o.status IN ('confirmed', 'delivered', 'not_collected')
      UNION ALL
      SELECT ci.menu_item_id, ci.qty FROM counter_sale_items ci JOIN counter_sales c ON c.id = ci.sale_id
      WHERE c.voided_at IS NULL AND c.occurred_at >= ${p.fromTs} AND c.occurred_at < ${p.toTs}
    ) x
    JOIN menu_items m ON m.id = x.menu_item_id
    GROUP BY m.id, m.name
    ORDER BY qty DESC, m.name
    LIMIT 5`.execute(trx);
  return rows;
}

export async function documentCounts(trx: Trx, p: Period) {
  const { rows } = await sql<{ published: number; viewed: number; batchesRendering: number; batchesWithFailures: number }>`
    SELECT
      (SELECT count(*) FROM documents d JOIN document_batches b ON b.id = d.batch_id
         WHERE b.status = 'published' AND b.published_at >= ${p.fromTs} AND b.published_at < ${p.toTs}
           AND d.status = 'rendered') AS published,
      (SELECT count(*) FROM documents d JOIN document_batches b ON b.id = d.batch_id
         WHERE b.status = 'published' AND b.published_at >= ${p.fromTs} AND b.published_at < ${p.toTs}
           AND d.status = 'rendered' AND EXISTS (SELECT 1 FROM document_views v WHERE v.document_id = d.id)) AS viewed,
      (SELECT count(*) FROM document_batches WHERE status = 'rendering') AS batches_rendering,
      (SELECT count(DISTINCT batch_id) FROM documents WHERE status = 'failed' AND discarded_at IS NULL) AS batches_with_failures`.execute(trx);
  return rows[0]!;
}

export async function moneyTotals(trx: Trx, p: Period) {
  const { rows } = await sql<{ pixReceivedCents: number; counterCents: number; creditsCents: number; debtCents: number; debtors: number }>`
    SELECT
      (SELECT coalesce(sum(amount_cents), 0)::bigint FROM payments
         WHERE status = 'paid' AND paid_at >= ${p.fromTs} AND paid_at < ${p.toTs}) AS pix_received_cents,
      (SELECT coalesce(sum(total_cents), 0)::bigint FROM counter_sales
         WHERE voided_at IS NULL AND occurred_at >= ${p.fromTs} AND occurred_at < ${p.toTs}) AS counter_cents,
      (SELECT coalesce(sum(balance_cents) FILTER (WHERE balance_cents > 0), 0)::bigint FROM wallets) AS credits_cents,
      (SELECT coalesce(-sum(balance_cents) FILTER (WHERE balance_cents < 0), 0)::bigint FROM wallets) AS debt_cents,
      (SELECT count(*) FROM wallets WHERE balance_cents < 0) AS debtors`.execute(trx);
  return rows[0]!;
}
```

Notas: `app_school_id()` é a função usada em `catalog/repo.ts`; o RLS já limita cada tabela ao tenant, então as subconsultas não repetem `school_id`. `count(*)` é `bigint` e o parser de INT8 de `src/db/index.ts` devolve `number`. A coluna de `documents` que liga ao lote é `batch_id` (veja `0009_documents.sql`).

- [ ] **Step 4: Implement the service** — `apps/api/src/modules/dashboard/service.ts`

```ts
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
```

Se o tipo `SessionClaims` não tiver `role` acessível assim (é união por `kind`), estreite com o mesmo padrão que `wallet/service.ts` usa para ler o papel da equipe.

- [ ] **Step 5: Implement the route** — `apps/api/src/modules/dashboard/routes.ts`

```ts
import { DashboardQuery } from "@app-lanche/contracts";
import type { FastifyInstance } from "fastify";
import type { RouteAuth } from "../../app";
import * as service from "./service";

const STAFF: RouteAuth = { kind: "staff", roles: ["admin", "secretaria", "cozinha"] };

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/admin/v1/dashboard", { config: { auth: STAFF } }, async (req) =>
    service.getDashboard(req.session!, DashboardQuery.parse(req.query)),
  );
}
```

Em `apps/api/src/app.ts`: `import { dashboardRoutes } from "./modules/dashboard/routes";` e `app.register(dashboardRoutes);` logo depois de `app.register(walletRoutes);`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @app-lanche/api exec vitest run src/modules/dashboard/dashboard.test.ts`
Expected: PASS (6 testes). Depois `pnpm typecheck && pnpm lint`.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/dashboard apps/api/src/app.ts
git commit -m "feat(api): admin dashboard indicators by period and role"
```

---

### Task 3: Menu em grupos e páginas de Lanche

**Files:**
- Modify: `apps/web/src/theme/layout/AppSidebar.tsx` (títulos de grupo)
- Modify: `apps/web/src/theme/layout/layout.test.tsx` (um teste de título)
- Modify: `apps/web/src/areas/admin/adminNav.ts`
- Create: `apps/web/src/areas/admin/LunchPages.tsx`
- Modify: `apps/web/src/areas/admin/AdminArea.tsx` (rotas `lanche/*`)
- Modify: `apps/web/src/areas/admin/AdminHome.tsx` (tirar as seções, rolagem por âncora e redirecionar âncoras antigas)
- Modify: `apps/web/src/areas/admin/MenuAdmin.tsx`, `ServiceDaysAdmin.tsx`, `KitchenDevicesAdmin.tsx` (remover a prop `onLoaded`, que só servia à rolagem)
- Modify: `apps/web/src/areas/admin/adminLayout.test.tsx`, `apps/web/src/areas/admin/catalogAdmin.test.tsx`

**Interfaces:**
- Produces: `export type NavEntry = NavItem | { heading: string }` em `AppSidebar.tsx`; `AppSidebar({ items }: { items: NavEntry[] })`; `adminNav(role): NavEntry[]`; componentes `ServiceDaysPage`, `MenuPage`, `KitchenDevicesPage` em `LunchPages.tsx`; rotas `/admin/lanche/dias`, `/admin/lanche/cardapio`, `/admin/lanche/tablets`.

Menu final (exato, nesta ordem):
- admin/secretaria: `Início` · título `Escola` · `Alunos e responsáveis` (`/admin/alunos`) · `Documentos` (`/admin/documentos`) · título `Lanche` · `Dias de serviço` (`/admin/lanche/dias`, ícone `pe-7s-date`) · `Cardápio` (`/admin/lanche/cardapio`, `pe-7s-note2`) · `Tablets da cozinha` (`/admin/lanche/tablets`, `pe-7s-display2`) · `Contas` (`/admin/contas`).
- cozinha: `Início` · título `Lanche` · `Contas`.
- `Início` fica ativo só em `/admin` exato (sem olhar o hash).

- [ ] **Step 1: Write the failing tests**

Em `apps/web/src/areas/admin/adminLayout.test.tsx`, troque o primeiro teste pela versão nova e ajuste o da cozinha:

```tsx
  it("groups the office menu under Escola and Lanche, highlighting the current page", async () => {
    mockApi({ "GET /api/admin/v1/me": me("secretaria") });
    renderAt("/admin/documentos/lotes/0193a000-0000-7000-8000-000000000009");
    await screen.findByText("Escola Sol");
    expect(screen.getByText("ana@escola.test")).toBeTruthy();
    expect(screen.getByText("Secretaria")).toBeTruthy();
    expect(menu().getAllByRole("link").map((a) => a.textContent)).toEqual([
      "Início",
      "Alunos e responsáveis",
      "Documentos",
      "Dias de serviço",
      "Cardápio",
      "Tablets da cozinha",
      "Contas",
    ]);
    expect(menu().getByText("Escola").className).toContain("app-sidebar__heading");
    expect(menu().getByText("Lanche").className).toContain("app-sidebar__heading");
    expect(menu().getByRole("link", { name: "Documentos" }).getAttribute("aria-current")).toBe("page");
    expect(menu().getByRole("link", { name: "Início" }).getAttribute("aria-current")).toBeNull();
    expect(menu().getByRole("link", { name: "Dias de serviço" }).getAttribute("href")).toBe("/admin/lanche/dias");
    expect(menu().getByRole("link", { name: "Cardápio" }).getAttribute("href")).toBe("/admin/lanche/cardapio");
    expect(menu().getByRole("link", { name: "Tablets da cozinha" }).getAttribute("href")).toBe("/admin/lanche/tablets");
    expect(screen.getByText("página de documentos")).toBeTruthy();
  });

  it("shows the home page and the accounts to the kitchen", async () => {
    mockApi({ "GET /api/admin/v1/me": me("cozinha") });
    renderAt("/admin");
    await screen.findByText("Cozinha");
    expect(menu().getAllByRole("link").map((a) => a.textContent)).toEqual(["Início", "Contas"]);
    expect(menu().queryByText("Escola")).toBeNull();
  });
```

Em `apps/web/src/areas/admin/catalogAdmin.test.tsx`:
- importe `{ KitchenDevicesPage, MenuPage, ServiceDaysPage } from "./LunchPages"`;
- em `renderAdmin`, dentro da rota `/admin`, acrescente `<Route path="lanche/dias" element={<ServiceDaysPage />} />`, `<Route path="lanche/cardapio" element={<MenuPage />} />` e `<Route path="lanche/tablets" element={<KitchenDevicesPage />} />`;
- os testes de `describe("menu admin")` passam a chamar `renderAdmin("/admin/lanche/cardapio")` e os de `describe("service days admin")` `renderAdmin("/admin/lanche/dias")` (eles hoje usam o padrão `/admin`); o mock desses testes não precisa mais das duas listas ao mesmo tempo, mas pode continuar usando `BASE`;
- troque `it("hides both sections from the kitchen role")` e todo o `describe("home sections")` por:

```tsx
describe("lunch pages", () => {
  it("sends the kitchen role back to the home page", async () => {
    mockApi({ "GET /api/admin/v1/me": me("cozinha"), "GET /api/admin/v1/dashboard?period=today": DASH_EMPTY });
    renderAdmin("/admin/lanche/cardapio");
    await screen.findByRole("heading", { name: "Escola Sol" });
    expect(screen.queryByText("Pão — R$ 3,50")).toBeNull();
  });

  it.each([
    ["#cardapio", "Cardápio"],
    ["#dias", "Dias de serviço"],
    ["#tablets", "Tablets da cozinha"],
  ])("redirects the old anchor %s to its page", async (hash, heading) => {
    mockApi({ ...BASE, "GET /api/admin/v1/me": me("secretaria"), "GET /api/admin/v1/kitchen-devices": DEVICES });
    renderAdmin(`/admin${hash}`);
    expect(await screen.findByRole("heading", { level: 1, name: heading })).toBeTruthy();
  });

  it("shows each day's situation and each item's state as badges", async () => {
    mockApi({
      "GET /api/admin/v1/menu-items": MENU,
      "GET /api/admin/v1/service-days": { status: 200, body: { serviceDays: [OPEN_DAY] } },
      "GET /api/admin/v1/me": me("admin"),
    });
    renderAdmin("/admin/lanche/dias");
    expect((await screen.findByText("Aberto")).className).toContain("badge");
    cleanup();
    renderAdmin("/admin/lanche/cardapio");
    expect((await screen.findByText("Inativo")).className).toContain("badge");
  });
});
```

Defina no topo do arquivo, ao lado de `DAYS`: `const DEVICES: Reply = { status: 200, body: { devices: [] } };` (confira em `kitchenDevices.test.tsx` a URL e o formato exatos da listagem de tablets e use os mesmos) e `const DASH_EMPTY: Reply = { status: 200, body: { period: "today", from: "2030-03-04", to: "2030-03-04", snacks: { paidOrders: 0, deliveredOrders: 0, notCollectedOrders: 0, counterSales: 0, topItems: [] }, documents: null, money: null } };`. Até a Task 5, a página inicial não pede `/dashboard`: um pedido a mais no mock não quebra nada.

Assuma que `PageTitle` renderiza o `heading` como `h1`; confira em `theme/layout/PageTitle.tsx` e ajuste o `level` se for outro.

Em `apps/web/src/theme/layout/layout.test.tsx`, acrescente um teste que renderiza `AppSidebar` com `[{ heading: "Lanche" }, ITEM]` (use um dos itens já definidos no arquivo) e confere que existe um `li` com a classe `app-sidebar__heading` e texto `Lanche`, sem link.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @app-lanche/web exec vitest run src/areas/admin/adminLayout.test.tsx src/areas/admin/catalogAdmin.test.tsx src/theme/layout/layout.test.tsx`
Expected: FAIL (ordem do menu, `LunchPages` inexistente).

- [ ] **Step 3: Sidebar headings** — em `AppSidebar.tsx`, mantenha `NavItem` e acrescente:

```tsx
/** Título de grupo do menu (sem link). */
export type NavHeading = { heading: string };
export type NavEntry = NavItem | NavHeading;
```

Mude a assinatura para `export function AppSidebar({ items }: { items: NavEntry[] })` e, no `map`, trate o título antes do item:

```tsx
              {items.map((entry) => {
                if ("heading" in entry) {
                  return (
                    <li key={`heading-${entry.heading}`} className="app-sidebar__heading">
                      {entry.heading}
                    </li>
                  );
                }
                const active = entry.isActive(location);
                return (
                  <li key={entry.to} className="metismenu-item">
                    <Link
                      to={entry.to}
                      className={active ? "metismenu-link active" : "metismenu-link"}
                      aria-current={active ? "page" : undefined}
                    >
                      <i className={`metismenu-icon ${entry.icon}`} aria-hidden="true" />
                      {entry.label}
                    </Link>
                  </li>
                );
              })}
```

Atualize os tipos que passam `nav` adiante (`AppShell`/`AdminLayout`) de `NavItem[]` para `NavEntry[]`.

- [ ] **Step 4: adminNav** — substitua o corpo de `apps/web/src/areas/admin/adminNav.ts` a partir de `type Where`:

```ts
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
```

Troque o import do topo por `import type { NavEntry, NavItem } from "../../theme/layout/AppSidebar";`.

O teste da cozinha espera `queryByText("Escola")` nulo e só os links Início e Contas: o título "Lanche" da cozinha é aceito.

- [ ] **Step 5: Lunch pages** — `apps/web/src/areas/admin/LunchPages.tsx`

```tsx
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
```

Em `AdminArea.tsx`, importe as três e acrescente dentro do `<Route element={<AdminLayout />}>`, depois de `alunos`:

```tsx
        <Route path="lanche/dias" element={<ServiceDaysPage />} />
        <Route path="lanche/cardapio" element={<MenuPage />} />
        <Route path="lanche/tablets" element={<KitchenDevicesPage />} />
```

- [ ] **Step 6: Home without sections.** Em `AdminHome.tsx`:
- remova os imports de `KitchenDevicesAdmin`, `MenuAdmin`, `ServiceDaysAdmin`, o estado `sectionsLoaded`/`sectionLoaded`, os dois `useEffect` de rolagem e o bloco `{(me.role === "admin" || me.role === "secretaria") && (<>…</>)}`;
- acrescente o redirecionamento das âncoras antigas, antes do `if (!me)`:

```tsx
const LEGACY_ANCHORS: Record<string, string> = {
  "#cardapio": "/admin/lanche/cardapio",
  "#dias": "/admin/lanche/dias",
  "#tablets": "/admin/lanche/tablets",
};
```

(constante no nível do módulo) e, no componente, `const { hash } = useLocation();` e `if (LEGACY_ANCHORS[hash]) return <Navigate to={LEGACY_ANCHORS[hash]} replace />;` como primeira linha depois dos hooks (importe `Navigate` de `react-router`). O cartão de importação continua na página inicial até a Task 4.

Nos três componentes de seção, apague a prop `onLoaded`, o comentário que a explica e as chamadas `onLoaded?.()` (o `.then(() => onLoaded?.())` e o `.finally(() => onLoaded?.())` viram a promessa sem o encadeamento; mantenha o `void` para não deixar promessa solta). Remova `useCallback` de imports que ficarem sem uso.

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm --filter @app-lanche/web exec vitest run`
Expected: PASS em todo o pacote web (o `admin.test.tsx` ainda usa o CSV da página inicial, que continua lá). Depois `pnpm typecheck && pnpm lint`.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/theme/layout apps/web/src/areas/admin
git commit -m "feat(admin): group the menu and give lunch pages their own routes"
```

---

### Task 4: Importação dentro de "Alunos e responsáveis"

**Files:**
- Create: `apps/web/src/areas/admin/ImportStudentsPanel.tsx`
- Modify: `apps/web/src/areas/admin/StudentsAdmin.tsx`
- Modify: `apps/web/src/areas/admin/AdminHome.tsx` (tirar o cartão de importação)
- Modify: `apps/web/src/areas/admin/studentsAdmin.test.tsx` (testes de importação)
- Modify: `apps/web/src/areas/admin/admin.test.tsx` (tirar os testes de importação da página inicial)

**Interfaces:**
- Consumes: `ImportStudentsResponse` (contracts), `apiFetch`, `ApiError`, `staffErrorMessage`, `announce`, `StatusNotice`.
- Produces: `ImportStudentsPanel({ onImported }: { onImported: () => void })`.

Comportamento:
- No topo de "Alunos e responsáveis", antes dos filtros, um botão `Adicionar / importar` (`aria-expanded`, `aria-controls="importar"`). Ao tocar, mostra o painel `#importar` com o texto das colunas, "Arquivo CSV", "Conteúdo do CSV" e "Importar" (mesmos rótulos de hoje). Tocar de novo fecha.
- Importação aplicada: a mensagem "Importação concluída: N turmas, N alunos, N responsáveis." aparece e é anunciada, a lista recarrega (`onImported`), o painel continua aberto com o campo limpo.
- Importação recusada: lista de linhas com erro, como hoje. 401 leva ao login.

- [ ] **Step 1: Move the tests.** Em `admin.test.tsx`:
- remova os testes de importação (os que usam `/api/admin/v1/import/students`, em torno das linhas 133–220: totais, linhas com erro, 403 e 401) e copie-os para `studentsAdmin.test.tsx` adaptados como abaixo;
- no teste "fetches /me once for the layout and the home page…", troque as duas esperas `await screen.findByLabelText("Conteúdo do CSV")` por `await screen.findByRole("heading", { name: "Escola Sol" })` (a página inicial mostra o nome da escola no título).

Em `studentsAdmin.test.tsx`, acrescente (usando o `mockApi`, `BASE` e `renderPage` do arquivo):

```tsx
describe("import inside the students page", () => {
  it("opens the CSV panel, imports and reloads the list", async () => {
    const fetchMock = mockApi({
      ...BASE,
      "POST /api/admin/v1/import/students": { status: 200, body: { applied: true, errors: [], classes: 2, students: 30, guardians: 41 } },
    });
    renderPage();
    await screen.findByText("Léo");
    expect(screen.queryByLabelText("Conteúdo do CSV")).toBeNull();
    const toggle = screen.getByRole("button", { name: "Adicionar / importar" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.change(screen.getByLabelText("Conteúdo do CSV"), { target: { value: "a,b\n1,2" } });
    fireEvent.click(screen.getByRole("button", { name: "Importar" }));
    await screen.findByText("Importação concluída: 2 turmas, 30 alunos, 41 responsáveis.");
    expect(bodyOf(fetchMock, "POST /api/admin/v1/import/students")).toEqual({ csv: "a,b\n1,2" });
    await waitFor(() => expect(fetchMock.mock.calls.filter((c) => c[0] === "/api/admin/v1/students")).toHaveLength(2));
    expect((screen.getByLabelText("Conteúdo do CSV") as HTMLTextAreaElement).value).toBe("");
  });

  it("lists the refused lines and imports nothing", async () => {
    mockApi({
      ...BASE,
      "POST /api/admin/v1/import/students": {
        status: 200,
        body: { applied: false, errors: [{ line: 3, message: "telefone inválido" }], classes: 0, students: 0, guardians: 0 },
      },
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Adicionar / importar" }));
    fireEvent.change(screen.getByLabelText("Conteúdo do CSV"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Importar" }));
    await screen.findByText("Nada foi importado. Corrija as linhas abaixo e envie de novo.");
    expect(screen.getByText("Linha 3: telefone inválido")).toBeTruthy();
  });

  it("sends an expired session to the login from the import", async () => {
    mockApi({ ...BASE, "POST /api/admin/v1/import/students": { status: 401, body: { error: { code: "unauthenticated", message: "x" } } } });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Adicionar / importar" }));
    fireEvent.change(screen.getByLabelText("Conteúdo do CSV"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Importar" }));
    await screen.findByText("login");
  });
});
```

Confira o formato exato de `ImportStudentsResponse.errors` no contrato e o texto de erro do teste 403 que existia em `admin.test.tsx`; mantenha também o caso 403 (mensagem de `staffErrorMessage("insufficient_scope")`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @app-lanche/web exec vitest run src/areas/admin/studentsAdmin.test.tsx src/areas/admin/admin.test.tsx`
Expected: FAIL (botão "Adicionar / importar" inexistente).

- [ ] **Step 3: Panel** — `apps/web/src/areas/admin/ImportStudentsPanel.tsx`: mova para cá, do `AdminHome.tsx`, os estados (`csv`, `result`, `error`, `notice`, `busy`), `loadFile`, `submit` e o JSX do `<Card tag="section" id="importar">…</Card>`, com estas diferenças:

```tsx
export function ImportStudentsPanel({ onImported }: { onImported: () => void }) {
  // …estados e loadFile como estavam em AdminHome…
  async function submit(event: FormEvent) {
    // …igual ao de AdminHome até o setResult(res)…
      if (res.applied) {
        const message = `Importação concluída: ${res.classes} turmas, ${res.students} alunos, ${res.guardians} responsáveis.`;
        setNotice(message);
        announce(message);
        setCsv("");
        onImported();
      }
    // …catch/finally iguais (401 → navigate("/admin/login", { replace: true }))…
  }
  // JSX: o mesmo Card, com o CardHeader "Adicionar ou importar alunos e responsáveis".
}
```

Escreva o arquivo completo (não deixe comentários "igual a"): é o código de `AdminHome` movido, com `useNavigate` para o 401.

- [ ] **Step 4: StudentsAdmin.** Em `StudentsAdmin.tsx`:
- `const [importing, setImporting] = useState(false);`
- logo depois do `<PageTitle … />`:

```tsx
      <div className="mb-3">
        <Button color="primary" aria-expanded={importing} aria-controls="importar" onClick={() => setImporting((v) => !v)}>
          Adicionar / importar
        </Button>
      </div>
      {importing && <ImportStudentsPanel onImported={() => void load()} />}
```

(importe `Button` de `reactstrap` se ainda não estiver importado, e `ImportStudentsPanel`). `aria-controls` aponta para o `id="importar"` do Card do painel.

- [ ] **Step 5: Home.** Em `AdminHome.tsx`, remova o cartão e tudo o que só ele usava (estados, `loadFile`, `submit`, imports de `ImportStudentsResponse`, `Alert`, `Button`, `Card*`, `Form*`, `Input`, `Label`, `announce`, `StatusNotice`, `staffErrorMessage`, `ApiError`, `apiFetch`, `useNavigate`, `ChangeEvent`, `FormEvent`). A página fica com o redirecionamento das âncoras (Task 3), a espera do `me` e o `PageTitle`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @app-lanche/web exec vitest run`
Expected: PASS. Depois `pnpm typecheck && pnpm lint`.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/areas/admin
git commit -m "feat(admin): move the CSV import into the students page"
```

---

### Task 5: Painel de indicadores na página inicial

**Files:**
- Create: `apps/web/src/areas/admin/Dashboard.tsx`
- Create: `apps/web/src/areas/admin/dashboard.test.tsx`
- Modify: `apps/web/src/areas/admin/AdminHome.tsx` (renderizar `<Dashboard role={me.role} />` depois do `PageTitle`)
- Modify: `apps/web/src/areas/admin/admin.test.tsx`, `apps/web/src/areas/admin/catalogAdmin.test.tsx` (mockar `/dashboard` onde a página inicial é aberta)

**Interfaces:**
- Consumes: `DashboardResponse`, `DashboardPeriod`, `StaffRole` (contracts); `apiFetch`, `ApiError`; `formatCents` de `../../ui/money`; `useStaffErrors` (mesmo padrão de erro das outras páginas admin).
- Produces: `Dashboard({ role }: { role: StaffRole })`.

Layout (reactstrap, tema já carregado no admin):
- Linha de controles: grupo de botões de período `Hoje` / `7 dias` / `Mês` (`aria-pressed` no ativo) e, só para admin/secretaria, o botão de valores (`Mostrar valores` com `aria-pressed="false"`; depois de tocar, `Ocultar valores` com `aria-pressed="true"`).
- Subtítulo com o intervalo: `Hoje (20/11/2026)`, `De 14/11/2026 a 20/11/2026`.
- Cartão **Lanches**: Pedidos pagos · Entregues · Não retirados · Lançamentos no balcão; lista "Mais pedidos" (`nome — N`), ou "Nenhum item no período.".
- Cartão **Documentos** (se `documents`): Publicados · Abertos (`N (P%)`, com P = arredondamento de `viewed*100/published`, ou `—` quando `published` é 0) · Lotes em geração · Lotes com falha.
- Cartão **Valores** (se `money`): Recebido por Pix · Consumo no balcão · Créditos em carteira · Débito em aberto (`R$ … · N responsáveis`, onde N nunca é oculto).
- Oculto: cada valor em reais mostra `R$ ••••` (o texto real não está no DOM).
- Troca de período: novo `GET` (`?period=today|7d|month`); enquanto carrega, mantém os números anteriores; erro mostra o `Alert` padrão.

- [ ] **Step 1: Write the failing test** — `apps/web/src/areas/admin/dashboard.test.tsx`

```tsx
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "./Dashboard";

type Reply = { status: number; body: unknown };

function mockApi(replies: Record<string, Reply>) {
  const fn = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url, init) => {
    const reply = replies[`${init?.method ?? "GET"} ${url}`];
    if (!reply) throw new Error(`unexpected request ${url}`);
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const TODAY = {
  period: "today",
  from: "2026-11-20",
  to: "2026-11-20",
  snacks: { paidOrders: 42, deliveredOrders: 40, notCollectedOrders: 2, counterSales: 15, topItems: [{ name: "Misto quente", qty: 30 }] },
  documents: { published: 8, viewed: 6, batchesRendering: 1, batchesWithFailures: 0 },
  money: { pixReceivedCents: 125_000, counterCents: 22_500, creditsCents: 48_000, debtCents: 3_500, debtors: 3 },
};
const WEEK = { ...TODAY, period: "7d", from: "2026-11-14", snacks: { ...TODAY.snacks, paidOrders: 200 } };

function renderDashboard(role: "admin" | "secretaria" | "cozinha") {
  render(
    <MemoryRouter initialEntries={["/admin"]}>
      <Routes>
        <Route path="/admin" element={<Dashboard role={role} />} />
        <Route path="/admin/login" element={<p>login</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("admin dashboard", () => {
  it("shows counts and hides money values until asked, every time the page opens", async () => {
    mockApi({ "GET /api/admin/v1/dashboard?period=today": { status: 200, body: TODAY } });
    renderDashboard("secretaria");
    expect(await screen.findByText("42")).toBeTruthy();
    expect(screen.getByText("Misto quente — 30")).toBeTruthy();
    expect(screen.getByText("6 (75%)")).toBeTruthy();
    expect(screen.getAllByText("R$ ••••")).toHaveLength(4);
    expect(screen.queryByText("R$ 1.250,00")).toBeNull();
    expect(screen.getByText(/3 responsáveis/)).toBeTruthy();

    const toggle = screen.getByRole("button", { name: "Mostrar valores" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(screen.getByText("R$ 1.250,00")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ocultar valores" }).getAttribute("aria-pressed")).toBe("true");

    cleanup();
    renderDashboard("secretaria");
    await screen.findByText("42");
    expect(screen.getAllByText("R$ ••••")).toHaveLength(4);
  });

  it("switches the period and shows its date range", async () => {
    mockApi({
      "GET /api/admin/v1/dashboard?period=today": { status: 200, body: TODAY },
      "GET /api/admin/v1/dashboard?period=7d": { status: 200, body: WEEK },
    });
    renderDashboard("admin");
    await screen.findByText("Hoje (20/11/2026)");
    fireEvent.click(screen.getByRole("button", { name: "7 dias" }));
    await screen.findByText("200");
    expect(screen.getByText("De 14/11/2026 a 20/11/2026")).toBeTruthy();
    expect(screen.getByRole("button", { name: "7 dias" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("shows the kitchen only the snacks block, without the values button", async () => {
    mockApi({ "GET /api/admin/v1/dashboard?period=today": { status: 200, body: { ...TODAY, documents: null, money: null } } });
    renderDashboard("cozinha");
    await screen.findByText("42");
    expect(screen.queryByText("Documentos")).toBeNull();
    expect(screen.queryByText("Valores")).toBeNull();
    expect(screen.queryByRole("button", { name: "Mostrar valores" })).toBeNull();
  });

  it("shows a dash instead of a percentage when nothing was published", async () => {
    mockApi({ "GET /api/admin/v1/dashboard?period=today": { status: 200, body: { ...TODAY, documents: { ...TODAY.documents, published: 0, viewed: 0 } } } });
    renderDashboard("admin");
    await screen.findByText("42");
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("sends an expired session to the login", async () => {
    mockApi({ "GET /api/admin/v1/dashboard?period=today": { status: 401, body: { error: { code: "unauthenticated", message: "x" } } } });
    renderDashboard("admin");
    await screen.findByText("login");
  });
});
```

O número `42` só pode aparecer uma vez na tela com esse fixture; se colidir com outro valor, ajuste o fixture, não a asserção. Confira em `useStaffErrors.ts` se o 401 já navega para o login (é o padrão das páginas admin); se não, faça como `AdminHome` fazia.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @app-lanche/web exec vitest run src/areas/admin/dashboard.test.tsx`
Expected: FAIL (`Cannot find module './Dashboard'`).

- [ ] **Step 3: Implement** — `apps/web/src/areas/admin/Dashboard.tsx`

```tsx
import { DashboardResponse, type DashboardPeriod, type StaffRole } from "@app-lanche/contracts";
import { useEffect, useState, type ReactNode } from "react";
import { Alert, Button, ButtonGroup, Card, CardBody, CardHeader, Col, Row } from "reactstrap";
import { apiFetch } from "../../app/api";
import { formatCents } from "../../ui/money";
import { useStaffErrors } from "./useStaffErrors";

const PERIODS: { value: DashboardPeriod; label: string }[] = [
  { value: "today", label: "Hoje" },
  { value: "7d", label: "7 dias" },
  { value: "month", label: "Mês" },
];
const HIDDEN = "R$ ••••";
const br = (iso: string) => iso.split("-").reverse().join("/");

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="d-flex justify-content-between py-1 border-bottom">
      <span>{label}</span>
      <strong>{children}</strong>
    </div>
  );
}

/** Indicadores da página inicial (spec F5C, A.3). Valores em reais começam ocultos a cada montagem. */
export function Dashboard({ role }: { role: StaffRole }) {
  const { error, fail } = useStaffErrors();
  const [period, setPeriod] = useState<DashboardPeriod>("today");
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [showValues, setShowValues] = useState(false);
  const office = role === "admin" || role === "secretaria";

  useEffect(() => {
    let active = true;
    apiFetch(`/api/admin/v1/dashboard?period=${period}`, DashboardResponse).then(
      (res) => active && setData(res),
      (err) => active && fail(err),
    );
    return () => {
      active = false;
    };
  }, [period, fail]);

  const money = (cents: number) => (showValues ? formatCents(cents) : HIDDEN);
  const range = data && (data.from === data.to ? `Hoje (${br(data.to)})` : `De ${br(data.from)} a ${br(data.to)}`);

  return (
    <section aria-label="Indicadores">
      <div className="d-flex flex-wrap gap-2 align-items-center mb-3">
        <ButtonGroup aria-label="Período">
          {PERIODS.map((p) => (
            <Button key={p.value} color="primary" outline={p.value !== period} aria-pressed={p.value === period} onClick={() => setPeriod(p.value)}>
              {p.label}
            </Button>
          ))}
        </ButtonGroup>
        {office && (
          <Button color="secondary" outline aria-pressed={showValues} onClick={() => setShowValues((v) => !v)}>
            <i className={showValues ? "pe-7s-look me-1" : "pe-7s-shield me-1"} aria-hidden="true" />
            {showValues ? "Ocultar valores" : "Mostrar valores"}
          </Button>
        )}
        {range && <span className="text-muted">{range}</span>}
      </div>
      {error && (
        <Alert color="danger" fade={false}>
          {error}
        </Alert>
      )}
      {data && (
        <Row>
          <Col lg={4} className="mb-3">
            <Card className="main-card h-100">
              <CardHeader tag="h2" className="h6 mb-0">Lanches</CardHeader>
              <CardBody>
                <Stat label="Pedidos pagos">{data.snacks.paidOrders}</Stat>
                <Stat label="Entregues">{data.snacks.deliveredOrders}</Stat>
                <Stat label="Não retirados">{data.snacks.notCollectedOrders}</Stat>
                <Stat label="Lançamentos no balcão">{data.snacks.counterSales}</Stat>
                <h3 className="h6 mt-3">Mais pedidos</h3>
                {data.snacks.topItems.length === 0 ? (
                  <p className="text-muted mb-0">Nenhum item no período.</p>
                ) : (
                  <ol className="mb-0 ps-3">
                    {data.snacks.topItems.map((i) => (
                      <li key={i.name}>{`${i.name} — ${i.qty}`}</li>
                    ))}
                  </ol>
                )}
              </CardBody>
            </Card>
          </Col>
          {data.documents && (
            <Col lg={4} className="mb-3">
              <Card className="main-card h-100">
                <CardHeader tag="h2" className="h6 mb-0">Documentos</CardHeader>
                <CardBody>
                  <Stat label="Publicados">{data.documents.published}</Stat>
                  <Stat label="Abertos">
                    {data.documents.published === 0
                      ? "—"
                      : `${data.documents.viewed} (${Math.round((data.documents.viewed * 100) / data.documents.published)}%)`}
                  </Stat>
                  <Stat label="Lotes em geração">{data.documents.batchesRendering}</Stat>
                  <Stat label="Lotes com falha">{data.documents.batchesWithFailures}</Stat>
                </CardBody>
              </Card>
            </Col>
          )}
          {data.money && (
            <Col lg={4} className="mb-3">
              <Card className="main-card h-100">
                <CardHeader tag="h2" className="h6 mb-0">Valores</CardHeader>
                <CardBody>
                  <Stat label="Recebido por Pix">{money(data.money.pixReceivedCents)}</Stat>
                  <Stat label="Consumo no balcão">{money(data.money.counterCents)}</Stat>
                  <Stat label="Créditos em carteira">{money(data.money.creditsCents)}</Stat>
                  <Stat label="Débito em aberto">
                    {money(data.money.debtCents)}
                    <span className="fw-normal">{` · ${data.money.debtors} responsáveis`}</span>
                  </Stat>
                </CardBody>
              </Card>
            </Col>
          )}
        </Row>
      )}
    </section>
  );
}
```

`Math.round` aqui é só para exibir um percentual, não é cálculo de dinheiro (regra 6 não se aplica). Confirme que os ícones `pe-7s-look` e `pe-7s-shield` existem na fonte pe-icon-7-stroke do projeto; se não, use dois que existam. Confira a assinatura de `useStaffErrors` (o que devolve e se `fail` é estável entre renderizações); se `fail` mudar a cada render, tire-o das dependências do `useEffect` com o mesmo padrão usado em `StudentsAdmin`.

No teste "R$ ••••" deve aparecer exatamente 4 vezes: o texto "· 3 responsáveis" fica num `span` separado dentro do mesmo `strong`; se `getAllByText("R$ ••••")` não achar o do débito por causa do `span`, envolva o valor em `<span>{money(...)}</span>`.

- [ ] **Step 4: Home.** Em `AdminHome.tsx`, depois do `PageTitle`, renderize `<Dashboard role={me.role} />`. Em `admin.test.tsx` e `catalogAdmin.test.tsx`, todo teste que abre `/admin` (página inicial) passa a mockar `"/api/admin/v1/dashboard?period=today"` (no formato de chave de cada arquivo) com um corpo válido; reaproveite um fixture como o `DASH_EMPTY` da Task 3.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @app-lanche/web exec vitest run`
Expected: PASS. Depois `pnpm typecheck && pnpm lint && pnpm --filter @app-lanche/web build` (o build confere que o tema não vazou para o pacote dos responsáveis).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/areas/admin
git commit -m "feat(admin): home dashboard with hidden-by-default values"
```

---

### Task 6: Conferência no app e documentação

**Files:**
- Modify: `docs/local.md` (seção "Entrar na área admin": onde ficam Cardápio, Dias e Tablets; o painel)

- [ ] **Step 1:** `pnpm app:up` e, no navegador ou com Playwright (script na pasta de rascunho, fora do repositório), entre como `admin@escola.local` (`pnpm app:otp`) e confira:
  - o menu com os títulos "Escola" e "Lanche";
  - `/admin#dias` abrindo "Dias de serviço";
  - "Adicionar / importar" em "Alunos e responsáveis";
  - o painel com "R$ ••••" e o botão revelando.
  Tire capturas em desktop e celular (390 px) e olhe cada uma.

- [ ] **Step 2:** Em `docs/local.md`, troque a menção a seções da página inicial por: "Cardápio, Dias de serviço e Tablets da cozinha ficam no grupo **Lanche** do menu; a importação CSV fica em **Alunos e responsáveis → Adicionar / importar**. A página inicial mostra os indicadores, com valores ocultos até tocar em **Mostrar valores**."

- [ ] **Step 3: Full verification**

Run: `pnpm app:down && pnpm typecheck && pnpm lint && pnpm test`
Expected: tudo PASS (contracts, api, web).

- [ ] **Step 4: Commit**

```bash
git add docs/local.md
git commit -m "docs(local): where the lunch pages, import and dashboard live"
```
