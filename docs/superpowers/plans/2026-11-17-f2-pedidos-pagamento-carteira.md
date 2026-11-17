# F2 — Pedidos, pagamento, carteira e corte — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O responsável escolhe o lanche de cada filho para um dia de serviço, paga com saldo da carteira e/ou Pix, e o sistema confirma, credita pagamento tardio, cancela e fecha o dia com romaneio congelado — tudo correto sob concorrência no horário de corte.

**Architecture:** Uma migração cria as 12 tabelas da fase com RLS. Módulos novos na API: `catalog` (cardápio e dias de serviço), `wallet` (ledger), `orders` (checkout, cancelamento, transições de checkout/pedido), `payments` (provedor, cobrança, `confirmPayment`, webhook, conciliação do dia) e `serviceDays` (fechamento e romaneio). Toda regra de corte trava a linha de `service_days` (`FOR SHARE` para confirmar/pedir/cancelar, `FOR UPDATE` para fechar) e usa `now()` do banco. A chamada ao gateway acontece fora da transação, com o `payment.id` como chave de idempotência. A web ganha o fluxo de pedido do responsável e as telas de cardápio/dias da secretaria.

**Tech Stack:** Fastify 5, Kysely 0.29 + pg, PostgreSQL 16 (Testcontainers), zod 4, React 19 + react-router 8, Vitest 5.

**Spec:** `docs/superpowers/specs/2026-11-16-app-lanche-design.md` (seções 4.4, 5, 6.2 `close`, 6.3, 9, 10, 13). Leia também `CLAUDE.md`.

## Global Constraints

- Todo acesso ao banco dentro de `withTenant(schoolId, async (trx) => …)`; `school_id` vem da sessão ou do caminho do webhook autenticado pelo segredo da escola, nunca do corpo/query/header.
- Toda tabela nova: `school_id uuid NOT NULL`, RLS `tenant_isolation`, `UNIQUE (school_id, id)` (quando tem `id`), FKs compostas `(school_id, …)`; entra em `TENANT_TABLES` (ordem alfabética) e em `seedTenant`.
- Dinheiro em centavos inteiros: `bigint` no banco, `number` inteiro no código, sufixo `_cents`/`Cents`. Nunca float para cálculo, nunca `toFixed`. Preço e total calculados no servidor.
- `wallet_entries` é append-only; todo lançamento trava `wallets` com `FOR UPDATE` na mesma transação; `CHECK (balance_cents >= 0)`.
- Pagamento só é confirmado por `confirmPayment`; webhook e conciliação chamam essa mesma função.
- Todo `POST` que cria estado aceita `Idempotency-Key` e usa `platform/idempotency`, exceto rotas naturalmente idempotentes (transição de estado), como cancelamento e fechamento.
- Transição de estado é `UPDATE … WHERE status = '<anterior>'`; zero linhas = já feito, sem erro e sem efeito colateral.
- Deduplicação por `UNIQUE` + `ON CONFLICT DO NOTHING`, nunca `SELECT` seguido de `INSERT`.
- A única fonte de tempo para regra de negócio é o banco (`now()`); `paid_at` é o horário informado pelo gateway.
- Ordem de travas em toda transação: `service_days` primeiro, `wallets` por último.
- Efeito externo é sempre `outbox_events` na mesma transação (`enqueueEvent`); `data` dos eventos em `snake_case`; mensagens usam só primeiro nome.
- Chamada ao gateway fora de transação. Webhook grava o evento bruto, processa na mesma transação, responde 200; repetido responde 200 sem processar; erro de processamento responde 500.
- Logs só com ids internos: nunca telefone, e-mail, nome, token, OTP, `device_secret`, corpo de webhook, código Pix.
- Respostas de `/api/**` com `Cache-Control: private, no-store` (já feito pelo `onSend`).
- Erros de domínio: `DomainError(code)`; todo código novo entra em `packages/contracts/src/errors.ts` (`errorCodes`) e no `STATUS` de `apps/api/src/platform/errors.ts` no mesmo commit.
- Texto de interface em português do Brasil, exatamente como o plano dá; código, nomes e commits em inglês.
- `jsonb` lido com o `CamelCasePlugin` tem as chaves aninhadas convertidas: leia `col::text` e `JSON.parse` quando o JSON precisa sair como foi gravado (`idempotency_keys.response`, `manifests.content`).
- Não adicione dependência. Não edite migração aplicada (0001–0005).

## Decisões desta fase (rulings do controlador; a spec é emendada no commit de abertura da fase)

1. **Gateway: Efí Pix** (decisão do usuário em 2026-11-17, no lugar do Asaas, que exige CPF do pagador). A cobrança imediata da Efí não exige `devedor`. As Tasks 5–12 usam a interface `PaymentProvider` e o provedor `fake`; a Task 13 implementa o adaptador `efi`. Referência da API levantada em `.superpowers/sdd/2026-11-17-f2-pedidos-pagamento-carteira/efi-pix-reference.md` (copiada para `docs/efi-pix.md` na Task 13).
2. **Segredos por escola:** `schools.payment_webhook_secret_ref` é o NOME de uma variável de ambiente (Cloud Run injeta segredos do Secret Manager como env). `getSecret(ref)` lê `process.env[ref]`. Custo: incluir escola exige novo deploy até trocarmos por cliente do Secret Manager.
3. **Cancelar checkout pendente** (`pending_payment`) é permitido e equivale a expirá-lo antes do corte (`→ expired`, pedidos `→ expired`, pagamento `→ expired`, `hold_release`). Sem isso o aluno ficaria bloqueado até o corte. Pagamento posterior desse Pix vira crédito tardio.
4. **`payments`: `expired → paid`** é permitido (pagamento tardio de cobrança já expirada pelo fechamento), como exige a spec 5.6.
5. **Cancelamento só até o corte** (`status = 'open'` e `now() <= cutoff_at`).
6. **Sinal dos lançamentos:** `amount_cents` com sinal; `checkout_hold` e `refund` negativos; `hold_release`, `late_payment_credit`, `cancel_credit` positivos; `manual_adjustment` qualquer sinal diferente de zero. Saldo = soma dos lançamentos.
7. **Fechamento nesta fase**: a função `closeServiceDay` e as rotas de equipe `POST /api/admin/v1/service-days/:date/close` e `GET …/manifest`. As rotas internas do n8n ficam para a F3 e reutilizam a mesma função.
8. **Restrição alimentar no romaneio** só aparece se algum responsável do aluno registrou `restriction_consent_at` (LGPD, spec 4.5).
9. **Item com quantidade > 1 no romaneio** aparece como `"2x Misto quente"`.
10. **`int8` lido como `number`** (com verificação de inteiro seguro) e `date` lido como texto `YYYY-MM-DD` (parsers do `pg` + `kysely-codegen --type-mapping '{"int8":"number"}' --date-parser string`).
11. **Uma cobrança por checkout** (índice único `payments (school_id, checkout_id)`).
12. **Reembolso em dinheiro** (`refund`) fica para a fase que trouxer a reverificação por OTP do responsável; o tipo já existe no ledger.

---

### Task 1: Esquema da fase (migração 0006) e leitura de `int8`/`date`

**Files:**
- Create: `db/migrations/0006_orders_payments.sql`
- Modify: `apps/api/src/db/index.ts` (parsers do pg)
- Modify: `apps/api/package.json` (script `db:types`)
- Regenerate: `apps/api/src/db/types.ts`
- Modify: `apps/api/src/db/rls.test.ts` (`TENANT_TABLES`)
- Modify: `apps/api/test/helpers.ts` (`SeedIds`, `seedTenant`)
- Create: `apps/api/src/db/schema.test.ts`

**Interfaces:**
- Produces: tabelas `menu_items`, `service_days`, `service_day_items`, `wallets`, `wallet_entries`, `checkouts`, `orders`, `order_items`, `payments`, `payment_events`, `manifests`, `idempotency_keys`; índice `orders_one_active_per_student`; tipos Kysely `MenuItems`, `ServiceDays`, … com `int8 → number` e `date → string`.
- Produces: `SeedIds` ganha `menuItemId`, `serviceDayId`, `serviceDate` (`"2099-12-31"`), `walletId`, `checkoutId`, `orderId`, `paymentId`. Os registros de semente ficam em estados terminais (`expired`) para não bloquear testes que criam pedidos para o mesmo aluno.

- [ ] **Step 1: Escrever a migração**

`db/migrations/0006_orders_payments.sql`:

```sql
-- F2: cardápio, dias de serviço, checkout, pagamento, carteira e romaneio (spec 5 e 9).

CREATE TABLE menu_items (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  price_cents bigint NOT NULL CHECK (price_cents > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, name)
);

CREATE TABLE service_days (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  service_date date NOT NULL,
  cutoff_at timestamptz NOT NULL,
  freeze_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, service_date),
  CHECK (freeze_at > cutoff_at),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);

CREATE TABLE service_day_items (
  school_id uuid NOT NULL REFERENCES schools (id),
  service_day_id uuid NOT NULL,
  menu_item_id uuid NOT NULL,
  price_cents bigint NOT NULL CHECK (price_cents > 0),
  PRIMARY KEY (school_id, service_day_id, menu_item_id),
  FOREIGN KEY (school_id, service_day_id) REFERENCES service_days (school_id, id),
  FOREIGN KEY (school_id, menu_item_id) REFERENCES menu_items (school_id, id)
);

CREATE TABLE wallets (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  guardian_id uuid NOT NULL,
  balance_cents bigint NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, guardian_id),
  FOREIGN KEY (school_id, guardian_id) REFERENCES guardians (school_id, id)
);

-- Append-only: o papel da aplicação só tem SELECT e INSERT.
CREATE TABLE wallet_entries (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  wallet_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('checkout_hold', 'hold_release', 'late_payment_credit', 'cancel_credit', 'refund', 'manual_adjustment')),
  amount_cents bigint NOT NULL CHECK (amount_cents <> 0),
  source_type text NOT NULL CHECK (source_type IN ('checkout', 'payment', 'adjustment')),
  source_id uuid NOT NULL,
  note text CHECK (note IS NULL OR length(note) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, source_type, source_id, kind),
  FOREIGN KEY (school_id, wallet_id) REFERENCES wallets (school_id, id),
  CHECK (
    (kind IN ('checkout_hold', 'refund') AND amount_cents < 0)
    OR (kind IN ('hold_release', 'late_payment_credit', 'cancel_credit') AND amount_cents > 0)
    OR kind = 'manual_adjustment'
  )
);
CREATE INDEX wallet_entries_wallet ON wallet_entries (school_id, wallet_id, created_at);

CREATE TABLE checkouts (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  guardian_id uuid NOT NULL,
  service_day_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending_payment'
    CHECK (status IN ('pending_payment', 'paid', 'expired', 'late_credited', 'cancelled')),
  total_cents bigint NOT NULL CHECK (total_cents > 0),
  wallet_applied_cents bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  FOREIGN KEY (school_id, guardian_id) REFERENCES guardians (school_id, id),
  FOREIGN KEY (school_id, service_day_id) REFERENCES service_days (school_id, id),
  CHECK (wallet_applied_cents >= 0 AND wallet_applied_cents <= total_cents)
);
CREATE INDEX checkouts_day_status ON checkouts (school_id, service_day_id, status);
CREATE INDEX checkouts_guardian ON checkouts (school_id, guardian_id, service_day_id);

CREATE TABLE orders (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  checkout_id uuid NOT NULL,
  student_id uuid NOT NULL,
  service_date date NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'delivered', 'expired', 'expired_late', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  FOREIGN KEY (school_id, checkout_id) REFERENCES checkouts (school_id, id),
  FOREIGN KEY (school_id, student_id) REFERENCES students (school_id, id)
);
CREATE INDEX orders_checkout ON orders (school_id, checkout_id);
-- Toque duplo e dois responsáveis pedindo para o mesmo aluno (spec 5.4).
CREATE UNIQUE INDEX orders_one_active_per_student
  ON orders (school_id, student_id, service_date) WHERE status IN ('pending', 'confirmed', 'delivered');

CREATE TABLE order_items (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  order_id uuid NOT NULL,
  menu_item_id uuid NOT NULL,
  qty integer NOT NULL CHECK (qty BETWEEN 1 AND 10),
  unit_price_cents bigint NOT NULL CHECK (unit_price_cents > 0),
  UNIQUE (school_id, id),
  UNIQUE (school_id, order_id, menu_item_id),
  FOREIGN KEY (school_id, order_id) REFERENCES orders (school_id, id),
  FOREIGN KEY (school_id, menu_item_id) REFERENCES menu_items (school_id, id)
);

CREATE TABLE payments (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  checkout_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{1,30}$'),
  provider_charge_id text,
  method text NOT NULL CHECK (method IN ('pix', 'card_link')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'expired', 'refunded')),
  paid_at timestamptz,
  expires_at timestamptz NOT NULL,
  pix_copy_paste text,
  pix_qr_png_base64 text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (provider, provider_charge_id),
  FOREIGN KEY (school_id, checkout_id) REFERENCES checkouts (school_id, id),
  CHECK ((status IN ('paid', 'refunded')) = (paid_at IS NOT NULL))
);
CREATE UNIQUE INDEX payments_one_per_checkout ON payments (school_id, checkout_id);
CREATE INDEX payments_pending ON payments (school_id, status) WHERE status = 'pending';

-- Evento bruto do gateway; a unicidade global deduplica reenvios (spec 5.4).
CREATE TABLE payment_events (
  id uuid PRIMARY KEY,
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  school_id uuid NOT NULL REFERENCES schools (id),
  payment_id uuid,
  raw jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (provider, provider_event_id),
  FOREIGN KEY (school_id, payment_id) REFERENCES payments (school_id, id)
);

-- Imutável depois de gravado (CLAUDE.md regra 18).
CREATE TABLE manifests (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  service_day_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  content jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, service_day_id, version),
  FOREIGN KEY (school_id, service_day_id) REFERENCES service_days (school_id, id)
);

CREATE TABLE idempotency_keys (
  school_id uuid NOT NULL REFERENCES schools (id),
  key text NOT NULL CHECK (length(key) BETWEEN 8 AND 200),
  request_hash text NOT NULL,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (school_id, key)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['menu_items', 'service_days', 'service_day_items', 'wallets', 'wallet_entries',
    'checkouts', 'orders', 'order_items', 'payments', 'payment_events', 'manifests', 'idempotency_keys']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (school_id = app_school_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON menu_items, service_days, wallets, checkouts, orders, payments TO app_user;
GRANT SELECT, INSERT, DELETE ON service_day_items TO app_user;
GRANT SELECT, INSERT ON order_items, wallet_entries, payment_events, manifests TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON idempotency_keys TO app_user;
```

- [ ] **Step 2: Parsers do pg e script de tipos**

Em `apps/api/src/db/index.ts`, logo após os imports:

```ts
// int8 → number (centavos cabem com folga em 2^53); date → "YYYY-MM-DD", nunca um Date no fuso do servidor.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error("int8 value out of safe integer range");
  return n;
});
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);
```

Em `apps/api/package.json`, o script `db:types` passa a ser:

```json
"db:types": "kysely-codegen --dialect postgres --camel-case --date-parser string --type-mapping '{\"int8\":\"number\"}' --out-file src/db/types.ts"
```

Rode a migração e regenere os tipos (comandos no `common-context.md`). Confira em `types.ts` que `priceCents` é `number` e `serviceDate` é `string`. Corrija o que o `pnpm typecheck` acusar no código existente (ex.: `magic_links.service_date` passa a ser `string`).

- [ ] **Step 3: Atualizar RLS e semente**

Em `apps/api/src/db/rls.test.ts`, `TENANT_TABLES` passa a ser (alfabético):

```ts
const TENANT_TABLES = [
  "audit_log",
  "checkouts",
  "classes",
  "devices",
  "guardian_students",
  "guardians",
  "idempotency_keys",
  "magic_links",
  "manifests",
  "menu_items",
  "order_items",
  "orders",
  "otp_challenges",
  "outbox_events",
  "payment_events",
  "payments",
  "service_day_items",
  "service_days",
  "staff_users",
  "students",
  "wallet_entries",
  "wallets",
];
```

Em `apps/api/test/helpers.ts`, estenda `SeedIds` e `seedTenant` (acrescente ao final, antes do `return`):

```ts
export type SeedIds = {
  classId: string;
  studentId: string;
  guardianId: string;
  staffUserId: string;
  phone: string;
  email: string;
  menuItemId: string;
  serviceDayId: string;
  serviceDate: string;
  walletId: string;
  checkoutId: string;
  orderId: string;
  paymentId: string;
};
```

```ts
  // F2: registros em estado terminal, para não bloquear pedidos criados pelos testes.
  const cutoffAt = new Date("2099-12-31T10:30:00Z");
  await db.insertInto("menuItems").values({ id: ids.menuItemId, schoolId, name: "Semente", priceCents: 900 }).execute();
  await db
    .insertInto("serviceDays")
    .values({
      id: ids.serviceDayId,
      schoolId,
      serviceDate: ids.serviceDate,
      cutoffAt,
      freezeAt: new Date(cutoffAt.getTime() + 300_000),
    })
    .execute();
  await db
    .insertInto("serviceDayItems")
    .values({ schoolId, serviceDayId: ids.serviceDayId, menuItemId: ids.menuItemId, priceCents: 900 })
    .execute();
  await db.insertInto("wallets").values({ id: ids.walletId, schoolId, guardianId: ids.guardianId, balanceCents: 100 }).execute();
  await db
    .insertInto("walletEntries")
    .values({
      id: uuidv7(),
      schoolId,
      walletId: ids.walletId,
      kind: "manual_adjustment",
      amountCents: 100,
      sourceType: "adjustment",
      sourceId: uuidv7(),
    })
    .execute();
  await db
    .insertInto("checkouts")
    .values({
      id: ids.checkoutId,
      schoolId,
      guardianId: ids.guardianId,
      serviceDayId: ids.serviceDayId,
      status: "expired",
      totalCents: 900,
    })
    .execute();
  await db
    .insertInto("orders")
    .values({
      id: ids.orderId,
      schoolId,
      checkoutId: ids.checkoutId,
      studentId: ids.studentId,
      serviceDate: ids.serviceDate,
      status: "expired",
    })
    .execute();
  await db
    .insertInto("orderItems")
    .values({ id: uuidv7(), schoolId, orderId: ids.orderId, menuItemId: ids.menuItemId, qty: 1, unitPriceCents: 900 })
    .execute();
  await db
    .insertInto("payments")
    .values({
      id: ids.paymentId,
      schoolId,
      checkoutId: ids.checkoutId,
      provider: "fake",
      method: "pix",
      amountCents: 900,
      status: "expired",
      expiresAt: cutoffAt,
    })
    .execute();
  await db
    .insertInto("paymentEvents")
    .values({
      id: uuidv7(),
      provider: "fake",
      providerEventId: `seed-${uuidv7()}`,
      schoolId,
      paymentId: ids.paymentId,
      raw: JSON.stringify({}),
    })
    .execute();
  await db
    .insertInto("manifests")
    .values({ id: uuidv7(), schoolId, serviceDayId: ids.serviceDayId, content: JSON.stringify({}) })
    .execute();
  await db
    .insertInto("idempotencyKeys")
    .values({ schoolId, key: `seed-${uuidv7()}`, requestHash: "seed", response: JSON.stringify({}) })
    .execute();
```

e, no objeto `ids`, acrescente `menuItemId: uuidv7(), serviceDayId: uuidv7(), serviceDate: "2099-12-31", walletId: uuidv7(), checkoutId: uuidv7(), orderId: uuidv7(), paymentId: uuidv7()`.

- [ ] **Step 4: Escrever os testes de esquema (falham antes da migração)**

`apps/api/src/db/schema.test.ts`:

```ts
import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { beforeAll, describe, expect, it } from "vitest";
import { adminDb, createSchool, seedTenant, type SeedIds } from "../../test/helpers";
import { withTenant } from "./index";

describe("F2 schema", () => {
  let schoolId: string;
  let ids: SeedIds;

  beforeAll(async () => {
    schoolId = await createSchool();
    ids = await seedTenant(schoolId);
  });

  it.each(["wallet_entries", "manifests", "payment_events", "order_items"])(
    "%s is append-only for the application role",
    async (table) => {
      await expect(
        withTenant(schoolId, (trx) => sql`UPDATE ${sql.table(table)} SET school_id = school_id`.execute(trx)),
      ).rejects.toThrow(/permission denied/);
      await expect(withTenant(schoolId, (trx) => sql`DELETE FROM ${sql.table(table)}`.execute(trx))).rejects.toThrow(
        /permission denied/,
      );
    },
  );

  it("allows one active order per student and date", async () => {
    const insertOrder = (status: string) =>
      withTenant(schoolId, (trx) =>
        trx
          .insertInto("orders")
          .values({
            id: uuidv7(),
            schoolId,
            checkoutId: ids.checkoutId,
            studentId: ids.studentId,
            serviceDate: "2099-06-01",
            status,
          })
          .execute(),
      );
    await insertOrder("pending");
    await expect(insertOrder("confirmed")).rejects.toThrow(/orders_one_active_per_student/);
    await insertOrder("expired");
    await insertOrder("cancelled");
  });

  it("rejects a negative wallet balance", async () => {
    await expect(
      withTenant(schoolId, (trx) =>
        trx.updateTable("wallets").set({ balanceCents: -1 }).where("id", "=", ids.walletId).execute(),
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it("enforces the sign of each wallet entry kind", async () => {
    const entry = (kind: string, amountCents: number) =>
      withTenant(schoolId, (trx) =>
        trx
          .insertInto("walletEntries")
          .values({ id: uuidv7(), schoolId, walletId: ids.walletId, kind, amountCents, sourceType: "checkout", sourceId: uuidv7() })
          .execute(),
      );
    await expect(entry("checkout_hold", 100)).rejects.toThrow(/check constraint/);
    await expect(entry("cancel_credit", -100)).rejects.toThrow(/check constraint/);
    await expect(entry("manual_adjustment", 0)).rejects.toThrow(/check constraint/);
  });

  it("reads int8 as number and date as YYYY-MM-DD text", async () => {
    const row = await withTenant(schoolId, (trx) =>
      trx
        .selectFrom("serviceDays")
        .innerJoin("serviceDayItems", "serviceDayItems.serviceDayId", "serviceDays.id")
        .select(["serviceDays.serviceDate", "serviceDayItems.priceCents"])
        .where("serviceDays.id", "=", ids.serviceDayId)
        .executeTakeFirstOrThrow(),
    );
    expect(row).toEqual({ serviceDate: "2099-12-31", priceCents: 900 });
    const { rows } = await sql<{ n: unknown }>`SELECT count(*) AS n FROM schools`.execute(adminDb());
    expect(typeof rows[0]!.n).toBe("number");
  });
});
```

- [ ] **Step 5: Rodar e ver passar**

Run: `pnpm --filter @app-lanche/api exec vitest run src/db`
Expected: PASS (`rls.test.ts` e `schema.test.ts`). Antes da migração o `schema.test.ts` falha com tabela inexistente — registre esse RED.

Depois: `pnpm typecheck && pnpm lint && pnpm test` na raiz.

- [ ] **Step 6: Commit**

```bash
git add db/migrations/0006_orders_payments.sql apps/api/src/db apps/api/package.json apps/api/test/helpers.ts
git commit -m "feat(db): add menu, service day, checkout, payment, wallet and manifest tables"
```

---

### Task 2: Helper de idempotência (`platform/idempotency`)

**Files:**
- Create: `apps/api/src/platform/idempotency.ts`
- Create: `apps/api/src/platform/idempotency.test.ts`
- Modify: `packages/contracts/src/errors.ts`, `apps/api/src/platform/errors.ts`

**Interfaces:**
- Consumes: tabela `idempotency_keys` (Task 1).
- Produces:
  - `IDEMPOTENCY_HEADER = "idempotency-key"`
  - `idempotencyKeyFrom(req: FastifyRequest): string` — lança `DomainError("idempotency_key_required")` (400) se ausente ou fora de `/^[A-Za-z0-9_-]{8,200}$/`.
  - `requestHash(parts: { route: string; actorId: string; body: unknown }): string` — SHA-256 hex.
  - `idempotent<T>(trx: Trx, input: { schoolId: string; key: string; requestHash: string }, fn: () => Promise<T>): Promise<{ response: T; replayed: boolean }>` — `T` precisa ser serializável em JSON (datas como string ISO).
  - Códigos de erro novos: `idempotency_key_required` (400), `idempotency_key_reused` (422).

- [ ] **Step 1: Teste que falha**

`apps/api/src/platform/idempotency.test.ts`:

```ts
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { adminDb, createSchool } from "../../test/helpers";
import { withTenant } from "../db/index";
import { DomainError } from "./errors";
import { idempotencyKeyFrom, idempotent, requestHash } from "./idempotency";

const hashA = requestHash({ route: "POST /x", actorId: "a", body: { n: 1 } });

describe("idempotent", () => {
  it("runs once and replays the stored response", async () => {
    const schoolId = await createSchool();
    let calls = 0;
    const run = () =>
      withTenant(schoolId, (trx) =>
        idempotent(trx, { schoolId, key: "key-00000001", requestHash: hashA }, async () => {
          calls += 1;
          return { value: calls, nested: { snake_case: true } };
        }),
      );
    expect(await run()).toEqual({ response: { value: 1, nested: { snake_case: true } }, replayed: false });
    expect(await run()).toEqual({ response: { value: 1, nested: { snake_case: true } }, replayed: true });
    expect(calls).toBe(1);
  });

  it("rejects the same key with a different request", async () => {
    const schoolId = await createSchool();
    const input = { schoolId, key: "key-00000002", requestHash: hashA };
    await withTenant(schoolId, (trx) => idempotent(trx, input, async () => ({ ok: true })));
    const other = { ...input, requestHash: requestHash({ route: "POST /x", actorId: "a", body: { n: 2 } }) };
    await expect(withTenant(schoolId, (trx) => idempotent(trx, other, async () => ({ ok: true })))).rejects.toMatchObject({
      code: "idempotency_key_reused",
    });
  });

  it("does not keep the key when the work fails", async () => {
    const schoolId = await createSchool();
    const input = { schoolId, key: "key-00000003", requestHash: hashA };
    await expect(
      withTenant(schoolId, (trx) =>
        idempotent(trx, input, async () => {
          throw new DomainError("not_found");
        }),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    const { response } = await withTenant(schoolId, (trx) => idempotent(trx, input, async () => ({ second: true })));
    expect(response).toEqual({ second: true });
  });

  it("serializes concurrent requests with the same key", async () => {
    const schoolId = await createSchool();
    let calls = 0;
    const run = () =>
      withTenant(schoolId, (trx) =>
        idempotent(trx, { schoolId, key: "key-00000004", requestHash: hashA }, async () => {
          calls += 1;
          await sql`SELECT pg_sleep(0.3)`.execute(trx);
          return { calls };
        }),
      );
    const [a, b] = await Promise.all([run(), run()]);
    expect(calls).toBe(1);
    expect(a.response).toEqual(b.response);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
  });

  it("keys are scoped by school", async () => {
    const schoolA = await createSchool();
    const schoolB = await createSchool();
    const key = "key-00000005";
    await withTenant(schoolA, (trx) => idempotent(trx, { schoolId: schoolA, key, requestHash: hashA }, async () => ({ s: "A" })));
    const b = await withTenant(schoolB, (trx) =>
      idempotent(trx, { schoolId: schoolB, key, requestHash: hashA }, async () => ({ s: "B" })),
    );
    expect(b).toEqual({ response: { s: "B" }, replayed: false });
    const rows = await adminDb().selectFrom("idempotencyKeys").select("schoolId").where("key", "=", key).execute();
    expect(rows).toHaveLength(2);
  });
});

describe("idempotencyKeyFrom", () => {
  const req = (value?: string) => ({ headers: value === undefined ? {} : { "idempotency-key": value } }) as never;
  it("accepts a UUID", () => {
    expect(idempotencyKeyFrom(req("0193a3b0-0000-7000-8000-000000000000"))).toBe("0193a3b0-0000-7000-8000-000000000000");
  });
  it.each([undefined, "", "short", "has space in it", "x".repeat(201)])("rejects %j", (value) => {
    expect(() => idempotencyKeyFrom(req(value))).toThrow(expect.objectContaining({ code: "idempotency_key_required" }));
  });
});
```

Run: `pnpm --filter @app-lanche/api exec vitest run src/platform/idempotency.test.ts` → FAIL (módulo inexistente).

- [ ] **Step 2: Implementar**

Acrescente `"idempotency_key_required"` e `"idempotency_key_reused"` a `errorCodes` (contracts) e ao `STATUS` (`idempotency_key_required: 400`, `idempotency_key_reused: 422`).

`apps/api/src/platform/idempotency.ts`:

```ts
import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { sql } from "kysely";
import type { Trx } from "../db/index";
import { DomainError } from "./errors";

export const IDEMPOTENCY_HEADER = "idempotency-key";
const KEY_FORMAT = /^[A-Za-z0-9_-]{8,200}$/;

export function idempotencyKeyFrom(req: FastifyRequest): string {
  const value = req.headers[IDEMPOTENCY_HEADER];
  if (typeof value !== "string" || !KEY_FORMAT.test(value)) throw new DomainError("idempotency_key_required");
  return value;
}

/** Identifica a requisição: a mesma chave com outra rota, outro autor ou outro corpo é recusada. */
export function requestHash(parts: { route: string; actorId: string; body: unknown }): string {
  return createHash("sha256")
    .update(JSON.stringify([parts.route, parts.actorId, parts.body ?? null]))
    .digest("hex");
}

/**
 * Executa `fn` uma única vez por (escola, chave), na transação de quem chama.
 * - A chave é gravada antes do trabalho; uma repetição concorrente espera na chave primária até o commit
 *   da primeira e então devolve a resposta gravada.
 * - Se o trabalho falhar, a transação inteira volta e a chave não fica gravada: a repetição executa de novo.
 * - A resposta é lida como texto para não ter as chaves convertidas pelo CamelCasePlugin.
 */
export async function idempotent<T>(
  trx: Trx,
  input: { schoolId: string; key: string; requestHash: string },
  fn: () => Promise<T>,
): Promise<{ response: T; replayed: boolean }> {
  const claimed = await trx
    .insertInto("idempotencyKeys")
    .values({ schoolId: input.schoolId, key: input.key, requestHash: input.requestHash })
    .onConflict((oc) => oc.columns(["schoolId", "key"]).doNothing())
    .returning("key")
    .executeTakeFirst();

  if (!claimed) {
    const row = await trx
      .selectFrom("idempotencyKeys")
      .select(["requestHash", sql<string | null>`response::text`.as("responseText")])
      .where("schoolId", "=", input.schoolId)
      .where("key", "=", input.key)
      .executeTakeFirstOrThrow();
    if (row.requestHash !== input.requestHash || row.responseText === null) {
      throw new DomainError("idempotency_key_reused");
    }
    return { response: JSON.parse(row.responseText) as T, replayed: true };
  }

  const response = await fn();
  const text = JSON.stringify(response);
  await trx
    .updateTable("idempotencyKeys")
    .set({ response: text })
    .where("schoolId", "=", input.schoolId)
    .where("key", "=", input.key)
    .execute();
  return { response: JSON.parse(text) as T, replayed: false };
}
```

- [ ] **Step 3: Rodar e ver passar**

Run: `pnpm --filter @app-lanche/api exec vitest run src/platform/idempotency.test.ts` e `pnpm --filter @app-lanche/contracts test` → PASS. Depois `pnpm typecheck && pnpm lint && pnpm test`.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/platform/idempotency.ts apps/api/src/platform/idempotency.test.ts apps/api/src/platform/errors.ts packages/contracts/src/errors.ts
git commit -m "feat(api): add Idempotency-Key helper backed by idempotency_keys"
```

---
### Task 3: Cardápio e dias de serviço (`catalog`)

**Files:**
- Create: `packages/contracts/src/common.ts`, `packages/contracts/src/catalog.ts`; Modify: `packages/contracts/src/index.ts`, `packages/contracts/src/errors.ts`
- Modify: `apps/api/src/platform/errors.ts` (códigos e `isUniqueViolation`)
- Create: `apps/api/src/modules/catalog/{repo,service,routes}.ts`, `apps/api/src/modules/catalog/catalog.test.ts`
- Modify: `apps/api/src/app.ts` (registrar `catalogRoutes`)
- Modify: `apps/api/test/helpers.ts` (fixtures de pedido)

**Interfaces:**
- Consumes: `idempotent`, `idempotencyKeyFrom`, `requestHash` (Task 2).
- Produces (contracts): `IsoDate`, `Cents`, `Uuid` em `common.ts`; `MenuItem`, `MenuItemListResponse`, `CreateMenuItemRequest`, `UpdateMenuItemRequest`, `UpsertServiceDayRequest`, `ServiceDay`, `ServiceDayListResponse`, `GuardianServiceDay`, `GuardianServiceDayListResponse`, `GuardianMenuResponse`.
- Produces (api, `modules/catalog/service.ts`) para os outros módulos:
  - `type LockedServiceDay = { id: string; serviceDate: string; cutoffAt: Date; freezeAt: Date; status: "open" | "closed"; closedAt: Date | null; beforeCutoff: boolean }`
  - `lockServiceDayByDate(trx: Trx, serviceDate: string, mode: "share" | "update"): Promise<LockedServiceDay | undefined>`
  - `lockServiceDayById(trx: Trx, id: string, mode: "share" | "update"): Promise<LockedServiceDay>` (lança se não existir)
  - `serviceDayPrices(trx: Trx, serviceDayId: string): Promise<Map<string, { name: string; priceCents: number }>>`
  - `markServiceDayClosed(trx: Trx, serviceDayId: string): Promise<Date | null>` (devolve `closed_at`; `null` se já estava fechado)
- Produces (`platform/errors.ts`): `isUniqueViolation(err: unknown, constraint: string): boolean`.
- Produces (`test/helpers.ts`):
  - `guardianCookie(schoolId: string, guardianId: string): Promise<Record<string, string>>`
  - `staffCookie(schoolId: string, role?: StaffRole): Promise<{ cookies: Record<string, string>; staffUserId: string }>`
  - `seedFamily(schoolId: string, names?: string[]): Promise<{ guardianId: string; studentIds: string[] }>` — um responsável com telefone único e um aluno por nome (turma "Infantil 3A", criada se faltar).
  - `seedServiceDay(schoolId: string, opts?: { serviceDate?: string; cutoffInMinutes?: number; items?: { name: string; priceCents: number }[] }): Promise<{ serviceDayId: string; serviceDate: string; items: { id: string; name: string; priceCents: number }[] }>` — `cutoff_at = now() + cutoffInMinutes` (padrão 60) pelo relógio do banco; itens padrão `[{ name: "Misto quente", priceCents: 900 }, { name: "Suco", priceCents: 450 }]`; data padrão `"2030-03-04"`.
- Códigos de erro novos: `cutoff_passed` (409), `service_day_locked` (409), `menu_item_name_taken` (409).

Regras:
- `PUT /api/admin/v1/service-days/:date` cria ou substitui o dia. `cutoff_at = (date + coalesce(cutoffTime, schools.default_cutoff_time)) AT TIME ZONE schools.timezone`, `freeze_at = cutoff_at + 5 min`, calculados no SQL. Recusa: `cutoff_passed` se `cutoff_at <= now()`; `service_day_locked` se o dia está `closed` ou já tem algum checkout; `validation_failed` se algum item não existe ou está inativo. Preço do dia = `priceCents` informado ou o preço atual do item.
- Guardião vê só dias `open` com `cutoff_at > now()`, até 14, em ordem de data.
- Rotas de equipe: papéis `admin` e `secretaria`. Rotas do responsável: `{ kind: "guardian", scope: "order" }`.

- [ ] **Step 1: Contratos**

`packages/contracts/src/common.ts`:

```ts
import { z } from "zod";

export const Uuid = z.string().uuid();

/** Data civil `YYYY-MM-DD` válida (rejeita 2030-02-31). */
export const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "invalid date");

/** Centavos inteiros positivos, até R$ 10.000,00. */
export const Cents = z.number().int().positive().max(1_000_000);

export const IsoDateTime = z.string().datetime({ offset: true });
```

`packages/contracts/src/catalog.ts`:

```ts
import { z } from "zod";
import { Cents, IsoDate, IsoDateTime, Uuid } from "./common";

export const MenuItem = z.object({ id: Uuid, name: z.string(), priceCents: Cents, active: z.boolean() });
export type MenuItem = z.infer<typeof MenuItem>;

export const MenuItemListResponse = z.object({ items: z.array(MenuItem) });
export type MenuItemListResponse = z.infer<typeof MenuItemListResponse>;

export const CreateMenuItemRequest = z.object({ name: z.string().trim().min(1).max(80), priceCents: Cents });
export type CreateMenuItemRequest = z.infer<typeof CreateMenuItemRequest>;

export const UpdateMenuItemRequest = z
  .object({ name: z.string().trim().min(1).max(80).optional(), priceCents: Cents.optional(), active: z.boolean().optional() })
  .refine((v) => Object.keys(v).length > 0, "empty update");
export type UpdateMenuItemRequest = z.infer<typeof UpdateMenuItemRequest>;

export const ServiceDayStatus = z.enum(["open", "closed"]);
export type ServiceDayStatus = z.infer<typeof ServiceDayStatus>;

export const UpsertServiceDayRequest = z.object({
  cutoffTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  items: z
    .array(z.object({ menuItemId: Uuid, priceCents: Cents.optional() }))
    .min(1)
    .max(30)
    .refine((items) => new Set(items.map((i) => i.menuItemId)).size === items.length, "duplicate item"),
});
export type UpsertServiceDayRequest = z.infer<typeof UpsertServiceDayRequest>;

export const DayItem = z.object({ menuItemId: Uuid, name: z.string(), priceCents: Cents });
export type DayItem = z.infer<typeof DayItem>;

export const ServiceDay = z.object({
  serviceDate: IsoDate,
  cutoffAt: IsoDateTime,
  freezeAt: IsoDateTime,
  status: ServiceDayStatus,
  items: z.array(DayItem),
});
export type ServiceDay = z.infer<typeof ServiceDay>;

export const ServiceDayListResponse = z.object({ serviceDays: z.array(ServiceDay) });
export type ServiceDayListResponse = z.infer<typeof ServiceDayListResponse>;

export const GuardianServiceDay = z.object({ serviceDate: IsoDate, cutoffAt: IsoDateTime, items: z.array(DayItem) });
export type GuardianServiceDay = z.infer<typeof GuardianServiceDay>;

export const GuardianServiceDayListResponse = z.object({ serviceDays: z.array(GuardianServiceDay) });
export type GuardianServiceDayListResponse = z.infer<typeof GuardianServiceDayListResponse>;

export const GuardianMenuResponse = GuardianServiceDay.extend({ acceptingOrders: z.boolean() });
export type GuardianMenuResponse = z.infer<typeof GuardianMenuResponse>;
```

Exporte `common` e `catalog` em `index.ts`. Acrescente os três códigos de erro. Em `apps/api/src/platform/errors.ts`:

```ts
/** Violação de UNIQUE (23505) de uma constraint ou índice específico. */
export function isUniqueViolation(err: unknown, constraint: string): boolean {
  const e = err as { code?: unknown; constraint?: unknown } | null;
  return e?.code === "23505" && e.constraint === constraint;
}
```

- [ ] **Step 2: Fixtures de teste em `test/helpers.ts`**

```ts
import { sql } from "kysely";
import { SESSION_COOKIE, signToken, type StaffRole } from "../src/platform/session";

export async function guardianCookie(schoolId: string, guardianId: string): Promise<Record<string, string>> {
  const token = await signToken("session", { kind: "guardian", sub: guardianId, schoolId, scope: "order" }, 3600);
  return { [SESSION_COOKIE]: token };
}

export async function staffCookie(
  schoolId: string,
  role: StaffRole = "admin",
): Promise<{ cookies: Record<string, string>; staffUserId: string }> {
  const staffUserId = uuidv7();
  await adminDb()
    .insertInto("staffUsers")
    .values({ id: staffUserId, schoolId, email: `staff-${staffUserId}@escola.test`, role })
    .execute();
  const token = await signToken("session", { kind: "staff", sub: staffUserId, schoolId, role }, 3600);
  return { cookies: { [SESSION_COOKIE]: token }, staffUserId };
}

let phoneSeq = 0;

export async function seedFamily(
  schoolId: string,
  names: string[] = ["Léo", "Bia"],
): Promise<{ guardianId: string; studentIds: string[] }> {
  const db = adminDb();
  const cls = await db
    .insertInto("classes")
    .values({ id: uuidv7(), schoolId, name: "Infantil 3A" })
    .onConflict((oc) => oc.columns(["schoolId", "name"]).doUpdateSet({ name: "Infantil 3A" }))
    .returning("id")
    .executeTakeFirstOrThrow();
  const guardianId = uuidv7();
  phoneSeq += 1;
  await db
    .insertInto("guardians")
    .values({ id: guardianId, schoolId, phoneE164: `+55119${String(70000000 + phoneSeq).padStart(8, "0")}`, firstName: "Ana" })
    .execute();
  const studentIds: string[] = [];
  for (const firstName of names) {
    const id = uuidv7();
    await db
      .insertInto("students")
      .values({ id, schoolId, classId: cls.id, externalCode: `S-${id}`, firstName })
      .execute();
    await db.insertInto("guardianStudents").values({ schoolId, guardianId, studentId: id }).execute();
    studentIds.push(id);
  }
  return { guardianId, studentIds };
}

export async function seedServiceDay(
  schoolId: string,
  opts: { serviceDate?: string; cutoffInMinutes?: number; items?: { name: string; priceCents: number }[] } = {},
): Promise<{ serviceDayId: string; serviceDate: string; items: { id: string; name: string; priceCents: number }[] }> {
  const db = adminDb();
  const serviceDate = opts.serviceDate ?? "2030-03-04";
  const minutes = opts.cutoffInMinutes ?? 60;
  const serviceDayId = uuidv7();
  await sql`
    INSERT INTO service_days (id, school_id, service_date, cutoff_at, freeze_at)
    VALUES (${serviceDayId}, ${schoolId}, ${serviceDate}::date,
            now() + make_interval(mins => ${minutes}), now() + make_interval(mins => ${minutes + 5}))`.execute(db);
  const items: { id: string; name: string; priceCents: number }[] = [];
  for (const item of opts.items ?? [
    { name: "Misto quente", priceCents: 900 },
    { name: "Suco", priceCents: 450 },
  ]) {
    const id = uuidv7();
    const name = `${item.name} #${id.slice(-6)}`;
    await db.insertInto("menuItems").values({ id, schoolId, name, priceCents: item.priceCents }).execute();
    await db.insertInto("serviceDayItems").values({ schoolId, serviceDayId, menuItemId: id, priceCents: item.priceCents }).execute();
    items.push({ id, name, priceCents: item.priceCents });
  }
  return { serviceDayId, serviceDate, items };
}
```

(O nome gravado do item leva um sufixo `#xxxxxx` para não colidir com `UNIQUE (school_id, name)` quando um teste cria vários dias na mesma escola; o `name` devolvido é o nome gravado, para os testes compararem com o que a API devolve.)

Se `test/helpers.ts` importar de `src/platform/session` criar ciclo de importação ou falha de config no carregamento, importe dentro das funções (`await import(...)`) e registre no relatório.

- [ ] **Step 3: Testes que falham**

`apps/api/src/modules/catalog/catalog.test.ts`:

```ts
import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { describe, expect, it } from "vitest";
import { adminDb, createSchool, guardianCookie, seedFamily, seedServiceDay, staffCookie } from "../../../test/helpers";
import { buildApp } from "../../app";

const key = () => uuidv7();

async function createItem(cookies: Record<string, string>, name: string, priceCents: number, k = key()) {
  return buildApp().inject({
    method: "POST",
    url: "/api/admin/v1/menu-items",
    cookies,
    headers: { "idempotency-key": k },
    payload: { name, priceCents },
  });
}

describe("menu items", () => {
  it("creates, lists and updates items", async () => {
    const schoolId = await createSchool();
    const { cookies } = await staffCookie(schoolId, "secretaria");
    const created = await createItem(cookies, "  Misto quente ", 900);
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ name: "Misto quente", priceCents: 900, active: true });
    const id = created.json().id as string;

    const patched = await buildApp().inject({
      method: "PATCH",
      url: `/api/admin/v1/menu-items/${id}`,
      cookies,
      payload: { priceCents: 950, active: false },
    });
    expect(patched.json()).toEqual({ id, name: "Misto quente", priceCents: 950, active: false });

    const list = await buildApp().inject({ method: "GET", url: "/api/admin/v1/menu-items", cookies });
    expect(list.json()).toEqual({ items: [{ id, name: "Misto quente", priceCents: 950, active: false }] });
  });

  it("replays a repeated Idempotency-Key and requires one", async () => {
    const schoolId = await createSchool();
    const { cookies } = await staffCookie(schoolId);
    const k = key();
    const a = await createItem(cookies, "Suco", 450, k);
    const b = await createItem(cookies, "Suco", 450, k);
    expect(b.json()).toEqual(a.json());
    const missing = await buildApp().inject({
      method: "POST",
      url: "/api/admin/v1/menu-items",
      cookies,
      payload: { name: "Bolo", priceCents: 500 },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe("idempotency_key_required");
  });

  it("rejects a duplicate name with 409", async () => {
    const schoolId = await createSchool();
    const { cookies } = await staffCookie(schoolId);
    await createItem(cookies, "Suco", 450);
    const dup = await createItem(cookies, "Suco", 500);
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("menu_item_name_taken");
  });

  it("is closed to the kitchen role and to guardians", async () => {
    const schoolId = await createSchool();
    const kitchen = await staffCookie(schoolId, "cozinha");
    expect((await buildApp().inject({ method: "GET", url: "/api/admin/v1/menu-items", cookies: kitchen.cookies })).statusCode).toBe(403);
    const family = await seedFamily(schoolId);
    const guardian = await guardianCookie(schoolId, family.guardianId);
    expect((await buildApp().inject({ method: "GET", url: "/api/admin/v1/menu-items", cookies: guardian })).statusCode).toBe(403);
  });
});

describe("service days", () => {
  async function setup() {
    const schoolId = await createSchool();
    const { cookies } = await staffCookie(schoolId);
    const misto = (await createItem(cookies, "Misto quente", 900)).json().id as string;
    const suco = (await createItem(cookies, "Suco", 450)).json().id as string;
    return { schoolId, cookies, misto, suco };
  }

  const put = (cookies: Record<string, string>, date: string, payload: unknown) =>
    buildApp().inject({ method: "PUT", url: `/api/admin/v1/service-days/${date}`, cookies, payload });

  it("computes the cutoff in the school's timezone", async () => {
    const { cookies, misto, suco } = await setup();
    const res = await put(cookies, "2030-03-04", { items: [{ menuItemId: misto }, { menuItemId: suco, priceCents: 400 }] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      serviceDate: "2030-03-04",
      cutoffAt: "2030-03-04T10:30:00.000Z",
      freezeAt: "2030-03-04T10:35:00.000Z",
      status: "open",
      items: [
        { menuItemId: misto, name: "Misto quente", priceCents: 900 },
        { menuItemId: suco, name: "Suco", priceCents: 400 },
      ],
    });
    const custom = await put(cookies, "2030-03-05", { cutoffTime: "09:00", items: [{ menuItemId: misto }] });
    expect(custom.json().cutoffAt).toBe("2030-03-05T12:00:00.000Z");
  });

  it("replaces the items of an open day without checkouts", async () => {
    const { cookies, misto, suco } = await setup();
    await put(cookies, "2030-03-04", { items: [{ menuItemId: misto }] });
    const res = await put(cookies, "2030-03-04", { items: [{ menuItemId: suco }] });
    expect(res.json().items).toEqual([{ menuItemId: suco, name: "Suco", priceCents: 450 }]);
  });

  it("rejects a day whose cutoff already passed", async () => {
    const { cookies, misto } = await setup();
    const res = await put(cookies, "2020-01-02", { items: [{ menuItemId: misto }] });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("cutoff_passed");
  });

  it("rejects unknown or inactive items and invalid dates", async () => {
    const { cookies, misto } = await setup();
    await buildApp().inject({ method: "PATCH", url: `/api/admin/v1/menu-items/${misto}`, cookies, payload: { active: false } });
    expect((await put(cookies, "2030-03-04", { items: [{ menuItemId: misto }] })).statusCode).toBe(400);
    expect((await put(cookies, "2030-03-04", { items: [{ menuItemId: uuidv7() }] })).statusCode).toBe(400);
    expect((await put(cookies, "2030-02-31", { items: [{ menuItemId: uuidv7() }] })).statusCode).toBe(400);
  });

  it("locks a day once it has a checkout", async () => {
    const { schoolId, cookies, misto } = await setup();
    await put(cookies, "2030-03-04", { items: [{ menuItemId: misto }] });
    const day = await adminDb().selectFrom("serviceDays").select("id").where("schoolId", "=", schoolId).executeTakeFirstOrThrow();
    const family = await seedFamily(schoolId);
    await adminDb()
      .insertInto("checkouts")
      .values({ id: uuidv7(), schoolId, guardianId: family.guardianId, serviceDayId: day.id, totalCents: 900 })
      .execute();
    const res = await put(cookies, "2030-03-04", { items: [{ menuItemId: misto }] });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("service_day_locked");
  });

  it("lists days from a date for staff", async () => {
    const { cookies, misto } = await setup();
    await put(cookies, "2030-03-05", { items: [{ menuItemId: misto }] });
    await put(cookies, "2030-03-04", { items: [{ menuItemId: misto }] });
    const res = await buildApp().inject({ method: "GET", url: "/api/admin/v1/service-days?from=2030-03-05", cookies });
    expect(res.json().serviceDays.map((d: { serviceDate: string }) => d.serviceDate)).toEqual(["2030-03-05"]);
  });

  it("shows guardians only open days before the cutoff, and the menu of a day", async () => {
    const schoolId = await createSchool();
    const family = await seedFamily(schoolId);
    const cookies = await guardianCookie(schoolId, family.guardianId);
    const open = await seedServiceDay(schoolId, { serviceDate: "2030-03-04" });
    await seedServiceDay(schoolId, { serviceDate: "2030-03-05", cutoffInMinutes: -1 });
    const closed = await seedServiceDay(schoolId, { serviceDate: "2030-03-06" });
    await sql`UPDATE service_days SET status = 'closed', closed_at = now() WHERE id = ${closed.serviceDayId}`.execute(adminDb());

    const list = await buildApp().inject({ method: "GET", url: "/api/v1/service-days", cookies });
    expect(list.statusCode).toBe(200);
    expect(list.json().serviceDays.map((d: { serviceDate: string }) => d.serviceDate)).toEqual(["2030-03-04"]);
    expect(list.json().serviceDays[0].items).toHaveLength(open.items.length);

    const menu = await buildApp().inject({ method: "GET", url: "/api/v1/service-days/2030-03-05/menu", cookies });
    expect(menu.json()).toMatchObject({ serviceDate: "2030-03-05", acceptingOrders: false });
    const missing = await buildApp().inject({ method: "GET", url: "/api/v1/service-days/2031-01-01/menu", cookies });
    expect(missing.statusCode).toBe(404);
  });
});
```

Run: `pnpm --filter @app-lanche/api exec vitest run src/modules/catalog` → FAIL (rotas inexistentes, 404).

- [ ] **Step 4: Implementar repo**

`apps/api/src/modules/catalog/repo.ts`:

```ts
import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import type { Trx } from "../../db/index";

const MENU_COLUMNS = ["id", "name", "priceCents", "active"] as const;

export async function listMenuItems(trx: Trx) {
  return trx.selectFrom("menuItems").select(MENU_COLUMNS).orderBy("name").execute();
}

export async function insertMenuItem(trx: Trx, schoolId: string, input: { name: string; priceCents: number }) {
  return trx
    .insertInto("menuItems")
    .values({ id: uuidv7(), schoolId, ...input })
    .returning(MENU_COLUMNS)
    .executeTakeFirstOrThrow();
}

export async function updateMenuItem(
  trx: Trx,
  id: string,
  patch: { name?: string; priceCents?: number; active?: boolean },
) {
  return trx.updateTable("menuItems").set(patch).where("id", "=", id).returning(MENU_COLUMNS).executeTakeFirst();
}

export async function activeMenuItems(trx: Trx, ids: string[]) {
  if (ids.length === 0) return [];
  return trx
    .selectFrom("menuItems")
    .select(["id", "priceCents"])
    .where("id", "in", ids)
    .where("active", "=", true)
    .execute();
}

function serviceDayQuery(trx: Trx) {
  return trx
    .selectFrom("serviceDays")
    .select([
      "id",
      "serviceDate",
      "cutoffAt",
      "freezeAt",
      "status",
      "closedAt",
      sql<boolean>`now() <= cutoff_at`.as("beforeCutoff"),
    ]);
}

export async function lockServiceDayByDate(trx: Trx, serviceDate: string, mode: "share" | "update") {
  const q = serviceDayQuery(trx).where("serviceDate", "=", serviceDate);
  return (mode === "share" ? q.forShare() : q.forUpdate()).executeTakeFirst();
}

export async function lockServiceDayById(trx: Trx, id: string, mode: "share" | "update") {
  const q = serviceDayQuery(trx).where("id", "=", id);
  return (mode === "share" ? q.forShare() : q.forUpdate()).executeTakeFirst();
}

export async function serviceDayHasCheckouts(trx: Trx, serviceDayId: string): Promise<boolean> {
  const row = await trx.selectFrom("checkouts").select("id").where("serviceDayId", "=", serviceDayId).limit(1).executeTakeFirst();
  return row !== undefined;
}

/** Cria ou atualiza o horário do dia, calculado no banco no fuso da escola. */
export async function upsertServiceDay(trx: Trx, schoolId: string, serviceDate: string, cutoffTime: string | null) {
  const { rows } = await sql<{ id: string; cutoffInFuture: boolean }>`
    INSERT INTO service_days (id, school_id, service_date, cutoff_at, freeze_at)
    SELECT ${uuidv7()}, s.id, ${serviceDate}::date, c.cutoff_at, c.cutoff_at + interval '5 minutes'
    FROM schools s
    CROSS JOIN LATERAL (
      SELECT ((${serviceDate}::date + coalesce(${cutoffTime}::time, s.default_cutoff_time)) AT TIME ZONE s.timezone) AS cutoff_at
    ) c
    WHERE s.id = ${schoolId}
    ON CONFLICT (school_id, service_date)
      DO UPDATE SET cutoff_at = EXCLUDED.cutoff_at, freeze_at = EXCLUDED.freeze_at
    RETURNING id, now() < cutoff_at AS cutoff_in_future`.execute(trx);
  return rows[0]!;
}

export async function replaceServiceDayItems(
  trx: Trx,
  schoolId: string,
  serviceDayId: string,
  items: { menuItemId: string; priceCents: number }[],
): Promise<void> {
  await trx.deleteFrom("serviceDayItems").where("serviceDayId", "=", serviceDayId).execute();
  await trx
    .insertInto("serviceDayItems")
    .values(items.map((i) => ({ schoolId, serviceDayId, menuItemId: i.menuItemId, priceCents: i.priceCents })))
    .execute();
}

export async function serviceDayItems(trx: Trx, serviceDayIds: string[]) {
  if (serviceDayIds.length === 0) return [];
  return trx
    .selectFrom("serviceDayItems")
    .innerJoin("menuItems", "menuItems.id", "serviceDayItems.menuItemId")
    .select(["serviceDayItems.serviceDayId", "serviceDayItems.menuItemId", "menuItems.name", "serviceDayItems.priceCents"])
    .where("serviceDayItems.serviceDayId", "in", serviceDayIds)
    .orderBy("menuItems.name")
    .execute();
}

export async function listServiceDaysFrom(trx: Trx, from: string | null) {
  return trx
    .selectFrom("serviceDays")
    .select(["id", "serviceDate", "cutoffAt", "freezeAt", "status"])
    .where(
      "serviceDate",
      ">=",
      from === null
        ? sql<string>`(now() AT TIME ZONE (SELECT timezone FROM schools WHERE id = app_school_id()))::date`
        : sql<string>`${from}::date`,
    )
    .orderBy("serviceDate")
    .limit(60)
    .execute();
}

export async function listOpenServiceDays(trx: Trx) {
  return trx
    .selectFrom("serviceDays")
    .select(["id", "serviceDate", "cutoffAt"])
    .where("status", "=", "open")
    .where(sql<boolean>`cutoff_at > now()`)
    .orderBy("serviceDate")
    .limit(14)
    .execute();
}

export async function markServiceDayClosed(trx: Trx, serviceDayId: string): Promise<Date | null> {
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

(Se o Kysely não aceitar a expressão `sql<string>` no lado direito do `where` com `"serviceDate"`, use `sql<boolean>\`service_date >= ...\`` como no `listOpenServiceDays` e registre a adaptação.)

- [ ] **Step 5: Implementar service e rotas**

`apps/api/src/modules/catalog/service.ts`:

```ts
import type {
  CreateMenuItemRequest,
  DayItem,
  GuardianMenuResponse,
  GuardianServiceDayListResponse,
  MenuItem,
  MenuItemListResponse,
  ServiceDay,
  ServiceDayListResponse,
  ServiceDayStatus,
  UpdateMenuItemRequest,
  UpsertServiceDayRequest,
} from "@app-lanche/contracts";
import { withTenant, type Trx } from "../../db/index";
import { DomainError, isUniqueViolation } from "../../platform/errors";
import { idempotent, requestHash } from "../../platform/idempotency";
import type { SessionClaims } from "../../platform/session";
import * as repo from "./repo";

const NAME_CONSTRAINT = "menu_items_school_id_name_key";

export type LockedServiceDay = {
  id: string;
  serviceDate: string;
  cutoffAt: Date;
  freezeAt: Date;
  status: ServiceDayStatus;
  closedAt: Date | null;
  beforeCutoff: boolean;
};

function asLocked(row: NonNullable<Awaited<ReturnType<typeof repo.lockServiceDayById>>>): LockedServiceDay {
  return { ...row, status: row.status as ServiceDayStatus };
}

export async function lockServiceDayByDate(
  trx: Trx,
  serviceDate: string,
  mode: "share" | "update",
): Promise<LockedServiceDay | undefined> {
  const row = await repo.lockServiceDayByDate(trx, serviceDate, mode);
  return row && asLocked(row);
}

export async function lockServiceDayById(trx: Trx, id: string, mode: "share" | "update"): Promise<LockedServiceDay> {
  const row = await repo.lockServiceDayById(trx, id, mode);
  if (!row) throw new Error(`service day ${id} not found`);
  return asLocked(row);
}

export async function serviceDayPrices(
  trx: Trx,
  serviceDayId: string,
): Promise<Map<string, { name: string; priceCents: number }>> {
  const rows = await repo.serviceDayItems(trx, [serviceDayId]);
  return new Map(rows.map((r) => [r.menuItemId, { name: r.name, priceCents: r.priceCents }]));
}

export const markServiceDayClosed = repo.markServiceDayClosed;

async function itemsByDay(trx: Trx, ids: string[]): Promise<Map<string, DayItem[]>> {
  const map = new Map<string, DayItem[]>(ids.map((id) => [id, []]));
  for (const r of await repo.serviceDayItems(trx, ids)) {
    map.get(r.serviceDayId)!.push({ menuItemId: r.menuItemId, name: r.name, priceCents: r.priceCents });
  }
  return map;
}

function rethrowName(err: unknown): never {
  if (isUniqueViolation(err, NAME_CONSTRAINT)) throw new DomainError("menu_item_name_taken");
  throw err;
}

export async function listMenuItems(session: SessionClaims): Promise<MenuItemListResponse> {
  return { items: await withTenant(session.schoolId, (trx) => repo.listMenuItems(trx)) };
}

export async function createMenuItem(session: SessionClaims, key: string, body: CreateMenuItemRequest): Promise<MenuItem> {
  const hash = requestHash({ route: "POST /api/admin/v1/menu-items", actorId: session.sub, body });
  try {
    return await withTenant(session.schoolId, async (trx) => {
      const { response } = await idempotent(trx, { schoolId: session.schoolId, key, requestHash: hash }, () =>
        repo.insertMenuItem(trx, session.schoolId, body),
      );
      return response;
    });
  } catch (err) {
    rethrowName(err);
  }
}

export async function updateMenuItem(session: SessionClaims, id: string, body: UpdateMenuItemRequest): Promise<MenuItem> {
  try {
    const row = await withTenant(session.schoolId, (trx) => repo.updateMenuItem(trx, id, body));
    if (!row) throw new DomainError("not_found");
    return row;
  } catch (err) {
    rethrowName(err);
  }
}

async function serviceDayView(trx: Trx, serviceDate: string): Promise<ServiceDay> {
  const day = await repo.lockServiceDayByDate(trx, serviceDate, "share");
  if (!day) throw new DomainError("not_found");
  const items = await itemsByDay(trx, [day.id]);
  return {
    serviceDate: day.serviceDate,
    cutoffAt: day.cutoffAt.toISOString(),
    freezeAt: day.freezeAt.toISOString(),
    status: day.status as ServiceDayStatus,
    items: items.get(day.id)!,
  };
}

export async function upsertServiceDay(
  session: SessionClaims,
  serviceDate: string,
  body: UpsertServiceDayRequest,
): Promise<ServiceDay> {
  const schoolId = session.schoolId;
  return withTenant(schoolId, async (trx) => {
    const existing = await repo.lockServiceDayByDate(trx, serviceDate, "update");
    if (existing && (existing.status === "closed" || (await repo.serviceDayHasCheckouts(trx, existing.id)))) {
      throw new DomainError("service_day_locked");
    }
    const day = await repo.upsertServiceDay(trx, schoolId, serviceDate, body.cutoffTime ?? null);
    if (!day.cutoffInFuture) throw new DomainError("cutoff_passed");

    const ids = body.items.map((i) => i.menuItemId);
    const active = new Map((await repo.activeMenuItems(trx, ids)).map((m) => [m.id, m.priceCents]));
    if (active.size !== ids.length) throw new DomainError("validation_failed", "unknown or inactive menu item");
    await repo.replaceServiceDayItems(
      trx,
      schoolId,
      day.id,
      body.items.map((i) => ({ menuItemId: i.menuItemId, priceCents: i.priceCents ?? active.get(i.menuItemId)! })),
    );
    return serviceDayView(trx, serviceDate);
  });
}

export async function listServiceDays(session: SessionClaims, from: string | null): Promise<ServiceDayListResponse> {
  return withTenant(session.schoolId, async (trx) => {
    const days = await repo.listServiceDaysFrom(trx, from);
    const items = await itemsByDay(trx, days.map((d) => d.id));
    return {
      serviceDays: days.map((d) => ({
        serviceDate: d.serviceDate,
        cutoffAt: d.cutoffAt.toISOString(),
        freezeAt: d.freezeAt.toISOString(),
        status: d.status as ServiceDayStatus,
        items: items.get(d.id)!,
      })),
    };
  });
}

export async function listOpenDaysForGuardian(session: SessionClaims): Promise<GuardianServiceDayListResponse> {
  return withTenant(session.schoolId, async (trx) => {
    const days = await repo.listOpenServiceDays(trx);
    const items = await itemsByDay(trx, days.map((d) => d.id));
    return {
      serviceDays: days.map((d) => ({ serviceDate: d.serviceDate, cutoffAt: d.cutoffAt.toISOString(), items: items.get(d.id)! })),
    };
  });
}

export async function guardianMenu(session: SessionClaims, serviceDate: string): Promise<GuardianMenuResponse> {
  return withTenant(session.schoolId, async (trx) => {
    const day = await repo.lockServiceDayByDate(trx, serviceDate, "share");
    if (!day) throw new DomainError("not_found");
    const items = await itemsByDay(trx, [day.id]);
    return {
      serviceDate: day.serviceDate,
      cutoffAt: day.cutoffAt.toISOString(),
      acceptingOrders: day.status === "open" && day.beforeCutoff,
      items: items.get(day.id)!,
    };
  });
}
```

(Nota: `serviceDayView`/`guardianMenu` usam `FOR SHARE` só para reaproveitar a mesma consulta; se preferir, crie uma variante sem trava em `repo` e registre.)

`apps/api/src/modules/catalog/routes.ts`:

```ts
import {
  CreateMenuItemRequest,
  IsoDate,
  UpdateMenuItemRequest,
  UpsertServiceDayRequest,
  Uuid,
} from "@app-lanche/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RouteAuth } from "../../app";
import { idempotencyKeyFrom } from "../../platform/idempotency";
import * as service from "./service";

const OFFICE: RouteAuth = { kind: "staff", roles: ["admin", "secretaria"] };
const GUARDIAN: RouteAuth = { kind: "guardian", scope: "order" };
const IdParams = z.object({ id: Uuid });
const DateParams = z.object({ date: IsoDate });
const FromQuery = z.object({ from: IsoDate.optional() });

export async function catalogRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/admin/v1/menu-items", { config: { auth: OFFICE } }, async (req) => service.listMenuItems(req.session!));

  app.post("/api/admin/v1/menu-items", { config: { auth: OFFICE } }, async (req) =>
    service.createMenuItem(req.session!, idempotencyKeyFrom(req), CreateMenuItemRequest.parse(req.body)),
  );

  app.patch("/api/admin/v1/menu-items/:id", { config: { auth: OFFICE } }, async (req) =>
    service.updateMenuItem(req.session!, IdParams.parse(req.params).id, UpdateMenuItemRequest.parse(req.body)),
  );

  app.put("/api/admin/v1/service-days/:date", { config: { auth: OFFICE } }, async (req) =>
    service.upsertServiceDay(req.session!, DateParams.parse(req.params).date, UpsertServiceDayRequest.parse(req.body)),
  );

  app.get("/api/admin/v1/service-days", { config: { auth: OFFICE } }, async (req) =>
    service.listServiceDays(req.session!, FromQuery.parse(req.query).from ?? null),
  );

  app.get("/api/v1/service-days", { config: { auth: GUARDIAN } }, async (req) =>
    service.listOpenDaysForGuardian(req.session!),
  );

  app.get("/api/v1/service-days/:date/menu", { config: { auth: GUARDIAN } }, async (req) =>
    service.guardianMenu(req.session!, DateParams.parse(req.params).date),
  );
}
```

Registre `app.register(catalogRoutes)` em `app.ts`. O PATCH segue a checagem de origem (CSRF) como toda rota com sessão que não é GET.

O nome da constraint de nome único gerada pelo Postgres é `menu_items_school_id_name_key`; confirme com `\d menu_items` se o teste de duplicidade falhar.

- [ ] **Step 6: Rodar e ver passar; commit**

Run: `pnpm --filter @app-lanche/api exec vitest run src/modules/catalog` → PASS. Depois `pnpm typecheck && pnpm lint && pnpm test`.

```bash
git add packages/contracts/src apps/api/src/modules/catalog apps/api/src/app.ts apps/api/src/platform/errors.ts apps/api/test/helpers.ts
git commit -m "feat(api): add menu items and service days with database-computed cutoff"
```

---

### Task 4: Carteira (`wallet`)

**Files:**
- Create: `packages/contracts/src/wallet.ts`; Modify: `packages/contracts/src/index.ts`, `packages/contracts/src/auth.ts` (`MeResponse`), `packages/contracts/src/errors.ts`
- Create: `apps/api/src/modules/wallet/{repo,service,routes}.ts`, `apps/api/src/modules/wallet/wallet.test.ts`
- Modify: `apps/api/src/modules/auth/service.ts` (`getMe` devolve saldo), `apps/api/src/app.ts`, `apps/api/src/platform/errors.ts`
- Modify: testes web/api que montam `MeResponse` (acrescentar `walletBalanceCents`)

**Interfaces:**
- Produces (`modules/wallet/service.ts`):
  - `type WalletEntryKind = "checkout_hold" | "hold_release" | "late_payment_credit" | "cancel_credit" | "refund" | "manual_adjustment"`
  - `type WalletSourceType = "checkout" | "payment" | "adjustment"`
  - `lockBalance(trx: Trx, schoolId: string, guardianId: string): Promise<{ walletId: string; balanceCents: number }>` — cria a carteira se faltar e trava `FOR UPDATE`.
  - `postEntry(trx: Trx, entry: { schoolId: string; guardianId: string; kind: WalletEntryKind; amountCents: number; sourceType: WalletSourceType; sourceId: string; note?: string }): Promise<{ posted: boolean; balanceCents: number }>` — `posted: false` quando a entrada (mesma origem e tipo) já existia; lança `DomainError("insufficient_balance")` se o saldo ficaria negativo.
  - `balanceOf(trx: Trx, guardianId: string): Promise<number>` (sem trava; 0 sem carteira).
- Produces (contracts): `WalletEntryKind`, `WalletResponse`, `WalletAdjustmentRequest`, `WalletAdjustmentResponse`; `MeResponse` ganha `walletBalanceCents: number`.
- Rotas: `GET /api/v1/wallet` (guardian, scope order); `POST /api/admin/v1/guardians/:guardianId/wallet/adjustments` (staff `admin`, com `Idempotency-Key`, `audit` com `action: "wallet.adjust"` e `detail: { guardian_id, amount_cents }`).
- Código de erro novo: `insufficient_balance` (409).

- [ ] **Step 1: Contratos**

`packages/contracts/src/wallet.ts`:

```ts
import { z } from "zod";
import { IsoDateTime, Uuid } from "./common";

export const WalletEntryKind = z.enum([
  "checkout_hold",
  "hold_release",
  "late_payment_credit",
  "cancel_credit",
  "refund",
  "manual_adjustment",
]);
export type WalletEntryKind = z.infer<typeof WalletEntryKind>;

export const WalletResponse = z.object({
  balanceCents: z.number().int().nonnegative(),
  entries: z.array(z.object({ id: Uuid, kind: WalletEntryKind, amountCents: z.number().int(), createdAt: IsoDateTime })),
});
export type WalletResponse = z.infer<typeof WalletResponse>;

export const WalletAdjustmentRequest = z.object({
  amountCents: z
    .number()
    .int()
    .min(-1_000_000)
    .max(1_000_000)
    .refine((v) => v !== 0, "zero adjustment"),
  reason: z.string().trim().min(1).max(200),
});
export type WalletAdjustmentRequest = z.infer<typeof WalletAdjustmentRequest>;

export const WalletAdjustmentResponse = z.object({ balanceCents: z.number().int().nonnegative() });
export type WalletAdjustmentResponse = z.infer<typeof WalletAdjustmentResponse>;
```

Em `auth.ts`, `MeResponse` ganha `walletBalanceCents: z.number().int().nonnegative()`.

- [ ] **Step 2: Testes que falham**

Acrescente a `apps/api/test/helpers.ts` (usado também pelas Tasks 7, 9 e 10):

```ts
/** Invariante do ledger (spec 13): saldo gravado = soma dos lançamentos. Sem carteira conta como verdadeiro. */
export async function walletLedgerMatches(schoolId: string, guardianId: string): Promise<boolean> {
  const { rows } = await sql<{ balance: number; total: number }>`
    SELECT w.balance_cents AS balance, coalesce(sum(e.amount_cents), 0)::bigint AS total
    FROM wallets w LEFT JOIN wallet_entries e ON e.wallet_id = w.id
    WHERE w.school_id = ${schoolId} AND w.guardian_id = ${guardianId}
    GROUP BY w.balance_cents`.execute(adminDb());
  return rows.length === 0 || rows[0]!.balance === rows[0]!.total;
}
```

`apps/api/src/modules/wallet/wallet.test.ts`:

```ts
import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { describe, expect, it } from "vitest";
import { adminDb, createSchool, guardianCookie, seedFamily, staffCookie, walletLedgerMatches as ledgerMatches } from "../../../test/helpers";
import { buildApp } from "../../app";
import { withTenant } from "../../db/index";
import { balanceOf, postEntry } from "./service";

describe("wallet ledger", () => {
  it("posts entries once per source and kind, keeping balance = sum of entries", async () => {
    const schoolId = await createSchool();
    const { guardianId } = await seedFamily(schoolId);
    const sourceId = uuidv7();
    const post = (kind: "cancel_credit" | "checkout_hold", amountCents: number, src = sourceId) =>
      withTenant(schoolId, (trx) => postEntry(trx, { schoolId, guardianId, kind, amountCents, sourceType: "checkout", sourceId: src }));

    expect(await post("cancel_credit", 1500)).toEqual({ posted: true, balanceCents: 1500 });
    expect(await post("cancel_credit", 1500)).toEqual({ posted: false, balanceCents: 1500 });
    expect(await post("checkout_hold", -900, uuidv7())).toEqual({ posted: true, balanceCents: 600 });
    expect(await withTenant(schoolId, (trx) => balanceOf(trx, guardianId))).toBe(600);
    expect(await ledgerMatches(schoolId, guardianId)).toBe(true);
  });

  it("refuses to go negative and leaves nothing behind", async () => {
    const schoolId = await createSchool();
    const { guardianId } = await seedFamily(schoolId);
    await expect(
      withTenant(schoolId, (trx) =>
        postEntry(trx, { schoolId, guardianId, kind: "checkout_hold", amountCents: -1, sourceType: "checkout", sourceId: uuidv7() }),
      ),
    ).rejects.toMatchObject({ code: "insufficient_balance" });
    const entries = await adminDb().selectFrom("walletEntries").select("id").where("schoolId", "=", schoolId).execute();
    expect(entries).toEqual([]);
  });

  it("serializes concurrent entries on the same wallet", async () => {
    const schoolId = await createSchool();
    const { guardianId } = await seedFamily(schoolId);
    await Promise.all(
      Array.from({ length: 10 }, () =>
        withTenant(schoolId, (trx) =>
          postEntry(trx, { schoolId, guardianId, kind: "cancel_credit", amountCents: 100, sourceType: "checkout", sourceId: uuidv7() }),
        ),
      ),
    );
    expect(await withTenant(schoolId, (trx) => balanceOf(trx, guardianId))).toBe(1000);
    expect(await ledgerMatches(schoolId, guardianId)).toBe(true);
  });
});

describe("wallet routes", () => {
  it("shows the guardian balance, entries and /me balance", async () => {
    const schoolId = await createSchool();
    const { guardianId } = await seedFamily(schoolId);
    await withTenant(schoolId, (trx) =>
      postEntry(trx, { schoolId, guardianId, kind: "cancel_credit", amountCents: 1200, sourceType: "checkout", sourceId: uuidv7() }),
    );
    const cookies = await guardianCookie(schoolId, guardianId);
    const wallet = await buildApp().inject({ method: "GET", url: "/api/v1/wallet", cookies });
    expect(wallet.json()).toMatchObject({ balanceCents: 1200, entries: [{ kind: "cancel_credit", amountCents: 1200 }] });
    const me = await buildApp().inject({ method: "GET", url: "/api/v1/me", cookies });
    expect(me.json().walletBalanceCents).toBe(1200);
  });

  it("lets an admin adjust a balance idempotently, with audit", async () => {
    const schoolId = await createSchool();
    const { guardianId } = await seedFamily(schoolId);
    const { cookies, staffUserId } = await staffCookie(schoolId, "admin");
    const k = uuidv7();
    const adjust = (payload: unknown, key = k) =>
      buildApp().inject({
        method: "POST",
        url: `/api/admin/v1/guardians/${guardianId}/wallet/adjustments`,
        cookies,
        headers: { "idempotency-key": key },
        payload,
      });
    expect((await adjust({ amountCents: 500, reason: "crédito de cortesia" })).json()).toEqual({ balanceCents: 500 });
    expect((await adjust({ amountCents: 500, reason: "crédito de cortesia" })).json()).toEqual({ balanceCents: 500 });
    const negative = await adjust({ amountCents: -600, reason: "correção" }, uuidv7());
    expect(negative.statusCode).toBe(409);
    expect(negative.json().error.code).toBe("insufficient_balance");

    const audit = await adminDb()
      .selectFrom("auditLog")
      .select(["actorId", "action", sql<string>`detail::text`.as("detail")])
      .where("schoolId", "=", schoolId)
      .where("action", "=", "wallet.adjust")
      .execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actorId).toBe(staffUserId);
    expect(JSON.parse(audit[0]!.detail)).toEqual({ guardian_id: guardianId, amount_cents: 500 });
  });

  it("restricts adjustments to admins and known guardians", async () => {
    const schoolId = await createSchool();
    const { guardianId } = await seedFamily(schoolId);
    const office = await staffCookie(schoolId, "secretaria");
    const admin = await staffCookie(schoolId, "admin");
    const call = (cookies: Record<string, string>, id: string) =>
      buildApp().inject({
        method: "POST",
        url: `/api/admin/v1/guardians/${id}/wallet/adjustments`,
        cookies,
        headers: { "idempotency-key": uuidv7() },
        payload: { amountCents: 100, reason: "x" },
      });
    expect((await call(office.cookies, guardianId)).statusCode).toBe(403);
    expect((await call(admin.cookies, uuidv7())).statusCode).toBe(404);
  });
});
```

Run: `pnpm --filter @app-lanche/api exec vitest run src/modules/wallet` → FAIL.

- [ ] **Step 3: Implementar**

`apps/api/src/modules/wallet/repo.ts`:

```ts
import { uuidv7 } from "uuidv7";
import type { Trx } from "../../db/index";

export async function ensureWallet(trx: Trx, schoolId: string, guardianId: string): Promise<void> {
  await trx
    .insertInto("wallets")
    .values({ id: uuidv7(), schoolId, guardianId })
    .onConflict((oc) => oc.columns(["schoolId", "guardianId"]).doNothing())
    .execute();
}

export async function lockWallet(trx: Trx, guardianId: string) {
  return trx
    .selectFrom("wallets")
    .select(["id", "balanceCents"])
    .where("guardianId", "=", guardianId)
    .forUpdate()
    .executeTakeFirstOrThrow();
}

export async function insertEntry(
  trx: Trx,
  entry: {
    schoolId: string;
    walletId: string;
    kind: string;
    amountCents: number;
    sourceType: string;
    sourceId: string;
    note: string | null;
  },
): Promise<boolean> {
  const row = await trx
    .insertInto("walletEntries")
    .values({ id: uuidv7(), ...entry })
    .onConflict((oc) => oc.columns(["schoolId", "sourceType", "sourceId", "kind"]).doNothing())
    .returning("id")
    .executeTakeFirst();
  return row !== undefined;
}

export async function setBalance(trx: Trx, walletId: string, balanceCents: number): Promise<void> {
  await trx.updateTable("wallets").set({ balanceCents }).where("id", "=", walletId).execute();
}

export async function readBalance(trx: Trx, guardianId: string): Promise<number> {
  const row = await trx.selectFrom("wallets").select("balanceCents").where("guardianId", "=", guardianId).executeTakeFirst();
  return row?.balanceCents ?? 0;
}

export async function listEntries(trx: Trx, guardianId: string, limit: number) {
  return trx
    .selectFrom("walletEntries")
    .innerJoin("wallets", "wallets.id", "walletEntries.walletId")
    .select(["walletEntries.id", "walletEntries.kind", "walletEntries.amountCents", "walletEntries.createdAt"])
    .where("wallets.guardianId", "=", guardianId)
    .orderBy("walletEntries.createdAt", "desc")
    .orderBy("walletEntries.id", "desc")
    .limit(limit)
    .execute();
}

export async function guardianExists(trx: Trx, guardianId: string): Promise<boolean> {
  const row = await trx.selectFrom("guardians").select("id").where("id", "=", guardianId).executeTakeFirst();
  return row !== undefined;
}
```

`apps/api/src/modules/wallet/service.ts`:

```ts
import type { WalletAdjustmentRequest, WalletAdjustmentResponse, WalletEntryKind as Kind, WalletResponse } from "@app-lanche/contracts";
import { uuidv7 } from "uuidv7";
import { withTenant, type Trx } from "../../db/index";
import { audit } from "../../platform/audit";
import { DomainError } from "../../platform/errors";
import { idempotent, requestHash } from "../../platform/idempotency";
import type { SessionClaims } from "../../platform/session";
import * as repo from "./repo";

export type WalletEntryKind = Kind;
export type WalletSourceType = "checkout" | "payment" | "adjustment";

/** Cria a carteira se faltar e trava a linha (CLAUDE.md regra 9). */
export async function lockBalance(
  trx: Trx,
  schoolId: string,
  guardianId: string,
): Promise<{ walletId: string; balanceCents: number }> {
  await repo.ensureWallet(trx, schoolId, guardianId);
  const wallet = await repo.lockWallet(trx, guardianId);
  return { walletId: wallet.id, balanceCents: wallet.balanceCents };
}

/**
 * Lança uma entrada no ledger. A unicidade (origem, tipo) torna a chamada idempotente: se a entrada já existe,
 * nada muda e `posted` é false.
 */
export async function postEntry(
  trx: Trx,
  entry: {
    schoolId: string;
    guardianId: string;
    kind: WalletEntryKind;
    amountCents: number;
    sourceType: WalletSourceType;
    sourceId: string;
    note?: string;
  },
): Promise<{ posted: boolean; balanceCents: number }> {
  if (!Number.isSafeInteger(entry.amountCents) || entry.amountCents === 0) throw new Error("invalid wallet amount");
  const wallet = await lockBalance(trx, entry.schoolId, entry.guardianId);
  const posted = await repo.insertEntry(trx, {
    schoolId: entry.schoolId,
    walletId: wallet.walletId,
    kind: entry.kind,
    amountCents: entry.amountCents,
    sourceType: entry.sourceType,
    sourceId: entry.sourceId,
    note: entry.note ?? null,
  });
  // Repetição: a entrada já existe e o saldo já a contém.
  if (!posted) return { posted: false, balanceCents: wallet.balanceCents };
  const balanceCents = wallet.balanceCents + entry.amountCents;
  // Lançar aqui desfaz a transação inteira, inclusive a entrada recém-inserida.
  if (balanceCents < 0) throw new DomainError("insufficient_balance");
  await repo.setBalance(trx, wallet.walletId, balanceCents);
  return { posted: true, balanceCents };
}

export async function balanceOf(trx: Trx, guardianId: string): Promise<number> {
  return repo.readBalance(trx, guardianId);
}

export async function getWallet(session: SessionClaims): Promise<WalletResponse> {
  return withTenant(session.schoolId, async (trx) => ({
    balanceCents: await repo.readBalance(trx, session.sub),
    entries: (await repo.listEntries(trx, session.sub, 50)).map((e) => ({
      id: e.id,
      kind: e.kind as WalletEntryKind,
      amountCents: e.amountCents,
      createdAt: e.createdAt.toISOString(),
    })),
  }));
}

export async function adjustBalance(
  session: SessionClaims,
  key: string,
  guardianId: string,
  body: WalletAdjustmentRequest,
): Promise<WalletAdjustmentResponse> {
  const schoolId = session.schoolId;
  const hash = requestHash({ route: `POST /api/admin/v1/guardians/${guardianId}/wallet/adjustments`, actorId: session.sub, body });
  return withTenant(schoolId, async (trx) => {
    const { response } = await idempotent(trx, { schoolId, key, requestHash: hash }, async () => {
      if (!(await repo.guardianExists(trx, guardianId))) throw new DomainError("not_found");
      const { balanceCents } = await postEntry(trx, {
        schoolId,
        guardianId,
        kind: "manual_adjustment",
        amountCents: body.amountCents,
        sourceType: "adjustment",
        sourceId: uuidv7(),
        note: body.reason,
      });
      await audit(trx, {
        schoolId,
        actorKind: "staff",
        actorId: session.sub,
        action: "wallet.adjust",
        detail: { guardian_id: guardianId, amount_cents: body.amountCents },
      });
      return { balanceCents };
    });
    return response;
  });
}
```

`apps/api/src/modules/wallet/routes.ts`:

```ts
import { Uuid, WalletAdjustmentRequest } from "@app-lanche/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { idempotencyKeyFrom } from "../../platform/idempotency";
import * as service from "./service";

const GuardianParams = z.object({ guardianId: Uuid });

export async function walletRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/wallet", { config: { auth: { kind: "guardian", scope: "order" } } }, async (req) =>
    service.getWallet(req.session!),
  );

  app.post(
    "/api/admin/v1/guardians/:guardianId/wallet/adjustments",
    { config: { auth: { kind: "staff", roles: ["admin"] } } },
    async (req) =>
      service.adjustBalance(
        req.session!,
        idempotencyKeyFrom(req),
        GuardianParams.parse(req.params).guardianId,
        WalletAdjustmentRequest.parse(req.body),
      ),
  );
}
```

Registre em `app.ts`. Em `auth/service.ts`, `getMe` passa a devolver `{ ...found, walletBalanceCents: await wallet.balanceOf(trx, session.sub) }` dentro do mesmo `withTenant` (importe `* as wallet from "../wallet/service"`). Atualize os testes que comparam `/me` por igualdade e as respostas simuladas de `/api/v1/me` nos testes web.

- [ ] **Step 4: Rodar e ver passar; commit**

Run: `pnpm --filter @app-lanche/api exec vitest run src/modules/wallet src/modules/auth` → PASS. Depois `pnpm typecheck && pnpm lint && pnpm test`.

```bash
git add packages/contracts/src apps/api/src apps/web/src
git commit -m "feat(api): add append-only wallet ledger, guardian wallet and admin adjustments"
```

---

### Task 5: Provedor de pagamento (`PaymentProvider`, provedor `fake`, segredos)

**Files:**
- Create: `apps/api/src/modules/payments/provider.ts`, `apps/api/src/modules/payments/fakeProvider.ts`, `apps/api/src/modules/payments/registry.ts`, `apps/api/src/modules/payments/provider.test.ts`
- Create: `apps/api/src/platform/secrets.ts`, `apps/api/src/platform/secrets.test.ts`
- Modify: `apps/api/src/platform/config.ts` (+ `config.test.ts`), `apps/api/src/platform/hmac.ts` (exportar `safeEqual`), `apps/api/test/setupEnv.ts`, `docs/deploy.md`

**Interfaces:**
- Produces (`provider.ts`):

```ts
export interface ChargeRequest {
  paymentId: string;          // chave de idempotência no gateway
  schoolId: string;
  amountCents: number;
  expiresAt: Date;
  description: string;        // sem dado pessoal
  accountRef: string | null;  // schools.payment_account_ref (subconta)
  platformFeeBps: number;     // split da plataforma
}
export type ChargeStatus = "pending" | "paid" | "expired";
export interface Charge {
  chargeId: string;
  status: ChargeStatus;
  amountCents: number;
  paidAt: Date | null;
  pixCopyPaste: string | null;
  pixQrPngBase64: string | null;
}
export type WebhookEvent =
  | { eventId: string; kind: "charge_paid"; chargeId: string; amountCents: number; paidAt: Date }
  | { eventId: string; kind: "ignored"; chargeId: string | null };
export interface WebhookInput {
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | undefined>;
  rawBody: string;
  secret: string;            // segredo de webhook da escola
  accountRef: string | null; // schools.payment_account_ref, para o provedor consultar o gateway
}
export interface PaymentProvider {
  readonly name: string;
  createCharge(req: ChargeRequest): Promise<Charge>;
  getCharge(chargeId: string, accountRef: string | null): Promise<Charge>;
  /**
   * Valida a autenticidade com o segredo da escola (lança DomainError("invalid_signature")) e devolve os eventos
   * da notificação (pode ser vários, ou nenhum). Roda fora de transação: um provedor que não assina o corpo
   * (Efí) consulta a cobrança no gateway aqui e só devolve `charge_paid` com valor e horário vindos do gateway.
   */
  parseWebhook(input: WebhookInput): Promise<WebhookEvent[]>;
}
```

- Produces (`registry.ts`): `getProvider(name: string): PaymentProvider` (lança `DomainError("not_found")` para nome desconhecido ou `fake` desabilitado); `defaultProviderName(): string`.
- Produces (`fakeProvider.ts`): `fakeProvider: PaymentProvider` (`name: "fake"`), e para testes `fakeMarkPaid(chargeId: string, paidAt: Date): void`, `fakeFailNextCreate(times?: number): void`, `fakeReset(): void`. Charge id = `fake_<paymentId>`; `pixCopyPaste = "00020101FAKE" + chargeId`; `pixQrPngBase64 = null`. Webhook: header `x-fake-token` igual ao segredo (comparação em tempo constante); corpo `{ id, event, charge_id, amount_cents?, paid_at? }` produz exatamente um evento; `event === "charge.paid"` exige `amount_cents` e `paid_at`, os demais viram `ignored`; corpo inválido → `DomainError("validation_failed")`.
- Produces (`platform/secrets.ts`): `getSecret(ref: string): string` — `ref` deve casar `/^[A-Z][A-Z0-9_]{2,100}$/`; lê `process.env[ref]`; ausente ou com menos de 32 caracteres lança `Error` com o NOME do ref (nunca o valor).
- Config: `PAYMENT_PROVIDER` (`z.enum(["fake"])`, padrão `"fake"`) e `ENABLE_FAKE_PAYMENTS` (`"true" | "false"`, padrão `"false"`). `config()` falha com `invalid environment: PAYMENT_PROVIDER` se o provedor é `fake` e `ENABLE_FAKE_PAYMENTS` não é `"true"`. `Config` ganha `paymentProvider: "fake"` e `fakePaymentsEnabled: boolean`.
- `setupEnv.ts`: `ENABLE_FAKE_PAYMENTS = "true"` e `PAYMENT_WEBHOOK_SECRET_TEST = "test-payment-webhook-secret-with-32-chars"`.

- [ ] **Step 1: Testes que falham**

`apps/api/src/modules/payments/provider.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { fakeFailNextCreate, fakeMarkPaid, fakeProvider, fakeReset } from "./fakeProvider";
import { defaultProviderName, getProvider } from "./registry";

const SECRET = "s".repeat(40);
const req = (paymentId = "0193a3b0-0000-7000-8000-000000000001") => ({
  paymentId,
  schoolId: "0193a3b0-0000-7000-8000-000000000002",
  amountCents: 1350,
  expiresAt: new Date("2030-03-04T10:30:00Z"),
  description: "Lanche 2030-03-04",
  accountRef: null,
  platformFeeBps: 0,
});

afterEach(() => fakeReset());

describe("fake provider", () => {
  it("creates one charge per payment id and reports it", async () => {
    const a = await fakeProvider.createCharge(req());
    const b = await fakeProvider.createCharge(req());
    expect(b).toEqual(a);
    expect(a).toMatchObject({ status: "pending", amountCents: 1350, paidAt: null });
    expect(a.pixCopyPaste).toContain(a.chargeId);
    fakeMarkPaid(a.chargeId, new Date("2030-03-04T10:00:00Z"));
    expect(await fakeProvider.getCharge(a.chargeId, null)).toMatchObject({ status: "paid", paidAt: new Date("2030-03-04T10:00:00Z") });
  });

  it("can simulate an unavailable gateway", async () => {
    fakeFailNextCreate();
    await expect(fakeProvider.createCharge(req())).rejects.toThrow();
    await expect(fakeProvider.createCharge(req())).resolves.toMatchObject({ status: "pending" });
  });

  const hook = (rawBody: string, headers: Record<string, string> = { "x-fake-token": SECRET }) =>
    fakeProvider.parseWebhook({ headers, query: {}, rawBody, secret: SECRET, accountRef: null });

  it("parses a paid webhook with the right token", async () => {
    const rawBody = JSON.stringify({ id: "evt-1", event: "charge.paid", charge_id: "fake_x", amount_cents: 1350, paid_at: "2030-03-04T10:00:00Z" });
    expect(await hook(rawBody)).toEqual([
      { eventId: "evt-1", kind: "charge_paid", chargeId: "fake_x", amountCents: 1350, paidAt: new Date("2030-03-04T10:00:00Z") },
    ]);
  });

  it("ignores other events and rejects a wrong token or a bad body", async () => {
    const other = JSON.stringify({ id: "evt-2", event: "charge.created", charge_id: "fake_x" });
    expect(await hook(other)).toEqual([{ eventId: "evt-2", kind: "ignored", chargeId: "fake_x" }]);
    await expect(hook(other, { "x-fake-token": "nope" })).rejects.toMatchObject({ code: "invalid_signature" });
    await expect(hook(other, {})).rejects.toMatchObject({ code: "invalid_signature" });
    const bad = JSON.stringify({ id: "evt-3", event: "charge.paid", charge_id: "fake_x" });
    await expect(hook(bad)).rejects.toMatchObject({ code: "validation_failed" });
  });
});

describe("provider registry", () => {
  it("returns the fake provider when enabled", () => {
    expect(defaultProviderName()).toBe("fake");
    expect(getProvider("fake")).toBe(fakeProvider);
    expect(() => getProvider("asaas")).toThrow(expect.objectContaining({ code: "not_found" }));
  });
});
```

`apps/api/src/platform/secrets.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { getSecret } from "./secrets";

describe("getSecret", () => {
  it("reads a secret mapped into the environment", () => {
    expect(getSecret("PAYMENT_WEBHOOK_SECRET_TEST")).toBe(process.env.PAYMENT_WEBHOOK_SECRET_TEST);
  });
  it("rejects malformed references, missing and short secrets without echoing values", () => {
    expect(() => getSecret("path/../etc")).toThrow(/invalid secret reference/);
    expect(() => getSecret("MISSING_SECRET_REF")).toThrow(/MISSING_SECRET_REF/);
    process.env.SHORT_SECRET_REF = "short-value";
    expect(() => getSecret("SHORT_SECRET_REF")).toThrow(/SHORT_SECRET_REF/);
    expect(() => getSecret("SHORT_SECRET_REF")).not.toThrow(/short-value/);
  });
});
```

Em `config.test.ts`, acrescente: com `PAYMENT_PROVIDER` ausente e `ENABLE_FAKE_PAYMENTS` diferente de `"true"`, `config()` lança `/PAYMENT_PROVIDER/`; com `ENABLE_FAKE_PAYMENTS=true`, `config().fakePaymentsEnabled === true` e `paymentProvider === "fake"`. Siga o padrão de `resetConfigForTests()` e restauração de `process.env` do arquivo.

Run: `pnpm --filter @app-lanche/api exec vitest run src/modules/payments src/platform/secrets.test.ts src/platform/config.test.ts` → FAIL.

- [ ] **Step 2: Implementar**

Em `hmac.ts`, exporte `safeEqual` (só acrescente `export`).

`apps/api/src/platform/secrets.ts`:

```ts
const REF_FORMAT = /^[A-Z][A-Z0-9_]{2,100}$/;

/**
 * Segredo por escola. `ref` é o nome de uma variável de ambiente que o Cloud Run preenche a partir do
 * Secret Manager (`--set-secrets`). As mensagens de erro citam o nome, nunca o valor.
 */
export function getSecret(ref: string): string {
  if (!REF_FORMAT.test(ref)) throw new Error("invalid secret reference");
  const value = process.env[ref];
  if (!value || value.length < 32) throw new Error(`secret ${ref} is missing or shorter than 32 characters`);
  return value;
}
```

`config.ts`: acrescente ao `Env`

```ts
  PAYMENT_PROVIDER: z.enum(["fake"]).default("fake"),
  ENABLE_FAKE_PAYMENTS: z.enum(["true", "false"]).default("false"),
```

e, depois do `safeParse` bem-sucedido, antes de montar `cached`:

```ts
  if (env.PAYMENT_PROVIDER === "fake" && env.ENABLE_FAKE_PAYMENTS !== "true") {
    throw new Error("invalid environment: PAYMENT_PROVIDER");
  }
```

com `paymentProvider: env.PAYMENT_PROVIDER` e `fakePaymentsEnabled: env.ENABLE_FAKE_PAYMENTS === "true"` no objeto e na interface `Config`.

`apps/api/src/modules/payments/provider.ts`: exatamente o bloco de interfaces acima.

`apps/api/src/modules/payments/fakeProvider.ts`:

```ts
import { z } from "zod";
import { DomainError } from "../../platform/errors";
import { safeEqual } from "../../platform/hmac";
import type { Charge, ChargeRequest, PaymentProvider, WebhookEvent, WebhookInput } from "./provider";

type FakeCharge = { chargeId: string; amountCents: number; status: Charge["status"]; paidAt: Date | null };

const charges = new Map<string, FakeCharge>();
let failures = 0;

const FakeWebhook = z.object({
  id: z.string().min(1).max(100),
  event: z.string().min(1).max(50),
  charge_id: z.string().min(1).max(100).nullable(),
  amount_cents: z.number().int().positive().optional(),
  paid_at: z.string().datetime({ offset: true }).optional(),
});

function view(c: FakeCharge): Charge {
  return { ...c, pixCopyPaste: `00020101FAKE${c.chargeId}`, pixQrPngBase64: null };
}

function header(headers: Record<string, string | string[] | undefined>, name: string): string {
  const v = headers[name];
  return typeof v === "string" ? v : "";
}

/** Provedor de desenvolvimento e testes. Nunca habilitado em produção (ENABLE_FAKE_PAYMENTS). */
export const fakeProvider: PaymentProvider = {
  name: "fake",

  async createCharge(req: ChargeRequest): Promise<Charge> {
    if (failures > 0) {
      failures -= 1;
      throw new Error("fake gateway unavailable");
    }
    const chargeId = `fake_${req.paymentId}`;
    const existing = charges.get(chargeId);
    if (existing) return view(existing);
    const created: FakeCharge = { chargeId, amountCents: req.amountCents, status: "pending", paidAt: null };
    charges.set(chargeId, created);
    return view(created);
  },

  async getCharge(chargeId: string): Promise<Charge> {
    const c = charges.get(chargeId);
    if (!c) throw new Error("unknown fake charge");
    return view(c);
  },

  async parseWebhook({ headers, rawBody, secret }: WebhookInput): Promise<WebhookEvent[]> {
    if (!safeEqual(header(headers, "x-fake-token"), secret)) throw new DomainError("invalid_signature");
    let parsed: z.infer<typeof FakeWebhook>;
    try {
      parsed = FakeWebhook.parse(JSON.parse(rawBody));
    } catch {
      throw new DomainError("validation_failed");
    }
    if (parsed.event !== "charge.paid") return [{ eventId: parsed.id, kind: "ignored", chargeId: parsed.charge_id }];
    if (!parsed.charge_id || parsed.amount_cents === undefined || parsed.paid_at === undefined) {
      throw new DomainError("validation_failed");
    }
    return [
      {
        eventId: parsed.id,
        kind: "charge_paid",
        chargeId: parsed.charge_id,
        amountCents: parsed.amount_cents,
        paidAt: new Date(parsed.paid_at),
      },
    ];
  },
};

export function fakeMarkPaid(chargeId: string, paidAt: Date): void {
  const c = charges.get(chargeId);
  if (!c) throw new Error("unknown fake charge");
  c.status = "paid";
  c.paidAt = paidAt;
}

export function fakeFailNextCreate(times = 1): void {
  failures = times;
}

export function fakeReset(): void {
  charges.clear();
  failures = 0;
}
```

`apps/api/src/modules/payments/registry.ts`:

```ts
import { config } from "../../platform/config";
import { DomainError } from "../../platform/errors";
import { fakeProvider } from "./fakeProvider";
import type { PaymentProvider } from "./provider";

export function getProvider(name: string): PaymentProvider {
  if (name === "fake" && config().fakePaymentsEnabled) return fakeProvider;
  throw new DomainError("not_found");
}

export function defaultProviderName(): string {
  return config().paymentProvider;
}
```

Em `docs/deploy.md`, acrescente uma seção "Pagamentos" (em português):
- `PAYMENT_PROVIDER` hoje só aceita `fake`; o adaptador do gateway real (Asaas) depende de decisão pendente sobre CPF do pagador. Com `fake`, a API só sobe se `ENABLE_FAKE_PAYMENTS=true` — use apenas em homologação.
- Cada escola tem `schools.payment_webhook_secret_ref` com o NOME de uma variável de ambiente (ex.: `PAYMENT_WEBHOOK_SECRET_ESCOLA_PILOTO`), mapeada de um segredo do Secret Manager com `--set-secrets` (mínimo 32 caracteres). Incluir escola nova exige novo deploy.
- URL de webhook a configurar no gateway: `https://<url do Cloud Run>/webhooks/payments/<provedor>/<school_id>` (direto no Cloud Run, sem passar pelo Hosting).

- [ ] **Step 3: Rodar e ver passar; commit**

Run: os testes do Step 1 → PASS. Depois `pnpm typecheck && pnpm lint && pnpm test`.

```bash
git add apps/api/src/modules/payments apps/api/src/platform apps/api/test/setupEnv.ts docs/deploy.md
git commit -m "feat(api): add PaymentProvider interface, fake provider and per-school secrets"
```

---
### Task 6: Checkout (`orders`) — criação, cobrança fora da transação e consulta

**Files:**
- Create: `packages/contracts/src/checkout.ts`, `packages/contracts/src/events.test.ts`; Modify: `packages/contracts/src/events.ts`, `packages/contracts/src/index.ts`, `packages/contracts/src/errors.ts`
- Create: `apps/api/src/modules/orders/{repo,service,routes}.ts`, `apps/api/src/modules/orders/checkout.test.ts`
- Create: `apps/api/src/modules/payments/{repo,service}.ts`
- Modify: `apps/api/src/app.ts`, `apps/api/src/platform/errors.ts`

**Interfaces:**
- Consumes: `catalog.lockServiceDayByDate`, `catalog.serviceDayPrices` (Task 3); `wallet.lockBalance`, `wallet.postEntry` (Task 4); `getProvider`, `defaultProviderName` (Task 5); `idempotent`, `requestHash`, `idempotencyKeyFrom` (Task 2); `enqueueEvent`.
- Produces (contracts): `CheckoutStatus`, `OrderStatus`, `PaymentStatus`, `CreateCheckoutRequest`, `CheckoutView`, `CheckoutListResponse`, `CheckoutListQuery`; eventos `PaymentConfirmedEvent` e `PaymentLateCreditedEvent` na união `OutboxEvent`.
- Produces (`modules/orders/service.ts`):
  - `createCheckout(session: SessionClaims, key: string, body: CreateCheckoutRequest, log: FastifyBaseLogger): Promise<CheckoutView>`
  - `getCheckout(session: SessionClaims, checkoutId: string): Promise<CheckoutView>` (404 se não for do responsável)
  - `listCheckouts(session: SessionClaims, serviceDate: string): Promise<CheckoutListResponse>`
  - `confirmCheckout(trx: Trx, schoolId: string, checkoutId: string): Promise<boolean>` — `pending_payment → paid`, pedidos `pending → confirmed`, evento `payment.confirmed`; `false` se o checkout não estava `pending_payment`.
- Produces (`modules/payments/service.ts`):
  - `createPendingPayment(trx: Trx, input: { schoolId: string; checkoutId: string; amountCents: number; expiresAt: Date }): Promise<string>`
  - `ensureCharge(schoolId: string, checkoutId: string, log: FastifyBaseLogger): Promise<void>` — fora de transação; se a cobrança pendente ainda não tem `provider_charge_id`, chama `createCharge` (chave = `payment.id`) e grava id e Pix. Falha do gateway: log `warn` `{ event: "charge_create_failed", payment_id }` e retorna sem lançar.
  - `paymentViews(trx: Trx, checkoutIds: string[]): Promise<Map<string, CheckoutView["payment"]>>`
- Rotas (guardian, scope `order`): `POST /api/v1/checkouts` (exige `Idempotency-Key`), `GET /api/v1/checkouts/:id`, `GET /api/v1/checkouts?serviceDate=YYYY-MM-DD`.
- Códigos de erro novos: `order_already_exists` (409), `invalid_order` (422).

Regras (spec 5.3):
1. Numa transação: trava `service_days` (`FOR SHARE`); recusa `cutoff_passed` se `status <> 'open'` ou `now() > cutoff_at`; valida que cada aluno é ativo e vinculado ao responsável e que cada item está no cardápio do dia (sem aluno nem item repetido) — senão `invalid_order`; calcula o total com o preço do dia; cria checkout, pedidos e itens; trava a carteira e aplica o saldo (`checkout_hold` negativo); se o saldo cobre tudo, `confirmCheckout`; senão cria `payments` pendente pelo restante com `expires_at = cutoff_at` e o provedor padrão.
2. Violação de `orders_one_active_per_student` → `order_already_exists` (a transação inteira volta, inclusive a chave de idempotência).
3. Depois do commit, `ensureCharge`. A resposta é sempre o `CheckoutView` atual (a parte idempotente grava só `{ checkoutId }`), então repetir o POST com a mesma chave também tenta de novo criar a cobrança que falhou.
4. Evento `payment.confirmed` (snake_case): `{ guardian_id, phone, first_name, checkout_id, service_date, students: [primeiros nomes], total_cents }`.

- [ ] **Step 1: Contratos e fixture do contrato de eventos**

`packages/contracts/src/checkout.ts`:

```ts
import { z } from "zod";
import { Cents, IsoDate, IsoDateTime, Uuid } from "./common";

export const CheckoutStatus = z.enum(["pending_payment", "paid", "expired", "late_credited", "cancelled"]);
export type CheckoutStatus = z.infer<typeof CheckoutStatus>;
export const OrderStatus = z.enum(["pending", "confirmed", "delivered", "expired", "expired_late", "cancelled"]);
export type OrderStatus = z.infer<typeof OrderStatus>;
export const PaymentStatus = z.enum(["pending", "paid", "expired", "refunded"]);
export type PaymentStatus = z.infer<typeof PaymentStatus>;

export const CreateCheckoutRequest = z.object({
  serviceDate: IsoDate,
  orders: z
    .array(
      z.object({
        studentId: Uuid,
        items: z.array(z.object({ menuItemId: Uuid, qty: z.number().int().min(1).max(10) })).min(1).max(10),
      }),
    )
    .min(1)
    .max(10),
});
export type CreateCheckoutRequest = z.infer<typeof CreateCheckoutRequest>;

export const PaymentView = z.object({
  status: PaymentStatus,
  amountCents: Cents,
  pixCopyPaste: z.string().nullable(),
  pixQrPngBase64: z.string().nullable(),
  expiresAt: IsoDateTime,
});
export type PaymentView = z.infer<typeof PaymentView>;

export const CheckoutView = z.object({
  id: Uuid,
  serviceDate: IsoDate,
  cutoffAt: IsoDateTime,
  status: CheckoutStatus,
  totalCents: Cents,
  walletAppliedCents: z.number().int().nonnegative(),
  amountDueCents: z.number().int().nonnegative(),
  orders: z.array(
    z.object({
      id: Uuid,
      studentId: Uuid,
      studentFirstName: z.string(),
      status: OrderStatus,
      items: z.array(z.object({ menuItemId: Uuid, name: z.string(), qty: z.number().int().positive(), unitPriceCents: Cents })),
    }),
  ),
  payment: PaymentView.nullable(),
});
export type CheckoutView = z.infer<typeof CheckoutView>;

export const CheckoutListResponse = z.object({ checkouts: z.array(CheckoutView) });
export type CheckoutListResponse = z.infer<typeof CheckoutListResponse>;

export const CheckoutListQuery = z.object({ serviceDate: IsoDate });
```

Em `events.ts`, acrescente e inclua na união:

```ts
export const PaymentConfirmedEvent = z.object({
  type: z.literal("payment.confirmed"),
  data: z.object({
    guardian_id: z.string().uuid(),
    phone: z.string(),
    first_name: z.string(),
    checkout_id: z.string().uuid(),
    service_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    students: z.array(z.string()).min(1),
    total_cents: z.number().int().positive(),
  }),
});

export const PaymentLateCreditedEvent = z.object({
  type: z.literal("payment.late_credited"),
  data: z.object({
    guardian_id: z.string().uuid(),
    phone: z.string(),
    first_name: z.string(),
    amount_cents: z.number().int().positive(),
    wallet_balance_cents: z.number().int().nonnegative(),
  }),
});

export const OutboxEvent = z.discriminatedUnion("type", [OtpRequestedEvent, PaymentConfirmedEvent, PaymentLateCreditedEvent]);
```

`packages/contracts/src/events.test.ts` (fixture da spec 6.3; os ids `0193…` da spec trocados por UUIDs válidos):

```ts
import { describe, expect, it } from "vitest";
import { OutboxEnvelope, OutboxEvent } from "./events";

describe("outbox event contracts", () => {
  it("accepts the payment.late_credited example from spec 6.3", () => {
    const example = {
      id: "0193a3b0-0000-7000-8000-000000000001",
      type: "payment.late_credited",
      school_id: "0193a3b0-0000-7000-8000-000000000002",
      occurred_at: "2026-11-17T07:32:10-03:00",
      data: {
        guardian_id: "0193a3b0-0000-7000-8000-000000000003",
        phone: "+5511999990000",
        first_name: "Ana",
        amount_cents: 1800,
        wallet_balance_cents: 1800,
      },
    };
    expect(OutboxEnvelope.parse(example)).toEqual(example);
    expect(OutboxEvent.parse({ type: example.type, data: example.data })).toEqual({ type: example.type, data: example.data });
  });

  it("rejects a payment.confirmed event without students", () => {
    const result = OutboxEvent.safeParse({
      type: "payment.confirmed",
      data: {
        guardian_id: "0193a3b0-0000-7000-8000-000000000003",
        phone: "+5511999990000",
        first_name: "Ana",
        checkout_id: "0193a3b0-0000-7000-8000-000000000004",
        service_date: "2026-11-17",
        students: [],
        total_cents: 900,
      },
    });
    expect(result.success).toBe(false);
  });
});
```

Acrescente `order_already_exists` (409) e `invalid_order` (422).

- [ ] **Step 2: Testes de API que falham**

`apps/api/src/modules/orders/checkout.test.ts`:

```ts
import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { afterEach, describe, expect, it } from "vitest";
import { adminDb, createSchool, guardianCookie, seedFamily, seedServiceDay, walletLedgerMatches } from "../../../test/helpers";
import { buildApp } from "../../app";
import { withTenant } from "../../db/index";
import { fakeFailNextCreate, fakeReset } from "../payments/fakeProvider";
import { postEntry } from "../wallet/service";

afterEach(() => fakeReset());

async function setup(opts: { walletCents?: number; cutoffInMinutes?: number } = {}) {
  const schoolId = await createSchool();
  const family = await seedFamily(schoolId, ["Léo", "Bia"]);
  const day = await seedServiceDay(schoolId, { cutoffInMinutes: opts.cutoffInMinutes ?? 60 });
  if (opts.walletCents) {
    await withTenant(schoolId, (trx) =>
      postEntry(trx, {
        schoolId,
        guardianId: family.guardianId,
        kind: "cancel_credit",
        amountCents: opts.walletCents!,
        sourceType: "checkout",
        sourceId: uuidv7(),
      }),
    );
  }
  const cookies = await guardianCookie(schoolId, family.guardianId);
  const [misto, suco] = day.items;
  return { schoolId, family, day, cookies, misto: misto!, suco: suco! };
}

function post(cookies: Record<string, string>, payload: unknown, key: string = uuidv7()) {
  return buildApp().inject({ method: "POST", url: "/api/v1/checkouts", cookies, headers: { "idempotency-key": key }, payload });
}

const oneOrder = (s: Awaited<ReturnType<typeof setup>>, studentIndex = 0) => ({
  serviceDate: s.day.serviceDate,
  orders: [
    {
      studentId: s.family.studentIds[studentIndex]!,
      items: [
        { menuItemId: s.misto.id, qty: 1 },
        { menuItemId: s.suco.id, qty: 1 },
      ],
    },
  ],
});

async function outbox(schoolId: string, type: string) {
  const rows = await adminDb()
    .selectFrom("outboxEvents")
    .select(sql<string>`data::text`.as("data"))
    .where("schoolId", "=", schoolId)
    .where("type", "=", type)
    .execute();
  return rows.map((r) => JSON.parse(r.data));
}

describe("POST /api/v1/checkouts", () => {
  it("pays two children entirely from the wallet in one checkout", async () => {
    const s = await setup({ walletCents: 5000 });
    const res = await post(s.cookies, {
      serviceDate: s.day.serviceDate,
      orders: [
        { studentId: s.family.studentIds[0]!, items: [{ menuItemId: s.misto.id, qty: 2 }] },
        { studentId: s.family.studentIds[1]!, items: [{ menuItemId: s.suco.id, qty: 1 }] },
      ],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ status: "paid", totalCents: 2250, walletAppliedCents: 2250, amountDueCents: 0, payment: null });
    expect(body.orders.map((o: { status: string }) => o.status)).toEqual(["confirmed", "confirmed"]);
    const events = await outbox(s.schoolId, "payment.confirmed");
    expect(events).toEqual([
      expect.objectContaining({ checkout_id: body.id, students: ["Léo", "Bia"], total_cents: 2250, first_name: "Ana" }),
    ]);
    expect(await walletLedgerMatches(s.schoolId, s.family.guardianId)).toBe(true);
  });

  it("applies a partial balance and creates a Pix charge for the rest", async () => {
    const s = await setup({ walletCents: 500 });
    const res = await post(s.cookies, oneOrder(s));
    const body = res.json();
    expect(body).toMatchObject({ status: "pending_payment", totalCents: 1350, walletAppliedCents: 500, amountDueCents: 850 });
    expect(body.payment).toMatchObject({ status: "pending", amountCents: 850, expiresAt: body.cutoffAt });
    expect(body.payment.pixCopyPaste).toMatch(/^00020101FAKEfake_/);
    expect(body.orders[0].status).toBe("pending");
    const wallet = await adminDb().selectFrom("wallets").select("balanceCents").where("guardianId", "=", s.family.guardianId).executeTakeFirstOrThrow();
    expect(wallet.balanceCents).toBe(0);
    expect(await walletLedgerMatches(s.schoolId, s.family.guardianId)).toBe(true);
  });

  it("refuses after the cutoff and on a closed day", async () => {
    const late = await setup({ cutoffInMinutes: -1 });
    const res = await post(late.cookies, oneOrder(late));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("cutoff_passed");

    const closed = await setup();
    await sql`UPDATE service_days SET status = 'closed', closed_at = now() WHERE id = ${closed.day.serviceDayId}`.execute(adminDb());
    expect((await post(closed.cookies, oneOrder(closed))).json().error.code).toBe("cutoff_passed");
  });

  it("rejects another guardian's student, items off the menu and repeated students, writing nothing", async () => {
    const s = await setup();
    const stranger = await seedFamily(s.schoolId, ["Caio"]);
    const bad = [
      { serviceDate: s.day.serviceDate, orders: [{ studentId: stranger.studentIds[0]!, items: [{ menuItemId: s.misto.id, qty: 1 }] }] },
      { serviceDate: s.day.serviceDate, orders: [{ studentId: s.family.studentIds[0]!, items: [{ menuItemId: uuidv7(), qty: 1 }] }] },
      {
        serviceDate: s.day.serviceDate,
        orders: [
          { studentId: s.family.studentIds[0]!, items: [{ menuItemId: s.misto.id, qty: 1 }] },
          { studentId: s.family.studentIds[0]!, items: [{ menuItemId: s.suco.id, qty: 1 }] },
        ],
      },
    ];
    for (const payload of bad) {
      const res = await post(s.cookies, payload);
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("invalid_order");
    }
    const checkouts = await adminDb().selectFrom("checkouts").select("id").where("guardianId", "=", s.family.guardianId).execute();
    expect(checkouts).toEqual([]);
    const missingDay = await post(s.cookies, { ...oneOrder(s), serviceDate: "2031-01-01" });
    expect(missingDay.statusCode).toBe(404);
  });

  it("allows one active order per student, also across guardians", async () => {
    const s = await setup();
    expect((await post(s.cookies, oneOrder(s))).statusCode).toBe(200);
    const again = await post(s.cookies, oneOrder(s));
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("order_already_exists");

    const otherGuardian = await seedFamily(s.schoolId, []);
    await adminDb()
      .insertInto("guardianStudents")
      .values({ schoolId: s.schoolId, guardianId: otherGuardian.guardianId, studentId: s.family.studentIds[0]! })
      .execute();
    const other = await post(await guardianCookie(s.schoolId, otherGuardian.guardianId), oneOrder(s));
    expect(other.json().error.code).toBe("order_already_exists");
  });

  it("handles a double tap with different keys: one checkout wins", async () => {
    const s = await setup();
    const [a, b] = await Promise.all([post(s.cookies, oneOrder(s)), post(s.cookies, oneOrder(s))]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
  });

  it("replays the same Idempotency-Key and rejects it for a different body", async () => {
    const s = await setup({ walletCents: 500 });
    const key = uuidv7();
    const first = await post(s.cookies, oneOrder(s), key);
    const second = await post(s.cookies, oneOrder(s), key);
    expect(second.json().id).toBe(first.json().id);
    const holds = await adminDb().selectFrom("walletEntries").select("id").where("schoolId", "=", s.schoolId).where("kind", "=", "checkout_hold").execute();
    expect(holds).toHaveLength(1);
    const reused = await post(s.cookies, oneOrder(s, 1), key);
    expect(reused.statusCode).toBe(422);
    expect(reused.json().error.code).toBe("idempotency_key_reused");
    const missing = await buildApp().inject({ method: "POST", url: "/api/v1/checkouts", cookies: s.cookies, payload: oneOrder(s) });
    expect(missing.json().error.code).toBe("idempotency_key_required");
  });

  it("keeps the checkout when the gateway is down and creates the charge on retry", async () => {
    const s = await setup();
    const key = uuidv7();
    fakeFailNextCreate();
    const first = await post(s.cookies, oneOrder(s), key);
    expect(first.statusCode).toBe(200);
    expect(first.json().payment).toMatchObject({ status: "pending", pixCopyPaste: null });
    const retry = await post(s.cookies, oneOrder(s), key);
    expect(retry.json().payment.pixCopyPaste).toMatch(/^00020101FAKE/);
  });
});

describe("GET /api/v1/checkouts", () => {
  it("returns a checkout only to its guardian and lists by date", async () => {
    const s = await setup();
    const created = (await post(s.cookies, oneOrder(s))).json();
    const got = await buildApp().inject({ method: "GET", url: `/api/v1/checkouts/${created.id}`, cookies: s.cookies });
    expect(got.json()).toEqual(created);

    const stranger = await seedFamily(s.schoolId, ["Caio"]);
    const denied = await buildApp().inject({
      method: "GET",
      url: `/api/v1/checkouts/${created.id}`,
      cookies: await guardianCookie(s.schoolId, stranger.guardianId),
    });
    expect(denied.statusCode).toBe(404);

    const list = await buildApp().inject({ method: "GET", url: `/api/v1/checkouts?serviceDate=${s.day.serviceDate}`, cookies: s.cookies });
    expect(list.json()).toEqual({ checkouts: [created] });
  });
});
```

Run: `pnpm --filter @app-lanche/api exec vitest run src/modules/orders` e `pnpm --filter @app-lanche/contracts test` → FAIL.

- [ ] **Step 3: Implementar `payments` (parte da cobrança)**

`apps/api/src/modules/payments/repo.ts`:

```ts
import { uuidv7 } from "uuidv7";
import type { Trx } from "../../db/index";
import type { Charge } from "./provider";

export async function insertPayment(
  trx: Trx,
  row: { schoolId: string; checkoutId: string; provider: string; amountCents: number; expiresAt: Date },
): Promise<string> {
  const id = uuidv7();
  await trx.insertInto("payments").values({ id, method: "pix", ...row }).execute();
  return id;
}

export async function unchargedPendingPayment(trx: Trx, checkoutId: string) {
  return trx
    .selectFrom("payments")
    .select(["id", "provider", "amountCents", "expiresAt"])
    .where("checkoutId", "=", checkoutId)
    .where("status", "=", "pending")
    .where("providerChargeId", "is", null)
    .executeTakeFirst();
}

export async function schoolPaymentConfig(trx: Trx) {
  return trx
    .selectFrom("schools")
    .select(["paymentAccountRef", "paymentWebhookSecretRef", "platformFeeBps", "kitchenPhone"])
    .executeTakeFirstOrThrow();
}

export async function attachCharge(trx: Trx, paymentId: string, charge: Charge): Promise<void> {
  await trx
    .updateTable("payments")
    .set({ providerChargeId: charge.chargeId, pixCopyPaste: charge.pixCopyPaste, pixQrPngBase64: charge.pixQrPngBase64 })
    .where("id", "=", paymentId)
    .where("providerChargeId", "is", null)
    .execute();
}

export async function paymentsForCheckouts(trx: Trx, checkoutIds: string[]) {
  if (checkoutIds.length === 0) return [];
  return trx
    .selectFrom("payments")
    .select(["checkoutId", "status", "amountCents", "pixCopyPaste", "pixQrPngBase64", "expiresAt"])
    .where("checkoutId", "in", checkoutIds)
    .execute();
}
```

`apps/api/src/modules/payments/service.ts` (esta task cria as três funções abaixo; Tasks 7, 8 e 10 acrescentam outras):

```ts
import type { PaymentStatus, PaymentView } from "@app-lanche/contracts";
import type { FastifyBaseLogger } from "fastify";
import { withTenant, type Trx } from "../../db/index";
import * as repo from "./repo";
import { defaultProviderName, getProvider } from "./registry";

export async function createPendingPayment(
  trx: Trx,
  input: { schoolId: string; checkoutId: string; amountCents: number; expiresAt: Date },
): Promise<string> {
  return repo.insertPayment(trx, { ...input, provider: defaultProviderName() });
}

/** Cria a cobrança no gateway fora de transação (CLAUDE.md regra 20). Idempotente pelo id do pagamento. */
export async function ensureCharge(schoolId: string, checkoutId: string, log: FastifyBaseLogger): Promise<void> {
  const pending = await withTenant(schoolId, async (trx) => {
    const payment = await repo.unchargedPendingPayment(trx, checkoutId);
    return payment && { payment, school: await repo.schoolPaymentConfig(trx) };
  });
  if (!pending) return;
  const { payment, school } = pending;
  let charge;
  try {
    charge = await getProvider(payment.provider).createCharge({
      paymentId: payment.id,
      schoolId,
      amountCents: payment.amountCents,
      expiresAt: payment.expiresAt,
      description: "Lanche escolar",
      accountRef: school.paymentAccountRef,
      platformFeeBps: school.platformFeeBps,
    });
  } catch {
    log.warn({ event: "charge_create_failed", payment_id: payment.id }, "charge creation failed");
    return;
  }
  await withTenant(schoolId, (trx) => repo.attachCharge(trx, payment.id, charge));
}

export async function paymentViews(trx: Trx, checkoutIds: string[]): Promise<Map<string, PaymentView>> {
  const rows = await repo.paymentsForCheckouts(trx, checkoutIds);
  return new Map(
    rows.map((p) => [
      p.checkoutId,
      {
        status: p.status as PaymentStatus,
        amountCents: p.amountCents,
        pixCopyPaste: p.pixCopyPaste,
        pixQrPngBase64: p.pixQrPngBase64,
        expiresAt: p.expiresAt.toISOString(),
      },
    ]),
  );
}
```

- [ ] **Step 4: Implementar `orders`**

`apps/api/src/modules/orders/repo.ts`:

```ts
import type { Trx } from "../../db/index";

export async function guardianActiveStudents(trx: Trx, guardianId: string, studentIds: string[]) {
  if (studentIds.length === 0) return [];
  return trx
    .selectFrom("guardianStudents")
    .innerJoin("students", "students.id", "guardianStudents.studentId")
    .select(["students.id", "students.firstName"])
    .where("guardianStudents.guardianId", "=", guardianId)
    .where("students.id", "in", studentIds)
    .where("students.active", "=", true)
    .execute();
}

export async function insertCheckout(
  trx: Trx,
  row: { id: string; schoolId: string; guardianId: string; serviceDayId: string; totalCents: number },
): Promise<void> {
  await trx.insertInto("checkouts").values(row).execute();
}

export async function insertOrder(
  trx: Trx,
  row: { id: string; schoolId: string; checkoutId: string; studentId: string; serviceDate: string },
): Promise<void> {
  await trx.insertInto("orders").values(row).execute();
}

export async function insertOrderItems(
  trx: Trx,
  rows: { id: string; schoolId: string; orderId: string; menuItemId: string; qty: number; unitPriceCents: number }[],
): Promise<void> {
  await trx.insertInto("orderItems").values(rows).execute();
}

export async function setWalletApplied(trx: Trx, checkoutId: string, walletAppliedCents: number): Promise<void> {
  await trx.updateTable("checkouts").set({ walletAppliedCents }).where("id", "=", checkoutId).execute();
}

/** `UPDATE … WHERE status IN (from)`: sem linha devolvida, outro processo já fez a transição. */
export async function transitionCheckout(trx: Trx, checkoutId: string, from: string[], to: string) {
  return trx
    .updateTable("checkouts")
    .set({ status: to })
    .where("id", "=", checkoutId)
    .where("status", "in", from)
    .returning(["guardianId", "totalCents", "walletAppliedCents"])
    .executeTakeFirst();
}

export async function transitionOrders(trx: Trx, checkoutId: string, from: string, to: string): Promise<void> {
  await trx.updateTable("orders").set({ status: to }).where("checkoutId", "=", checkoutId).where("status", "=", from).execute();
}

export async function checkoutHeaders(trx: Trx, checkoutIds: string[]) {
  if (checkoutIds.length === 0) return [];
  return trx
    .selectFrom("checkouts")
    .innerJoin("serviceDays", "serviceDays.id", "checkouts.serviceDayId")
    .select([
      "checkouts.id",
      "checkouts.guardianId",
      "checkouts.serviceDayId",
      "checkouts.status",
      "checkouts.totalCents",
      "checkouts.walletAppliedCents",
      "serviceDays.serviceDate",
      "serviceDays.cutoffAt",
    ])
    .where("checkouts.id", "in", checkoutIds)
    .orderBy("checkouts.id")
    .execute();
}

export async function guardianCheckoutIds(trx: Trx, guardianId: string, serviceDate: string): Promise<string[]> {
  const rows = await trx
    .selectFrom("checkouts")
    .innerJoin("serviceDays", "serviceDays.id", "checkouts.serviceDayId")
    .select("checkouts.id")
    .where("checkouts.guardianId", "=", guardianId)
    .where("serviceDays.serviceDate", "=", serviceDate)
    .orderBy("checkouts.id")
    .execute();
  return rows.map((r) => r.id);
}

export async function orderLines(trx: Trx, checkoutIds: string[]) {
  if (checkoutIds.length === 0) return [];
  return trx
    .selectFrom("orders")
    .innerJoin("students", "students.id", "orders.studentId")
    .innerJoin("orderItems", "orderItems.orderId", "orders.id")
    .innerJoin("menuItems", "menuItems.id", "orderItems.menuItemId")
    .select([
      "orders.id as orderId",
      "orders.checkoutId",
      "orders.studentId",
      "students.firstName",
      "orders.status",
      "orderItems.menuItemId",
      "menuItems.name",
      "orderItems.qty",
      "orderItems.unitPriceCents",
    ])
    .where("orders.checkoutId", "in", checkoutIds)
    .orderBy("orders.id")
    .orderBy("menuItems.name")
    .execute();
}

export async function guardianContact(trx: Trx, guardianId: string) {
  return trx
    .selectFrom("guardians")
    .select(["phoneE164", "firstName"])
    .where("id", "=", guardianId)
    .executeTakeFirstOrThrow();
}

export async function studentFirstNames(trx: Trx, checkoutId: string): Promise<string[]> {
  const rows = await trx
    .selectFrom("orders")
    .innerJoin("students", "students.id", "orders.studentId")
    .select("students.firstName")
    .where("orders.checkoutId", "=", checkoutId)
    .orderBy("orders.id")
    .execute();
  return rows.map((r) => r.firstName);
}
```

`apps/api/src/modules/orders/service.ts`:

```ts
import type { CheckoutListResponse, CheckoutStatus, CheckoutView, CreateCheckoutRequest, OrderStatus } from "@app-lanche/contracts";
import type { FastifyBaseLogger } from "fastify";
import { uuidv7 } from "uuidv7";
import { withTenant, type Trx } from "../../db/index";
import { DomainError, isUniqueViolation } from "../../platform/errors";
import { idempotent, requestHash } from "../../platform/idempotency";
import { enqueueEvent } from "../../platform/outbox";
import type { SessionClaims } from "../../platform/session";
import * as catalog from "../catalog/service";
import * as payments from "../payments/service";
import * as wallet from "../wallet/service";
import * as repo from "./repo";

const ONE_ACTIVE_ORDER = "orders_one_active_per_student";

export async function createCheckout(
  session: SessionClaims,
  key: string,
  body: CreateCheckoutRequest,
  log: FastifyBaseLogger,
): Promise<CheckoutView> {
  const schoolId = session.schoolId;
  const hash = requestHash({ route: "POST /api/v1/checkouts", actorId: session.sub, body });
  let checkoutId: string;
  try {
    checkoutId = await withTenant(schoolId, async (trx) => {
      const { response } = await idempotent(trx, { schoolId, key, requestHash: hash }, () => placeCheckout(trx, session, body));
      return response.checkoutId;
    });
  } catch (err) {
    if (isUniqueViolation(err, ONE_ACTIVE_ORDER)) throw new DomainError("order_already_exists");
    throw err;
  }
  await payments.ensureCharge(schoolId, checkoutId, log);
  return getCheckout(session, checkoutId);
}

async function placeCheckout(trx: Trx, session: SessionClaims, body: CreateCheckoutRequest): Promise<{ checkoutId: string }> {
  const schoolId = session.schoolId;
  const guardianId = session.sub;

  const day = await catalog.lockServiceDayByDate(trx, body.serviceDate, "share");
  if (!day) throw new DomainError("not_found");
  if (day.status !== "open" || !day.beforeCutoff) throw new DomainError("cutoff_passed");

  const studentIds = body.orders.map((o) => o.studentId);
  if (new Set(studentIds).size !== studentIds.length) throw new DomainError("invalid_order");
  const students = await repo.guardianActiveStudents(trx, guardianId, studentIds);
  if (students.length !== studentIds.length) throw new DomainError("invalid_order");

  const prices = await catalog.serviceDayPrices(trx, day.id);
  let totalCents = 0;
  for (const order of body.orders) {
    const itemIds = order.items.map((i) => i.menuItemId);
    if (new Set(itemIds).size !== itemIds.length) throw new DomainError("invalid_order");
    for (const item of order.items) {
      const price = prices.get(item.menuItemId);
      if (!price) throw new DomainError("invalid_order");
      totalCents += price.priceCents * item.qty;
    }
  }

  const checkoutId = uuidv7();
  await repo.insertCheckout(trx, { id: checkoutId, schoolId, guardianId, serviceDayId: day.id, totalCents });
  for (const order of body.orders) {
    const orderId = uuidv7();
    await repo.insertOrder(trx, { id: orderId, schoolId, checkoutId, studentId: order.studentId, serviceDate: day.serviceDate });
    await repo.insertOrderItems(
      trx,
      order.items.map((i) => ({
        id: uuidv7(),
        schoolId,
        orderId,
        menuItemId: i.menuItemId,
        qty: i.qty,
        unitPriceCents: prices.get(i.menuItemId)!.priceCents,
      })),
    );
  }

  // A carteira é a última trava da transação (ordem: service_days → … → wallets).
  const { balanceCents } = await wallet.lockBalance(trx, schoolId, guardianId);
  const appliedCents = Math.min(balanceCents, totalCents);
  if (appliedCents > 0) {
    await wallet.postEntry(trx, {
      schoolId,
      guardianId,
      kind: "checkout_hold",
      amountCents: -appliedCents,
      sourceType: "checkout",
      sourceId: checkoutId,
    });
    await repo.setWalletApplied(trx, checkoutId, appliedCents);
  }

  if (appliedCents === totalCents) {
    await confirmCheckout(trx, schoolId, checkoutId);
  } else {
    await payments.createPendingPayment(trx, {
      schoolId,
      checkoutId,
      amountCents: totalCents - appliedCents,
      expiresAt: day.cutoffAt,
    });
  }
  return { checkoutId };
}

/** `pending_payment → paid` e pedidos `pending → confirmed`. Chamada pelo checkout pago com saldo e por confirmPayment. */
export async function confirmCheckout(trx: Trx, schoolId: string, checkoutId: string): Promise<boolean> {
  const checkout = await repo.transitionCheckout(trx, checkoutId, ["pending_payment"], "paid");
  if (!checkout) return false;
  await repo.transitionOrders(trx, checkoutId, "pending", "confirmed");
  const [header] = await repo.checkoutHeaders(trx, [checkoutId]);
  const guardian = await repo.guardianContact(trx, checkout.guardianId);
  await enqueueEvent(trx, schoolId, {
    type: "payment.confirmed",
    data: {
      guardian_id: checkout.guardianId,
      phone: guardian.phoneE164,
      first_name: guardian.firstName,
      checkout_id: checkoutId,
      service_date: header!.serviceDate,
      students: await repo.studentFirstNames(trx, checkoutId),
      total_cents: checkout.totalCents,
    },
  });
  return true;
}

async function views(trx: Trx, checkoutIds: string[]): Promise<CheckoutView[]> {
  const headers = await repo.checkoutHeaders(trx, checkoutIds);
  const lines = await repo.orderLines(trx, checkoutIds);
  const paymentByCheckout = await payments.paymentViews(trx, checkoutIds);
  return headers.map((h) => {
    const orders = new Map<string, CheckoutView["orders"][number]>();
    for (const l of lines.filter((x) => x.checkoutId === h.id)) {
      const order =
        orders.get(l.orderId) ??
        { id: l.orderId, studentId: l.studentId, studentFirstName: l.firstName, status: l.status as OrderStatus, items: [] };
      order.items.push({ menuItemId: l.menuItemId, name: l.name, qty: l.qty, unitPriceCents: l.unitPriceCents });
      orders.set(l.orderId, order);
    }
    const payment = paymentByCheckout.get(h.id) ?? null;
    return {
      id: h.id,
      serviceDate: h.serviceDate,
      cutoffAt: h.cutoffAt.toISOString(),
      status: h.status as CheckoutStatus,
      totalCents: h.totalCents,
      walletAppliedCents: h.walletAppliedCents,
      amountDueCents: payment?.status === "pending" ? payment.amountCents : 0,
      orders: [...orders.values()],
      payment,
    };
  });
}

export async function getCheckout(session: SessionClaims, checkoutId: string): Promise<CheckoutView> {
  return withTenant(session.schoolId, async (trx) => {
    const [header] = await repo.checkoutHeaders(trx, [checkoutId]);
    if (!header || header.guardianId !== session.sub) throw new DomainError("not_found");
    return (await views(trx, [checkoutId]))[0]!;
  });
}

export async function listCheckouts(session: SessionClaims, serviceDate: string): Promise<CheckoutListResponse> {
  return withTenant(session.schoolId, async (trx) => ({
    checkouts: await views(trx, await repo.guardianCheckoutIds(trx, session.sub, serviceDate)),
  }));
}
```

`apps/api/src/modules/orders/routes.ts`:

```ts
import { CheckoutListQuery, CreateCheckoutRequest, Uuid } from "@app-lanche/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RouteAuth } from "../../app";
import { idempotencyKeyFrom } from "../../platform/idempotency";
import * as service from "./service";

const GUARDIAN: RouteAuth = { kind: "guardian", scope: "order" };
const IdParams = z.object({ id: Uuid });

export async function ordersRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/v1/checkouts", { config: { auth: GUARDIAN } }, async (req) =>
    service.createCheckout(req.session!, idempotencyKeyFrom(req), CreateCheckoutRequest.parse(req.body), req.log),
  );

  app.get("/api/v1/checkouts/:id", { config: { auth: GUARDIAN } }, async (req) =>
    service.getCheckout(req.session!, IdParams.parse(req.params).id),
  );

  app.get("/api/v1/checkouts", { config: { auth: GUARDIAN } }, async (req) =>
    service.listCheckouts(req.session!, CheckoutListQuery.parse(req.query).serviceDate),
  );
}
```

Registre em `app.ts`. Observação: `orders/service.ts` e `payments/service.ts` vão se importar mutuamente a partir da Task 7; em ESM isso funciona porque só usam as funções em tempo de execução. Não troque por import dinâmico.

A chave de idempotência é validada antes do corpo (`idempotencyKeyFrom` vem primeiro), então POST sem chave responde `idempotency_key_required` mesmo com corpo válido.

- [ ] **Step 5: Rodar e ver passar; commit**

Run: `pnpm --filter @app-lanche/api exec vitest run src/modules/orders` e `pnpm --filter @app-lanche/contracts test` → PASS. Depois `pnpm typecheck && pnpm lint && pnpm test`.

```bash
git add packages/contracts/src apps/api/src
git commit -m "feat(api): add checkout with wallet hold, idempotent creation and out-of-transaction charge"
```

---

### Task 7: `confirmPayment` (no prazo, tardio, repetido)

**Files:**
- Modify: `apps/api/src/modules/payments/{repo,service}.ts`, `apps/api/src/modules/orders/{repo,service}.ts`
- Create: `apps/api/src/modules/payments/confirm.test.ts`

**Interfaces:**
- Consumes: `catalog.lockServiceDayById` (Task 3), `orders.confirmCheckout` (Task 6), `wallet.postEntry`.
- Produces (`payments/service.ts`): `type ConfirmOutcome = "confirmed" | "late_credited" | "already_processed"`; `confirmPayment(trx: Trx, input: { schoolId: string; paymentId: string; paidAt: Date }): Promise<ConfirmOutcome>`.
- Produces (`orders/service.ts`): `creditLatePayment(trx: Trx, input: { schoolId: string; checkoutId: string; paymentId: string; amountCents: number }): Promise<void>`.

Regras (spec 5.6):
1. Lê o pagamento e o checkout (sem trava) para achar o dia; trava `service_days` (`FOR SHARE`).
2. `payments → paid` com `paid_at` do gateway: `UPDATE … WHERE status IN ('pending','expired')`. Zero linhas → `already_processed`, sem nenhum efeito.
3. No prazo = dia `open` e `paidAt <= cutoff_at`. No prazo e `confirmCheckout` devolveu `true` → `confirmed`.
4. Senão (fora do prazo, dia fechado, ou checkout que já não está `pending_payment`): `creditLatePayment` → `late_credited`:
   checkout `→ late_credited` a partir de `pending_payment` ou `expired`; pedidos `pending → expired_late`; `late_payment_credit` pelo valor pago (origem `payment`/`paymentId`); se `wallet_applied_cents > 0`, `hold_release` pelo valor aplicado (origem `checkout`/`checkoutId` — a unicidade garante uma vez só, mesmo que o fechamento já tenha liberado); evento `payment.late_credited` com o saldo após os lançamentos.
   Checkout em estado diferente de `pending_payment`/`expired` aqui é inconsistência: lance `Error` (500; o gateway reenvia e o log mostra).

- [ ] **Step 1: Testes que falham**

`apps/api/src/modules/payments/confirm.test.ts`:

```ts
import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { describe, expect, it } from "vitest";
import { adminDb, createSchool, guardianCookie, seedFamily, seedServiceDay, walletLedgerMatches } from "../../../test/helpers";
import { buildApp } from "../../app";
import { withTenant } from "../../db/index";
import { postEntry } from "../wallet/service";
import { confirmPayment } from "./service";

/** Checkout de 1350 com 500 de saldo aplicado e Pix pendente de 850. */
async function pendingCheckout() {
  const schoolId = await createSchool();
  const family = await seedFamily(schoolId, ["Léo"]);
  const day = await seedServiceDay(schoolId);
  await withTenant(schoolId, (trx) =>
    postEntry(trx, { schoolId, guardianId: family.guardianId, kind: "cancel_credit", amountCents: 500, sourceType: "checkout", sourceId: uuidv7() }),
  );
  const res = await buildApp().inject({
    method: "POST",
    url: "/api/v1/checkouts",
    cookies: await guardianCookie(schoolId, family.guardianId),
    headers: { "idempotency-key": uuidv7() },
    payload: {
      serviceDate: day.serviceDate,
      orders: [{ studentId: family.studentIds[0]!, items: day.items.map((i) => ({ menuItemId: i.id, qty: 1 })) }],
    },
  });
  const checkoutId = res.json().id as string;
  const payment = await adminDb()
    .selectFrom("payments")
    .innerJoin("checkouts", "checkouts.id", "payments.checkoutId")
    .innerJoin("serviceDays", "serviceDays.id", "checkouts.serviceDayId")
    .select(["payments.id", "serviceDays.cutoffAt"])
    .where("payments.checkoutId", "=", checkoutId)
    .executeTakeFirstOrThrow();
  return { schoolId, family, day, checkoutId, paymentId: payment.id, cutoffAt: payment.cutoffAt };
}

async function state(schoolId: string, checkoutId: string) {
  const db = adminDb();
  const checkout = await db.selectFrom("checkouts").select("status").where("id", "=", checkoutId).executeTakeFirstOrThrow();
  const orders = await db.selectFrom("orders").select("status").where("checkoutId", "=", checkoutId).execute();
  const payment = await db.selectFrom("payments").select(["status", "paidAt"]).where("checkoutId", "=", checkoutId).executeTakeFirstOrThrow();
  const entries = await db
    .selectFrom("walletEntries")
    .select(["kind", "amountCents"])
    .where("schoolId", "=", schoolId)
    .orderBy("createdAt")
    .orderBy("id")
    .execute();
  const events = await db
    .selectFrom("outboxEvents")
    .select(["type", sql<string>`data::text`.as("data")])
    .where("schoolId", "=", schoolId)
    .where("type", "like", "payment.%")
    .execute();
  return {
    checkout: checkout.status,
    orders: orders.map((o) => o.status),
    payment,
    entries,
    events: events.map((e) => ({ type: e.type, data: JSON.parse(e.data) })),
  };
}

const confirm = (schoolId: string, paymentId: string, paidAt: Date) =>
  withTenant(schoolId, (trx) => confirmPayment(trx, { schoolId, paymentId, paidAt }));

describe("confirmPayment", () => {
  it("confirms a payment made before the cutoff", async () => {
    const c = await pendingCheckout();
    const paidAt = new Date(c.cutoffAt.getTime() - 60_000);
    expect(await confirm(c.schoolId, c.paymentId, paidAt)).toBe("confirmed");
    const s = await state(c.schoolId, c.checkoutId);
    expect(s.checkout).toBe("paid");
    expect(s.orders).toEqual(["confirmed"]);
    expect(s.payment).toEqual({ status: "paid", paidAt });
    expect(s.events).toEqual([{ type: "payment.confirmed", data: expect.objectContaining({ checkout_id: c.checkoutId, total_cents: 1350 }) }]);
  });

  it("does nothing the second time", async () => {
    const c = await pendingCheckout();
    const paidAt = new Date(c.cutoffAt.getTime() - 60_000);
    await confirm(c.schoolId, c.paymentId, paidAt);
    const before = await state(c.schoolId, c.checkoutId);
    expect(await confirm(c.schoolId, c.paymentId, paidAt)).toBe("already_processed");
    expect(await state(c.schoolId, c.checkoutId)).toEqual(before);
  });

  it("credits the wallet when paid after the cutoff, releasing the hold once", async () => {
    const c = await pendingCheckout();
    const paidAt = new Date(c.cutoffAt.getTime() + 1000);
    expect(await confirm(c.schoolId, c.paymentId, paidAt)).toBe("late_credited");
    const s = await state(c.schoolId, c.checkoutId);
    expect(s.checkout).toBe("late_credited");
    expect(s.orders).toEqual(["expired_late"]);
    expect(s.payment.status).toBe("paid");
    expect(s.entries.map((e) => [e.kind, e.amountCents])).toEqual([
      ["cancel_credit", 500],
      ["checkout_hold", -500],
      ["late_payment_credit", 850],
      ["hold_release", 500],
    ]);
    expect(s.events).toEqual([
      {
        type: "payment.late_credited",
        data: expect.objectContaining({ guardian_id: c.family.guardianId, amount_cents: 850, wallet_balance_cents: 1350 }),
      },
    ]);
    expect(await walletLedgerMatches(c.schoolId, c.family.guardianId)).toBe(true);
  });

  it("credits the wallet when the day is already closed, even if paid on time", async () => {
    const c = await pendingCheckout();
    await sql`UPDATE service_days SET status = 'closed', closed_at = now() WHERE id = ${c.day.serviceDayId}`.execute(adminDb());
    expect(await confirm(c.schoolId, c.paymentId, new Date(c.cutoffAt.getTime() - 60_000))).toBe("late_credited");
    expect((await state(c.schoolId, c.checkoutId)).checkout).toBe("late_credited");
  });
});
```

Run: `pnpm --filter @app-lanche/api exec vitest run src/modules/payments/confirm.test.ts` → FAIL.

- [ ] **Step 2: Implementar**

Em `payments/repo.ts`:

```ts
export async function paymentContext(trx: Trx, paymentId: string) {
  return trx
    .selectFrom("payments")
    .innerJoin("checkouts", "checkouts.id", "payments.checkoutId")
    .select(["payments.id", "payments.checkoutId", "payments.amountCents", "checkouts.serviceDayId"])
    .where("payments.id", "=", paymentId)
    .executeTakeFirst();
}

/** pending → paid, ou expired → paid (pagamento depois do fechamento). */
export async function markPaid(trx: Trx, paymentId: string, paidAt: Date): Promise<boolean> {
  const row = await trx
    .updateTable("payments")
    .set({ status: "paid", paidAt })
    .where("id", "=", paymentId)
    .where("status", "in", ["pending", "expired"])
    .returning("id")
    .executeTakeFirst();
  return row !== undefined;
}
```

Em `payments/service.ts`:

```ts
import * as catalog from "../catalog/service";
import * as orders from "../orders/service";

export type ConfirmOutcome = "confirmed" | "late_credited" | "already_processed";

/** Única função que confirma pagamento (CLAUDE.md regra 10). Webhook e conciliação chamam esta. */
export async function confirmPayment(
  trx: Trx,
  input: { schoolId: string; paymentId: string; paidAt: Date },
): Promise<ConfirmOutcome> {
  const payment = await repo.paymentContext(trx, input.paymentId);
  if (!payment) throw new Error(`payment ${input.paymentId} not found`);
  const day = await catalog.lockServiceDayById(trx, payment.serviceDayId, "share");
  if (!(await repo.markPaid(trx, payment.id, input.paidAt))) return "already_processed";

  const onTime = day.status === "open" && input.paidAt.getTime() <= day.cutoffAt.getTime();
  if (onTime && (await orders.confirmCheckout(trx, input.schoolId, payment.checkoutId))) return "confirmed";

  await orders.creditLatePayment(trx, {
    schoolId: input.schoolId,
    checkoutId: payment.checkoutId,
    paymentId: payment.id,
    amountCents: payment.amountCents,
  });
  return "late_credited";
}
```

Em `orders/service.ts`:

```ts
export async function creditLatePayment(
  trx: Trx,
  input: { schoolId: string; checkoutId: string; paymentId: string; amountCents: number },
): Promise<void> {
  const checkout = await repo.transitionCheckout(trx, input.checkoutId, ["pending_payment", "expired"], "late_credited");
  if (!checkout) throw new Error(`checkout ${input.checkoutId} cannot be late-credited`);
  await repo.transitionOrders(trx, input.checkoutId, "pending", "expired_late");

  const base = { schoolId: input.schoolId, guardianId: checkout.guardianId };
  let { balanceCents } = await wallet.postEntry(trx, {
    ...base,
    kind: "late_payment_credit",
    amountCents: input.amountCents,
    sourceType: "payment",
    sourceId: input.paymentId,
  });
  if (checkout.walletAppliedCents > 0) {
    ({ balanceCents } = await wallet.postEntry(trx, {
      ...base,
      kind: "hold_release",
      amountCents: checkout.walletAppliedCents,
      sourceType: "checkout",
      sourceId: input.checkoutId,
    }));
  }

  const guardian = await repo.guardianContact(trx, checkout.guardianId);
  await enqueueEvent(trx, input.schoolId, {
    type: "payment.late_credited",
    data: {
      guardian_id: checkout.guardianId,
      phone: guardian.phoneE164,
      first_name: guardian.firstName,
      amount_cents: input.amountCents,
      wallet_balance_cents: balanceCents,
    },
  });
}
```

(Quando `hold_release` já existia, `postEntry` devolve `posted: false` com o saldo atual — que já é o saldo final correto.)

- [ ] **Step 3: Rodar e ver passar; commit**

Run: o teste do Step 1 → PASS. Depois `pnpm typecheck && pnpm lint && pnpm test`.

```bash
git add apps/api/src/modules/payments apps/api/src/modules/orders
git commit -m "feat(api): add confirmPayment with cutoff check, late credit and hold release"
```

---

### Task 8: Webhook do gateway (`/webhooks/payments/:provider/:schoolId`)

**Files:**
- Modify: `apps/api/src/app.ts` (`RouteAuth` ganha `"webhook"`), `apps/api/src/app.test.ts`
- Create: `apps/api/src/modules/webhooks/routes.ts`, `apps/api/src/modules/webhooks/webhook.test.ts`
- Modify: `apps/api/src/modules/payments/{repo,service}.ts`

**Interfaces:**
- Produces: `RouteAuth = "public" | "internal" | "webhook" | {…}`. `onRoute` exige `"webhook"` em toda URL que começa com `/webhooks/` e só nelas (como `"internal"` ↔ `/internal/`). O `preHandler` não faz nada para `"webhook"`: a rota valida o segredo da escola via provedor.
- Produces (`payments/service.ts`): `type WebhookOutcome = ConfirmOutcome | "duplicate" | "ignored" | "unknown_charge" | "amount_mismatch"`; `handleWebhook(input: { providerName: string; schoolId: string; headers: Record<string, string | string[] | undefined>; query: Record<string, string | undefined>; rawBody: string; log: FastifyBaseLogger }): Promise<WebhookOutcome[]>` (um resultado por evento da notificação; zero eventos → `[]`).
- Resposta HTTP: `200 { "received": true }` para todo evento autêntico (inclusive repetido, ignorado, cobrança desconhecida e divergência de valor); `401 invalid_signature` para token errado, escola inexistente ou sem segredo; `404` para provedor desconhecido; `400` corpo inválido; `500` se o processamento falhar (nada fica gravado e o gateway reenvia).

Regras (spec 5.4, 5.5; CLAUDE.md 14, 21):
1. `getProvider(provider)`; `schoolId` precisa ser UUID (senão 401); lê `schools.payment_webhook_secret_ref` e `payment_account_ref` em `withTenant(schoolId)` (`repo.schoolPaymentConfig`); sem ref de webhook → 401; `getSecret(ref)`; `await provider.parseWebhook({ headers, query, rawBody, secret, accountRef })` — fora de transação.
2. Numa transação, para cada evento, em ordem: acha o pagamento por `(provider, provider_charge_id)`; grava `payment_events` (`raw` = corpo recebido) com `ON CONFLICT (provider, provider_event_id) DO NOTHING`; sem linha → `duplicate`. Evento não-pago → `ignored`. Pago sem pagamento → log `warn` `{ event: "payment_webhook_unknown_charge", school_id }` → `unknown_charge`. Valor diferente → log `error` `{ event: "payment_amount_mismatch", school_id, payment_id }`, não confirma → `amount_mismatch`. Senão `confirmPayment`.
3. Nunca registrar o corpo do webhook em log.

- [ ] **Step 1: Testes que falham**

Em `apps/api/src/app.test.ts`, acrescente (siga o padrão existente de registrar rota descartável e esperar o erro de `ready()`):
- rota `POST /webhooks/x` com `auth: "public"` → `ready()` rejeita com `/must use auth "webhook"/`;
- rota `POST /api/v1/x` com `auth: "webhook"` → rejeita com `/must live under \/webhooks\//`.

`apps/api/src/modules/webhooks/webhook.test.ts`:

```ts
import { uuidv7 } from "uuidv7";
import { afterEach, describe, expect, it } from "vitest";
import { adminDb, createSchool, guardianCookie, seedFamily, seedServiceDay } from "../../../test/helpers";
import { buildApp } from "../../app";
import { fakeReset } from "../payments/fakeProvider";

const SECRET = process.env.PAYMENT_WEBHOOK_SECRET_TEST!;

afterEach(() => fakeReset());

async function pendingPayment() {
  const schoolId = await createSchool();
  await adminDb().updateTable("schools").set({ paymentWebhookSecretRef: "PAYMENT_WEBHOOK_SECRET_TEST" }).where("id", "=", schoolId).execute();
  const family = await seedFamily(schoolId, ["Léo"]);
  const day = await seedServiceDay(schoolId);
  const res = await buildApp().inject({
    method: "POST",
    url: "/api/v1/checkouts",
    cookies: await guardianCookie(schoolId, family.guardianId),
    headers: { "idempotency-key": uuidv7() },
    payload: { serviceDate: day.serviceDate, orders: [{ studentId: family.studentIds[0]!, items: [{ menuItemId: day.items[0]!.id, qty: 1 }] }] },
  });
  const payment = await adminDb()
    .selectFrom("payments")
    .select(["id", "providerChargeId", "amountCents", "expiresAt"])
    .where("checkoutId", "=", res.json().id)
    .executeTakeFirstOrThrow();
  return { schoolId, checkoutId: res.json().id as string, payment };
}

function send(schoolId: string, body: Record<string, unknown>, opts: { token?: string; provider?: string } = {}) {
  return buildApp().inject({
    method: "POST",
    url: `/webhooks/payments/${opts.provider ?? "fake"}/${schoolId}`,
    headers: { "content-type": "application/json", "x-fake-token": opts.token ?? SECRET },
    payload: JSON.stringify(body),
  });
}

const paid = (p: Awaited<ReturnType<typeof pendingPayment>>, id = uuidv7(), amount = p.payment.amountCents) => ({
  id,
  event: "charge.paid",
  charge_id: p.payment.providerChargeId,
  amount_cents: amount,
  paid_at: new Date(p.payment.expiresAt.getTime() - 60_000).toISOString(),
});

async function checkoutStatus(id: string) {
  return (await adminDb().selectFrom("checkouts").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status;
}

async function eventCount(schoolId: string) {
  return (await adminDb().selectFrom("paymentEvents").select("id").where("schoolId", "=", schoolId).execute()).length;
}

describe("payment webhook", () => {
  it("confirms a paid charge and stores the raw event", async () => {
    const p = await pendingPayment();
    const res = await send(p.schoolId, paid(p));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
    expect(await checkoutStatus(p.checkoutId)).toBe("paid");
    expect(await eventCount(p.schoolId)).toBe(1);
  });

  it("answers 200 without reprocessing a repeated event, also concurrently", async () => {
    const p = await pendingPayment();
    const body = paid(p);
    const [a, b] = await Promise.all([send(p.schoolId, body), send(p.schoolId, body)]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect((await send(p.schoolId, body)).statusCode).toBe(200);
    expect(await eventCount(p.schoolId)).toBe(1);
    const confirmed = await adminDb().selectFrom("outboxEvents").select("id").where("schoolId", "=", p.schoolId).where("type", "=", "payment.confirmed").execute();
    expect(confirmed).toHaveLength(1);
  });

  it("handles out-of-order and second paid events without double effects", async () => {
    const p = await pendingPayment();
    await send(p.schoolId, paid(p));
    expect((await send(p.schoolId, { id: uuidv7(), event: "charge.created", charge_id: p.payment.providerChargeId })).statusCode).toBe(200);
    expect((await send(p.schoolId, paid(p))).statusCode).toBe(200);
    expect(await checkoutStatus(p.checkoutId)).toBe("paid");
    const credits = await adminDb().selectFrom("walletEntries").select("id").where("schoolId", "=", p.schoolId).execute();
    expect(credits).toEqual([]);
  });

  it("does not confirm when the amount differs", async () => {
    const p = await pendingPayment();
    const res = await send(p.schoolId, paid(p, uuidv7(), p.payment.amountCents + 1));
    expect(res.statusCode).toBe(200);
    expect(await checkoutStatus(p.checkoutId)).toBe("pending_payment");
    expect(await eventCount(p.schoolId)).toBe(1);
  });

  it("rejects a wrong token, another school's token and unknown schools, storing nothing", async () => {
    const p = await pendingPayment();
    expect((await send(p.schoolId, paid(p), { token: "x".repeat(40) })).statusCode).toBe(401);
    const other = await createSchool();
    expect((await send(other, paid(p))).statusCode).toBe(401);
    expect((await send(uuidv7(), paid(p))).statusCode).toBe(401);
    expect((await send("not-a-uuid", paid(p))).statusCode).toBe(401);
    expect((await send(p.schoolId, paid(p), { provider: "nope" })).statusCode).toBe(404);
    expect(await eventCount(p.schoolId)).toBe(0);
    expect(await checkoutStatus(p.checkoutId)).toBe("pending_payment");
  });

  it("accepts an event for an unknown charge without effects", async () => {
    const p = await pendingPayment();
    const res = await send(p.schoolId, { ...paid(p), charge_id: "fake_unknown" });
    expect(res.statusCode).toBe(200);
    expect(await checkoutStatus(p.checkoutId)).toBe("pending_payment");
  });
});
```

Run: `pnpm --filter @app-lanche/api exec vitest run src/modules/webhooks src/app.test.ts` → FAIL.

- [ ] **Step 2: Implementar**

`app.ts`: acrescente `"webhook"` à união `RouteAuth` e, no `onRoute`, a mesma amarração bidirecional que existe para `/internal/` (mensagens: `is under /webhooks/ and must use auth "webhook"` e `uses auth "webhook" and must live under /webhooks/`). O `preHandler` não muda (só trata `"internal"` e objeto). Registre `webhookRoutes`.

Em `payments/repo.ts`:

```ts
export async function paymentByCharge(trx: Trx, provider: string, chargeId: string) {
  return trx
    .selectFrom("payments")
    .select(["id", "amountCents"])
    .where("provider", "=", provider)
    .where("providerChargeId", "=", chargeId)
    .executeTakeFirst();
}

export async function recordEvent(
  trx: Trx,
  row: { provider: string; providerEventId: string; schoolId: string; paymentId: string | null; raw: string },
): Promise<boolean> {
  const inserted = await trx
    .insertInto("paymentEvents")
    .values({ id: uuidv7(), ...row })
    .onConflict((oc) => oc.columns(["provider", "providerEventId"]).doNothing())
    .returning("id")
    .executeTakeFirst();
  return inserted !== undefined;
}
```

Em `payments/service.ts`:

```ts
import { DomainError } from "../../platform/errors";
import { getSecret } from "../../platform/secrets";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type WebhookOutcome = ConfirmOutcome | "duplicate" | "ignored" | "unknown_charge" | "amount_mismatch";

export async function handleWebhook(input: {
  providerName: string;
  schoolId: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | undefined>;
  rawBody: string;
  log: FastifyBaseLogger;
}): Promise<WebhookOutcome[]> {
  const provider = getProvider(input.providerName);
  if (!UUID.test(input.schoolId)) throw new DomainError("invalid_signature");
  const { schoolId } = input;
  const school = await withTenant(schoolId, (trx) => repo.schoolPaymentConfig(trx).catch(() => undefined));
  if (!school?.paymentWebhookSecretRef) throw new DomainError("invalid_signature");
  // Fora de transação: o provedor pode consultar o gateway (CLAUDE.md regra 20).
  const events = await provider.parseWebhook({
    headers: input.headers,
    query: input.query,
    rawBody: input.rawBody,
    secret: getSecret(school.paymentWebhookSecretRef),
    accountRef: school.paymentAccountRef,
  });

  return withTenant(schoolId, async (trx) => {
    const outcomes: WebhookOutcome[] = [];
    for (const event of events) {
      const payment = event.chargeId ? await repo.paymentByCharge(trx, provider.name, event.chargeId) : undefined;
      const recorded = await repo.recordEvent(trx, {
        provider: provider.name,
        providerEventId: event.eventId,
        schoolId,
        paymentId: payment?.id ?? null,
        raw: input.rawBody,
      });
      if (!recorded) {
        outcomes.push("duplicate");
      } else if (event.kind !== "charge_paid") {
        outcomes.push("ignored");
      } else if (!payment) {
        input.log.warn({ event: "payment_webhook_unknown_charge", school_id: schoolId }, "webhook for unknown charge");
        outcomes.push("unknown_charge");
      } else if (payment.amountCents !== event.amountCents) {
        input.log.error({ event: "payment_amount_mismatch", school_id: schoolId, payment_id: payment.id }, "payment amount mismatch");
        outcomes.push("amount_mismatch");
      } else {
        outcomes.push(await confirmPayment(trx, { schoolId, paymentId: payment.id, paidAt: event.paidAt }));
      }
    }
    return outcomes;
  });
}
```

`apps/api/src/modules/webhooks/routes.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { handleWebhook } from "../payments/service";

const Params = z.object({ provider: z.string().min(1).max(40), schoolId: z.string().min(1).max(64) });

/** Direto no Cloud Run, sem passar pelo n8n (CLAUDE.md regra 21). */
export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.post("/webhooks/payments/:provider/:schoolId", { config: { auth: "webhook" } }, async (req) => {
    const params = Params.parse(req.params);
    await handleWebhook({
      providerName: params.provider,
      schoolId: params.schoolId,
      headers: req.headers,
      query: req.query as Record<string, string | undefined>,
      rawBody: req.rawBody ?? "",
      log: req.log,
    });
    return { received: true };
  });
}
```

Confira que o log de erro do Fastify não registra o corpo (`req.body` não entra no `unhandled error` atual). Se `pendingPayment()` falhar porque a escola sem `payment_webhook_secret_ref` não importa para checkout, siga normalmente — o ref só é lido no webhook.

- [ ] **Step 3: Rodar e ver passar; commit**

Run: `pnpm --filter @app-lanche/api exec vitest run src/modules/webhooks src/app.test.ts` → PASS. Depois `pnpm typecheck && pnpm lint && pnpm test`.

```bash
git add apps/api/src
git commit -m "feat(api): add payment webhook with per-school secret, raw event dedup and amount check"
```

---

### Task 9: Cancelamento pelo responsável

**Files:**
- Modify: `apps/api/src/modules/orders/{repo,service,routes}.ts`, `apps/api/src/modules/payments/{repo,service}.ts`
- Create: `apps/api/src/modules/orders/cancel.test.ts`
- Modify: `packages/contracts/src/errors.ts`, `apps/api/src/platform/errors.ts`

**Interfaces:**
- Produces (`orders/service.ts`):
  - `cancelCheckout(session: SessionClaims, checkoutId: string): Promise<CheckoutView>`
  - `expireCheckout(trx: Trx, schoolId: string, checkoutId: string): Promise<boolean>` — `pending_payment → expired`, pedidos `pending → expired`, pagamento `pending → expired`, `hold_release` do saldo aplicado. `false` se não estava `pending_payment`. Usada também pelo fechamento (Task 10).
- Produces (`payments/service.ts`): `expirePendingPayment(trx: Trx, checkoutId: string): Promise<void>`.
- Rota: `POST /api/v1/checkouts/:id/cancel` (guardian, scope `order`), sem `Idempotency-Key` (transição de estado, naturalmente idempotente).
- Código de erro novo: `checkout_not_cancellable` (409).

Regras (spec 5.6, decisões 3 e 5):
1. Lê o checkout do responsável (404 se não for dele); trava o dia (`FOR SHARE`); relê o checkout.
2. Já `cancelled` ou `expired` → devolve o estado atual (200).
3. `late_credited` → `checkout_not_cancellable`.
4. Dia fechado ou depois do corte → `cutoff_passed`.
5. `paid → cancelled`, pedidos `confirmed → cancelled`, `cancel_credit` pelo `total_cents` (origem `checkout`).
6. `pending_payment` → `expireCheckout`.

- [ ] **Step 1: Testes que falham**

`apps/api/src/modules/orders/cancel.test.ts`:

```ts
import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { afterEach, describe, expect, it } from "vitest";
import { adminDb, createSchool, guardianCookie, seedFamily, seedServiceDay, walletLedgerMatches } from "../../../test/helpers";
import { buildApp } from "../../app";
import { withTenant } from "../../db/index";
import { fakeReset } from "../payments/fakeProvider";
import { confirmPayment } from "../payments/service";
import { postEntry } from "../wallet/service";

afterEach(() => fakeReset());

async function setup(walletCents: number) {
  const schoolId = await createSchool();
  const family = await seedFamily(schoolId, ["Léo"]);
  const day = await seedServiceDay(schoolId);
  if (walletCents > 0) {
    await withTenant(schoolId, (trx) =>
      postEntry(trx, { schoolId, guardianId: family.guardianId, kind: "cancel_credit", amountCents: walletCents, sourceType: "checkout", sourceId: uuidv7() }),
    );
  }
  const cookies = await guardianCookie(schoolId, family.guardianId);
  const order = {
    serviceDate: day.serviceDate,
    orders: [{ studentId: family.studentIds[0]!, items: [{ menuItemId: day.items[0]!.id, qty: 1 }] }],
  };
  const create = () =>
    buildApp().inject({ method: "POST", url: "/api/v1/checkouts", cookies, headers: { "idempotency-key": uuidv7() }, payload: order });
  const cancel = (id: string, c = cookies) => buildApp().inject({ method: "POST", url: `/api/v1/checkouts/${id}/cancel`, cookies: c });
  return { schoolId, family, day, cookies, create, cancel };
}

const balance = async (guardianId: string) =>
  (await adminDb().selectFrom("wallets").select("balanceCents").where("guardianId", "=", guardianId).executeTakeFirstOrThrow()).balanceCents;

describe("POST /api/v1/checkouts/:id/cancel", () => {
  it("cancels a paid checkout into wallet credit and frees the student for a new order", async () => {
    const s = await setup(900);
    const paid = (await s.create()).json();
    expect(paid.status).toBe("paid");
    const res = await s.cancel(paid.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "cancelled", orders: [{ status: "cancelled" }] });
    expect(await balance(s.family.guardianId)).toBe(900);
    expect((await s.cancel(paid.id)).json().status).toBe("cancelled");
    expect(await balance(s.family.guardianId)).toBe(900);

    const again = (await s.create()).json();
    expect(again).toMatchObject({ status: "paid", walletAppliedCents: 900 });
    expect(await walletLedgerMatches(s.schoolId, s.family.guardianId)).toBe(true);
  });

  it("expires a pending checkout, releasing the hold and the payment", async () => {
    const s = await setup(300);
    const pending = (await s.create()).json();
    expect(pending).toMatchObject({ status: "pending_payment", walletAppliedCents: 300 });
    const res = await s.cancel(pending.id);
    expect(res.json()).toMatchObject({ status: "expired", orders: [{ status: "expired" }], payment: { status: "expired" } });
    expect(await balance(s.family.guardianId)).toBe(300);
    expect(await walletLedgerMatches(s.schoolId, s.family.guardianId)).toBe(true);
  });

  it("turns a Pix paid after cancelling into wallet credit", async () => {
    const s = await setup(0);
    const pending = (await s.create()).json();
    await s.cancel(pending.id);
    const payment = await adminDb().selectFrom("payments").select("id").where("checkoutId", "=", pending.id).executeTakeFirstOrThrow();
    const outcome = await withTenant(s.schoolId, (trx) =>
      confirmPayment(trx, { schoolId: s.schoolId, paymentId: payment.id, paidAt: new Date(Date.parse(pending.cutoffAt) - 60_000) }),
    );
    expect(outcome).toBe("late_credited");
    expect(await balance(s.family.guardianId)).toBe(900);
  });

  it("refuses after the cutoff, for late-credited checkouts and for other guardians", async () => {
    const s = await setup(900);
    const paid = (await s.create()).json();
    const stranger = await seedFamily(s.schoolId, ["Caio"]);
    expect((await s.cancel(paid.id, await guardianCookie(s.schoolId, stranger.guardianId))).statusCode).toBe(404);

    await sql`UPDATE service_days SET cutoff_at = now() - interval '1 minute', freeze_at = now() + interval '4 minutes' WHERE id = ${s.day.serviceDayId}`.execute(adminDb());
    const late = await s.cancel(paid.id);
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe("cutoff_passed");

    await sql`UPDATE checkouts SET status = 'late_credited' WHERE id = ${paid.id}`.execute(adminDb());
    expect((await s.cancel(paid.id)).json().error.code).toBe("checkout_not_cancellable");
  });
});
```

Run: `pnpm --filter @app-lanche/api exec vitest run src/modules/orders/cancel.test.ts` → FAIL.

- [ ] **Step 2: Implementar**

Em `payments/repo.ts`:

```ts
export async function expirePending(trx: Trx, checkoutId: string): Promise<void> {
  await trx.updateTable("payments").set({ status: "expired" }).where("checkoutId", "=", checkoutId).where("status", "=", "pending").execute();
}
```

Em `payments/service.ts`: `export async function expirePendingPayment(trx: Trx, checkoutId: string): Promise<void> { await repo.expirePending(trx, checkoutId); }`.

Em `orders/service.ts`:

```ts
export async function expireCheckout(trx: Trx, schoolId: string, checkoutId: string): Promise<boolean> {
  const checkout = await repo.transitionCheckout(trx, checkoutId, ["pending_payment"], "expired");
  if (!checkout) return false;
  await repo.transitionOrders(trx, checkoutId, "pending", "expired");
  await payments.expirePendingPayment(trx, checkoutId);
  if (checkout.walletAppliedCents > 0) {
    await wallet.postEntry(trx, {
      schoolId,
      guardianId: checkout.guardianId,
      kind: "hold_release",
      amountCents: checkout.walletAppliedCents,
      sourceType: "checkout",
      sourceId: checkoutId,
    });
  }
  return true;
}

export async function cancelCheckout(session: SessionClaims, checkoutId: string): Promise<CheckoutView> {
  const schoolId = session.schoolId;
  await withTenant(schoolId, async (trx) => {
    const [first] = await repo.checkoutHeaders(trx, [checkoutId]);
    if (!first || first.guardianId !== session.sub) throw new DomainError("not_found");
    const day = await catalog.lockServiceDayById(trx, first.serviceDayId, "share");
    // Relido depois da trava: um webhook pode ter confirmado o pagamento entre as duas leituras.
    const [current] = await repo.checkoutHeaders(trx, [checkoutId]);
    const status = current!.status;
    if (status === "cancelled" || status === "expired") return;
    if (status === "late_credited") throw new DomainError("checkout_not_cancellable");
    if (day.status !== "open" || !day.beforeCutoff) throw new DomainError("cutoff_passed");
    if (status === "paid") {
      const cancelled = await repo.transitionCheckout(trx, checkoutId, ["paid"], "cancelled");
      if (!cancelled) return;
      await repo.transitionOrders(trx, checkoutId, "confirmed", "cancelled");
      await wallet.postEntry(trx, {
        schoolId,
        guardianId: cancelled.guardianId,
        kind: "cancel_credit",
        amountCents: cancelled.totalCents,
        sourceType: "checkout",
        sourceId: checkoutId,
      });
      return;
    }
    await expireCheckout(trx, schoolId, checkoutId);
  });
  return getCheckout(session, checkoutId);
}
```

Em `orders/routes.ts`:

```ts
  app.post("/api/v1/checkouts/:id/cancel", { config: { auth: GUARDIAN } }, async (req) =>
    service.cancelCheckout(req.session!, IdParams.parse(req.params).id),
  );
```

Acrescente `checkout_not_cancellable` (409).

- [ ] **Step 3: Rodar e ver passar; commit**

Run: o teste do Step 1 → PASS. Depois `pnpm typecheck && pnpm lint && pnpm test`.

```bash
git add packages/contracts/src apps/api/src
git commit -m "feat(api): let guardians cancel before the cutoff into wallet credit"
```

---

### Task 10: Fechamento do dia e romaneio (`serviceDays`)

**Files:**
- Create: `packages/contracts/src/manifest.ts`, `packages/contracts/src/manifest.test.ts`; Modify: `packages/contracts/src/events.ts`, `packages/contracts/src/index.ts`, `packages/contracts/src/errors.ts`
- Create: `apps/api/src/modules/serviceDays/{repo,service,routes}.ts`, `apps/api/src/modules/serviceDays/close.test.ts`
- Modify: `apps/api/src/modules/payments/{repo,service}.ts` (conciliação do dia), `apps/api/src/modules/orders/{repo,service}.ts`, `apps/api/src/app.ts`, `apps/api/src/platform/errors.ts`

**Interfaces:**
- Produces (contracts): `ManifestResponse` (snake_case, formato da spec 6.2 `close`), `ServiceDayClosedEvent` na união (`data: { service_date, orders, late_credits }`).
- Produces (`serviceDays/service.ts`):
  - `closeServiceDay(schoolId: string, serviceDate: string, options: { log: FastifyBaseLogger; reconcile?: boolean }): Promise<ManifestResponse>` — idempotente; usada pela rota de equipe agora e pelas rotas internas na F3.
  - `getManifest(schoolId: string, serviceDate: string): Promise<ManifestResponse>` — `service_day_open` (409) se aberto; `not_found` sem dia.
- Produces (`payments/service.ts`): `reconcileServiceDay(schoolId: string, serviceDate: string, log: FastifyBaseLogger): Promise<void>` — para cada pagamento `pending` com cobrança do dia, `getCharge`; pago e com valor igual → `confirmPayment`; erro do gateway → log `warn` `{ event: "reconcile_charge_failed", payment_id }`; valor diferente → log `error` `payment_amount_mismatch`.
- Produces (`orders/service.ts`): `expirePendingCheckouts(trx: Trx, schoolId: string, serviceDayId: string): Promise<number>`; `countLateCredited(trx: Trx, serviceDayId: string): Promise<number>`.
- Rotas de equipe (`admin`, `secretaria`): `POST /api/admin/v1/service-days/:date/close` (sem `Idempotency-Key`) e `GET /api/admin/v1/service-days/:date/manifest`.
- Código de erro novo: `service_day_open` (409).

Regras (spec 5.6 "Fechamento", 6.2):
1. Fora de transação: `reconcileServiceDay` (pulado com `reconcile: false`, usado no teste de corrida).
2. Em transação: trava o dia `FOR UPDATE`; já `closed` → devolve o romaneio gravado.
3. Expira os checkouts `pending_payment` do dia (`expireCheckout`, com `hold_release`).
4. Monta o romaneio dos pedidos `confirmed`: por turma (ordem do nome da turma), cada pedido com `order_id`, `student` (primeiro nome), `items` (`"Nome"` ou `"<qty>x Nome"`) e `restrictions` (`students.dietary_restrictions` só se algum responsável do aluno tem `restriction_consent_at`; senão `null`); `totals.orders` e `totals.by_item` (soma de `qty` por nome, ordem decrescente de `qty` e depois nome); `late_credits` = checkouts `late_credited` do dia.
5. Grava `manifests` (versão 1, `content` = `{ totals, by_class, late_credits }`), marca o dia `closed` (`closed_at = now()`), emite `service_day.closed`.
6. Resposta: `{ status: "closed", closed_at, manifest_version, kitchen_phone, totals, by_class, late_credits }`. O `content` é lido como `content::text`.

- [ ] **Step 1: Contratos**

`packages/contracts/src/manifest.ts`:

```ts
import { z } from "zod";

export const ManifestContent = z.object({
  totals: z.object({
    orders: z.number().int().nonnegative(),
    by_item: z.array(z.object({ item: z.string(), qty: z.number().int().positive() })),
  }),
  by_class: z.array(
    z.object({
      class: z.string(),
      orders: z.array(
        z.object({
          order_id: z.string().uuid(),
          student: z.string(),
          items: z.array(z.string()).min(1),
          restrictions: z.string().nullable(),
        }),
      ),
    }),
  ),
  late_credits: z.number().int().nonnegative(),
});
export type ManifestContent = z.infer<typeof ManifestContent>;

export const ManifestResponse = ManifestContent.extend({
  status: z.literal("closed"),
  closed_at: z.string().datetime({ offset: true }),
  manifest_version: z.number().int().positive(),
  kitchen_phone: z.string().nullable(),
});
export type ManifestResponse = z.infer<typeof ManifestResponse>;
```

`packages/contracts/src/manifest.test.ts` (exemplo da spec 6.2 `close`, com UUID válido no lugar de `0193…`):

```ts
import { describe, expect, it } from "vitest";
import { ManifestResponse } from "./manifest";

describe("manifest contract", () => {
  it("accepts the close example from spec 6.2", () => {
    const example = {
      status: "closed",
      closed_at: "2026-11-17T07:35:02-03:00",
      manifest_version: 1,
      kitchen_phone: "+5511988880000",
      totals: { orders: 142, by_item: [{ item: "Misto quente", qty: 61 }] },
      by_class: [
        {
          class: "Infantil 3A",
          orders: [
            { order_id: "0193a3b0-0000-7000-8000-000000000001", student: "Léo", items: ["Misto quente"], restrictions: "sem lactose" },
          ],
        },
      ],
      late_credits: 3,
    };
    expect(ManifestResponse.parse(example)).toEqual(example);
  });
});
```

Em `events.ts`:

```ts
export const ServiceDayClosedEvent = z.object({
  type: z.literal("service_day.closed"),
  data: z.object({
    service_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    orders: z.number().int().nonnegative(),
    late_credits: z.number().int().nonnegative(),
  }),
});
```

e inclua na união `OutboxEvent`. Acrescente `service_day_open` (409).

- [ ] **Step 2: Testes de API que falham**

`apps/api/src/modules/serviceDays/close.test.ts`:

```ts
import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { afterEach, describe, expect, it } from "vitest";
import { adminDb, createSchool, guardianCookie, seedFamily, seedServiceDay, staffCookie, walletLedgerMatches } from "../../../test/helpers";
import { buildApp } from "../../app";
import { withTenant } from "../../db/index";
import { fakeMarkPaid, fakeReset } from "../payments/fakeProvider";
import { confirmPayment } from "../payments/service";
import { postEntry } from "../wallet/service";
import { closeServiceDay } from "./service";

afterEach(() => fakeReset());
const log = buildApp().log;

async function order(schoolId: string, guardianId: string, serviceDate: string, studentId: string, items: { menuItemId: string; qty: number }[]) {
  const res = await buildApp().inject({
    method: "POST",
    url: "/api/v1/checkouts",
    cookies: await guardianCookie(schoolId, guardianId),
    headers: { "idempotency-key": uuidv7() },
    payload: { serviceDate, orders: [{ studentId, items }] },
  });
  return res.json() as { id: string; status: string };
}

async function credit(schoolId: string, guardianId: string, amountCents: number) {
  await withTenant(schoolId, (trx) =>
    postEntry(trx, { schoolId, guardianId, kind: "cancel_credit", amountCents, sourceType: "checkout", sourceId: uuidv7() }),
  );
}

describe("closeServiceDay", () => {
  it("freezes the manifest, expires unpaid checkouts and is idempotent", async () => {
    const schoolId = await createSchool();
    await adminDb().updateTable("schools").set({ kitchenPhone: "+5511988880000" }).where("id", "=", schoolId).execute();
    const day = await seedServiceDay(schoolId, { items: [{ name: "Misto quente", priceCents: 900 }, { name: "Suco", priceCents: 450 }] });
    const [misto, suco] = day.items;

    const ana = await seedFamily(schoolId, ["Léo"]);
    await sql`UPDATE students SET dietary_restrictions = 'sem lactose' WHERE id = ${ana.studentIds[0]!}`.execute(adminDb());
    await sql`UPDATE guardian_students SET restriction_consent_at = now() WHERE student_id = ${ana.studentIds[0]!}`.execute(adminDb());
    await credit(schoolId, ana.guardianId, 5000);
    const paid = await order(schoolId, ana.guardianId, day.serviceDate, ana.studentIds[0]!, [
      { menuItemId: misto!.id, qty: 2 },
      { menuItemId: suco!.id, qty: 1 },
    ]);
    expect(paid.status).toBe("paid");

    const rui = await seedFamily(schoolId, ["Bia"]);
    await sql`UPDATE students SET dietary_restrictions = 'sem glúten' WHERE id = ${rui.studentIds[0]!}`.execute(adminDb());
    await credit(schoolId, rui.guardianId, 900);
    await order(schoolId, rui.guardianId, day.serviceDate, rui.studentIds[0]!, [{ menuItemId: misto!.id, qty: 1 }]);

    const eva = await seedFamily(schoolId, ["Caio"]);
    await credit(schoolId, eva.guardianId, 200);
    const unpaid = await order(schoolId, eva.guardianId, day.serviceDate, eva.studentIds[0]!, [{ menuItemId: misto!.id, qty: 1 }]);
    expect(unpaid.status).toBe("pending_payment");

    const manifest = await closeServiceDay(schoolId, day.serviceDate, { log });
    expect(manifest).toMatchObject({
      status: "closed",
      manifest_version: 1,
      kitchen_phone: "+5511988880000",
      totals: { orders: 2, by_item: [{ item: misto!.name, qty: 3 }, { item: suco!.name, qty: 1 }] },
      late_credits: 0,
    });
    const orders = manifest.by_class[0]!.orders;
    expect(manifest.by_class.map((c) => c.class)).toEqual(["Infantil 3A"]);
    expect(orders.find((o) => o.student === "Léo")).toMatchObject({ items: [`2x ${misto!.name}`, suco!.name], restrictions: "sem lactose" });
    expect(orders.find((o) => o.student === "Bia")).toMatchObject({ restrictions: null });
    expect(orders.find((o) => o.student === "Caio")).toBeUndefined();

    const unpaidState = await adminDb().selectFrom("checkouts").select("status").where("id", "=", unpaid.id).executeTakeFirstOrThrow();
    expect(unpaidState.status).toBe("expired");
    expect(await walletLedgerMatches(schoolId, eva.guardianId)).toBe(true);
    const evaWallet = await adminDb().selectFrom("wallets").select("balanceCents").where("guardianId", "=", eva.guardianId).executeTakeFirstOrThrow();
    expect(evaWallet.balanceCents).toBe(200);

    expect(await closeServiceDay(schoolId, day.serviceDate, { log })).toEqual(manifest);
    const events = await adminDb().selectFrom("outboxEvents").select(sql<string>`data::text`.as("data")).where("schoolId", "=", schoolId).where("type", "=", "service_day.closed").execute();
    expect(events.map((e) => JSON.parse(e.data))).toEqual([{ service_date: day.serviceDate, orders: 2, late_credits: 0 }]);
  });

  it("confirms charges paid at the gateway before closing (reconciliation)", async () => {
    const schoolId = await createSchool();
    const day = await seedServiceDay(schoolId);
    const family = await seedFamily(schoolId, ["Léo"]);
    const created = await order(schoolId, family.guardianId, day.serviceDate, family.studentIds[0]!, [{ menuItemId: day.items[0]!.id, qty: 1 }]);
    const payment = await adminDb().selectFrom("payments").select("providerChargeId").where("checkoutId", "=", created.id).executeTakeFirstOrThrow();
    fakeMarkPaid(payment.providerChargeId!, new Date(Date.now() - 1000));
    const manifest = await closeServiceDay(schoolId, day.serviceDate, { log });
    expect(manifest.totals.orders).toBe(1);
  });

  it("never puts a payment in both the manifest and the wallet, nor in neither, under concurrency", async () => {
    for (let round = 0; round < 3; round++) {
      const schoolId = await createSchool();
      const day = await seedServiceDay(schoolId);
      const pending: { checkoutId: string; paymentId: string; guardianId: string }[] = [];
      for (let i = 0; i < 12; i++) {
        const family = await seedFamily(schoolId, [`Aluno${i}`]);
        const c = await order(schoolId, family.guardianId, day.serviceDate, family.studentIds[0]!, [{ menuItemId: day.items[0]!.id, qty: 1 }]);
        const p = await adminDb().selectFrom("payments").select("id").where("checkoutId", "=", c.id).executeTakeFirstOrThrow();
        pending.push({ checkoutId: c.id, paymentId: p.id, guardianId: family.guardianId });
      }
      const paidAt = new Date();
      const confirmations = pending.map((p) =>
        withTenant(schoolId, (trx) => confirmPayment(trx, { schoolId, paymentId: p.paymentId, paidAt })),
      );
      const half = Math.floor(confirmations.length / 2);
      const [manifest] = await Promise.all([
        closeServiceDay(schoolId, day.serviceDate, { log, reconcile: false }),
        ...confirmations.slice(0, half),
      ]).then(async (r) => [r[0], await Promise.all(confirmations.slice(half))] as const);

      const inManifest = new Set(manifest.by_class.flatMap((c) => c.orders.map((o) => o.order_id)));
      for (const p of pending) {
        const checkout = await adminDb().selectFrom("checkouts").select("status").where("id", "=", p.checkoutId).executeTakeFirstOrThrow();
        const orderRow = await adminDb().selectFrom("orders").select("id").where("checkoutId", "=", p.checkoutId).executeTakeFirstOrThrow();
        const credits = await adminDb().selectFrom("walletEntries").select("id").where("sourceId", "=", p.paymentId).where("kind", "=", "late_payment_credit").execute();
        const served = inManifest.has(orderRow.id);
        expect(served !== (credits.length === 1)).toBe(true);
        expect(checkout.status).toBe(served ? "paid" : "late_credited");
        expect(await walletLedgerMatches(schoolId, p.guardianId)).toBe(true);
      }
    }
  });
});

describe("service day close routes", () => {
  it("closes through the admin route and serves the manifest only after closing", async () => {
    const schoolId = await createSchool();
    const day = await seedServiceDay(schoolId);
    const { cookies } = await staffCookie(schoolId, "secretaria");
    const before = await buildApp().inject({ method: "GET", url: `/api/admin/v1/service-days/${day.serviceDate}/manifest`, cookies });
    expect(before.statusCode).toBe(409);
    expect(before.json().error.code).toBe("service_day_open");
    const closed = await buildApp().inject({ method: "POST", url: `/api/admin/v1/service-days/${day.serviceDate}/close`, cookies });
    expect(closed.statusCode).toBe(200);
    const after = await buildApp().inject({ method: "GET", url: `/api/admin/v1/service-days/${day.serviceDate}/manifest`, cookies });
    expect(after.json()).toEqual(closed.json());
    const kitchen = await staffCookie(schoolId, "cozinha");
    expect((await buildApp().inject({ method: "POST", url: `/api/admin/v1/service-days/${day.serviceDate}/close`, cookies: kitchen.cookies })).statusCode).toBe(403);
    expect((await buildApp().inject({ method: "POST", url: "/api/admin/v1/service-days/2031-01-01/close", cookies })).statusCode).toBe(404);
  });
});
```

(No teste de corrida, a ideia é disparar o fechamento no meio das confirmações. Se a construção com `.then` ficar confusa, troque por: `const all = await Promise.all([closeServiceDay(...), ...confirmations]); const manifest = all[0] as ManifestResponse;` — o essencial é que fechamento e confirmações rodem concorrentes. Não reduza o número de pagamentos nem de rodadas.)

Run: `pnpm --filter @app-lanche/api exec vitest run src/modules/serviceDays` e `pnpm --filter @app-lanche/contracts test` → FAIL.

- [ ] **Step 3: Implementar**

Em `orders/repo.ts`:

```ts
export async function checkoutIdsByStatus(trx: Trx, serviceDayId: string, status: string): Promise<string[]> {
  const rows = await trx
    .selectFrom("checkouts")
    .select("id")
    .where("serviceDayId", "=", serviceDayId)
    .where("status", "=", status)
    .orderBy("id")
    .execute();
  return rows.map((r) => r.id);
}
```

Em `orders/service.ts`:

```ts
export async function expirePendingCheckouts(trx: Trx, schoolId: string, serviceDayId: string): Promise<number> {
  let expired = 0;
  for (const id of await repo.checkoutIdsByStatus(trx, serviceDayId, "pending_payment")) {
    if (await expireCheckout(trx, schoolId, id)) expired += 1;
  }
  return expired;
}

export async function countLateCredited(trx: Trx, serviceDayId: string): Promise<number> {
  return (await repo.checkoutIdsByStatus(trx, serviceDayId, "late_credited")).length;
}
```

Em `payments/repo.ts`:

```ts
export async function pendingChargesForDay(trx: Trx, serviceDate: string) {
  return trx
    .selectFrom("payments")
    .innerJoin("checkouts", "checkouts.id", "payments.checkoutId")
    .innerJoin("serviceDays", "serviceDays.id", "checkouts.serviceDayId")
    .select(["payments.id", "payments.provider", "payments.providerChargeId", "payments.amountCents"])
    .where("serviceDays.serviceDate", "=", serviceDate)
    .where("payments.status", "=", "pending")
    .where("payments.providerChargeId", "is not", null)
    .execute();
}
```

Em `payments/service.ts`:

```ts
/** Consulta no gateway as cobranças pendentes do dia e confirma as pagas pela mesma confirmPayment. */
export async function reconcileServiceDay(schoolId: string, serviceDate: string, log: FastifyBaseLogger): Promise<void> {
  const { pending, school } = await withTenant(schoolId, async (trx) => ({
    pending: await repo.pendingChargesForDay(trx, serviceDate),
    school: await repo.schoolPaymentConfig(trx),
  }));
  for (const p of pending) {
    let charge;
    try {
      charge = await getProvider(p.provider).getCharge(p.providerChargeId!, school.paymentAccountRef);
    } catch {
      log.warn({ event: "reconcile_charge_failed", payment_id: p.id }, "reconciliation lookup failed");
      continue;
    }
    if (charge.status !== "paid" || !charge.paidAt) continue;
    if (charge.amountCents !== p.amountCents) {
      log.error({ event: "payment_amount_mismatch", school_id: schoolId, payment_id: p.id }, "payment amount mismatch");
      continue;
    }
    const paidAt = charge.paidAt;
    await withTenant(schoolId, (trx) => confirmPayment(trx, { schoolId, paymentId: p.id, paidAt }));
  }
}
```

`apps/api/src/modules/serviceDays/repo.ts`:

```ts
import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import type { Trx } from "../../db/index";

export async function manifestLines(trx: Trx, serviceDayId: string) {
  return trx
    .selectFrom("orders")
    .innerJoin("checkouts", "checkouts.id", "orders.checkoutId")
    .innerJoin("students", "students.id", "orders.studentId")
    .innerJoin("classes", "classes.id", "students.classId")
    .innerJoin("orderItems", "orderItems.orderId", "orders.id")
    .innerJoin("menuItems", "menuItems.id", "orderItems.menuItemId")
    .select([
      "orders.id as orderId",
      "students.firstName",
      "classes.name as className",
      "orderItems.qty",
      "menuItems.name as itemName",
      // Restrição alimentar é dado de saúde: só com consentimento de um responsável (spec 4.5).
      sql<string | null>`CASE WHEN EXISTS (
        SELECT 1 FROM guardian_students gs
        WHERE gs.student_id = students.id AND gs.restriction_consent_at IS NOT NULL
      ) THEN students.dietary_restrictions END`.as("restrictions"),
    ])
    .where("checkouts.serviceDayId", "=", serviceDayId)
    .where("orders.status", "=", "confirmed")
    .orderBy("classes.name")
    .orderBy("students.firstName")
    .orderBy("orders.id")
    .orderBy("menuItems.name")
    .execute();
}

export async function insertManifest(trx: Trx, row: { schoolId: string; serviceDayId: string; content: string }): Promise<void> {
  await trx.insertInto("manifests").values({ id: uuidv7(), version: 1, ...row }).execute();
}

export async function readManifest(trx: Trx, serviceDayId: string) {
  return trx
    .selectFrom("manifests")
    .select(["version", sql<string>`content::text`.as("content")])
    .where("serviceDayId", "=", serviceDayId)
    .orderBy("version", "desc")
    .executeTakeFirstOrThrow();
}

export async function kitchenPhone(trx: Trx): Promise<string | null> {
  const row = await trx.selectFrom("schools").select("kitchenPhone").executeTakeFirst();
  return row?.kitchenPhone ?? null;
}
```

`apps/api/src/modules/serviceDays/service.ts`:

```ts
import type { ManifestContent, ManifestResponse } from "@app-lanche/contracts";
import type { FastifyBaseLogger } from "fastify";
import { withTenant, type Trx } from "../../db/index";
import { DomainError } from "../../platform/errors";
import { enqueueEvent } from "../../platform/outbox";
import * as catalog from "../catalog/service";
import * as orders from "../orders/service";
import * as payments from "../payments/service";
import * as repo from "./repo";

type Line = Awaited<ReturnType<typeof repo.manifestLines>>[number];

export function buildManifest(lines: Line[], lateCredits: number): ManifestContent {
  const byClass = new Map<string, Map<string, ManifestContent["by_class"][number]["orders"][number]>>();
  const byItem = new Map<string, number>();
  for (const l of lines) {
    const cls = byClass.get(l.className) ?? new Map();
    byClass.set(l.className, cls);
    const order = cls.get(l.orderId) ?? { order_id: l.orderId, student: l.firstName, items: [], restrictions: l.restrictions };
    order.items.push(l.qty > 1 ? `${l.qty}x ${l.itemName}` : l.itemName);
    cls.set(l.orderId, order);
    byItem.set(l.itemName, (byItem.get(l.itemName) ?? 0) + l.qty);
  }
  const by_class = [...byClass.entries()].map(([name, ordersById]) => ({ class: name, orders: [...ordersById.values()] }));
  return {
    totals: {
      orders: by_class.reduce((n, c) => n + c.orders.length, 0),
      by_item: [...byItem.entries()]
        .map(([item, qty]) => ({ item, qty }))
        .sort((a, b) => b.qty - a.qty || a.item.localeCompare(b.item)),
    },
    by_class,
    late_credits: lateCredits,
  };
}

async function response(trx: Trx, serviceDayId: string, closedAt: Date): Promise<ManifestResponse> {
  const manifest = await repo.readManifest(trx, serviceDayId);
  return {
    status: "closed",
    closed_at: closedAt.toISOString(),
    manifest_version: manifest.version,
    kitchen_phone: await repo.kitchenPhone(trx),
    ...(JSON.parse(manifest.content) as ManifestContent),
  };
}

export async function closeServiceDay(
  schoolId: string,
  serviceDate: string,
  options: { log: FastifyBaseLogger; reconcile?: boolean },
): Promise<ManifestResponse> {
  if (options.reconcile !== false) await payments.reconcileServiceDay(schoolId, serviceDate, options.log);
  return withTenant(schoolId, async (trx) => {
    const day = await catalog.lockServiceDayByDate(trx, serviceDate, "update");
    if (!day) throw new DomainError("not_found");
    if (day.status === "closed") return response(trx, day.id, day.closedAt!);

    await orders.expirePendingCheckouts(trx, schoolId, day.id);
    const content = buildManifest(await repo.manifestLines(trx, day.id), await orders.countLateCredited(trx, day.id));
    await repo.insertManifest(trx, { schoolId, serviceDayId: day.id, content: JSON.stringify(content) });
    const closedAt = await catalog.markServiceDayClosed(trx, day.id);
    await enqueueEvent(trx, schoolId, {
      type: "service_day.closed",
      data: { service_date: serviceDate, orders: content.totals.orders, late_credits: content.late_credits },
    });
    return response(trx, day.id, closedAt!);
  });
}

export async function getManifest(schoolId: string, serviceDate: string): Promise<ManifestResponse> {
  return withTenant(schoolId, async (trx) => {
    const day = await catalog.lockServiceDayByDate(trx, serviceDate, "share");
    if (!day) throw new DomainError("not_found");
    if (day.status !== "closed") throw new DomainError("service_day_open");
    return response(trx, day.id, day.closedAt!);
  });
}
```

`apps/api/src/modules/serviceDays/routes.ts`:

```ts
import { IsoDate } from "@app-lanche/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RouteAuth } from "../../app";
import * as service from "./service";

const OFFICE: RouteAuth = { kind: "staff", roles: ["admin", "secretaria"] };
const DateParams = z.object({ date: IsoDate });

export async function serviceDayRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/admin/v1/service-days/:date/close", { config: { auth: OFFICE } }, async (req) =>
    service.closeServiceDay(req.session!.schoolId, DateParams.parse(req.params).date, { log: req.log }),
  );

  app.get("/api/admin/v1/service-days/:date/manifest", { config: { auth: OFFICE } }, async (req) =>
    service.getManifest(req.session!.schoolId, DateParams.parse(req.params).date),
  );
}
```

Registre em `app.ts`.

- [ ] **Step 4: Rodar e ver passar; commit**

Run: `pnpm --filter @app-lanche/api exec vitest run src/modules/serviceDays` e `pnpm --filter @app-lanche/contracts test` → PASS. Rode o teste de corrida 3 vezes seguidas (`--repeat` não existe em todas as versões; rode o comando 3 vezes) e registre no relatório. Depois `pnpm typecheck && pnpm lint && pnpm test`.

```bash
git add packages/contracts/src apps/api/src
git commit -m "feat(api): close service days into an immutable manifest with reconciliation"
```

---
### Task 11: Web do responsável — pedido, Pix, cancelamento e carteira

**Files:**
- Modify: `apps/web/src/app/api.ts` (+ `api.test.ts`), `apps/web/src/app/App.tsx`, `apps/web/src/ui/messages.ts`
- Create: `apps/web/src/ui/money.ts`, `apps/web/src/ui/money.test.ts`
- Modify: `apps/web/src/areas/guardian/OrderHome.tsx`
- Create: `apps/web/src/areas/guardian/DayOrder.tsx`, `apps/web/src/areas/guardian/CheckoutPage.tsx`, `apps/web/src/areas/guardian/WalletPage.tsx`, `apps/web/src/areas/guardian/order.test.tsx`

**Interfaces:**
- Consumes: rotas `GET /api/v1/me`, `GET /api/v1/service-days`, `GET /api/v1/checkouts?serviceDate=`, `POST /api/v1/checkouts`, `GET /api/v1/checkouts/:id`, `POST /api/v1/checkouts/:id/cancel`, `GET /api/v1/wallet`; schemas de `@app-lanche/contracts`.
- Produces: `apiFetch(path, schema, init?: { method?: string; body?: unknown; idempotencyKey?: string })` — com `idempotencyKey`, envia o header `Idempotency-Key`; `formatCents(cents: number): string` (`1350 → "R$ 13,50"`, `125000 → "R$ 1.250,00"`), só com aritmética inteira.
- Rotas web: `/pedido` (escolha), `/pedido/checkout/:id` (pagamento), `/carteira`.

Comportamento:
- `/pedido`: carrega `/me` e `/service-days`. Sem dias: "Nenhum dia aberto para pedidos no momento." Com dias: seletor de dia (padrão o primeiro), mostra "Pedidos até HH:MM" (horário local do aparelho, `toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })`), saldo "Saldo na carteira: R$ X" e, para cada filho, os itens do dia com botões "−"/"+" (quantidade 0–10). Filho que já tem pedido ativo no dia (checkout do dia com pedido `pending`, `confirmed` ou `delivered` para ele) mostra "Pedido já feito" e um link "Ver pedido" para o checkout.
- Total do carrinho = soma de `priceCents × qty` só para exibição; o servidor recalcula. Botão "Pagar R$ X" desabilitado com carrinho vazio.
- Ao pagar: gera `crypto.randomUUID()` uma vez por carrinho (guardado em `useRef`; um carrinho alterado gera nova chave), envia `POST /api/v1/checkouts` com a chave e navega para `/pedido/checkout/:id`. Em erro, mostra `errorMessage(code)` e mantém a mesma chave para nova tentativa.
- `/pedido/checkout/:id`: busca o checkout; enquanto `pending_payment`, repete `GET` a cada 3 s (limpa o intervalo ao sair). Estados:
  - `pending_payment` com `pixCopyPaste`: "Pague com Pix até HH:MM", o código num `<textarea readOnly>` e o botão "Copiar código Pix" (`navigator.clipboard.writeText`; depois "Código copiado"). Com `pixQrPngBase64`, `<img alt="QR Code Pix" src="data:image/png;base64,…">`. Sem `pixCopyPaste`: "Gerando o Pix… aguarde alguns segundos."
  - `paid`: "Pedido confirmado!" e a lista "Léo: 2x Misto quente, 1x Suco".
  - `expired`: "Este pedido expirou sem pagamento."
  - `late_credited`: "O pagamento chegou depois do horário. O valor virou crédito na sua carteira."
  - `cancelled`: "Pedido cancelado. O valor voltou para a sua carteira."
  - Botão "Cancelar pedido" para `paid` e `pending_payment` (pede `window.confirm("Cancelar este pedido?")`), chama `POST …/cancel` e mostra o novo estado; erro → `errorMessage(code)`.
  - Link "Voltar" para `/pedido`.
- `/carteira`: "Saldo: R$ X" e a lista de lançamentos (data `dd/mm`, descrição por tipo e valor com sinal). Descrições: `checkout_hold` "Usado em pedido", `hold_release` "Devolução de saldo reservado", `late_payment_credit` "Pagamento após o horário", `cancel_credit` "Pedido cancelado", `refund` "Reembolso", `manual_adjustment` "Ajuste da escola".
- `OrderHome` ganha link "Minha carteira" para `/carteira`.
- Mensagens novas em `messages.ts` (responsável):
  - `cutoff_passed`: "O horário de pedidos para este dia já encerrou."
  - `order_already_exists`: "Já existe um pedido para este aluno neste dia."
  - `invalid_order`: "Não foi possível montar o pedido. Atualize a página e tente de novo."
  - `checkout_not_cancellable`: "Este pedido não pode mais ser cancelado."
  - `not_found`: "Não encontramos este pedido."

- [ ] **Step 1: Testes que falham**

`apps/web/src/ui/money.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatCents } from "./money";

describe("formatCents", () => {
  it.each([
    [0, "R$ 0,00"],
    [5, "R$ 0,05"],
    [1350, "R$ 13,50"],
    [125000, "R$ 1.250,00"],
    [-900, "-R$ 9,00"],
  ])("%i → %s", (cents, text) => {
    expect(formatCents(cents)).toBe(text);
  });
});
```

Em `apps/web/src/app/api.test.ts`, acrescente: com `idempotencyKey: "k-123456789"`, a chamada ao `fetch` leva o header `Idempotency-Key: k-123456789` e `content-type: application/json` quando há corpo.

`apps/web/src/areas/guardian/order.test.tsx` — use o mesmo padrão de `mockApi` de `LinkLanding.test.tsx`, mas casando por método + URL (`"GET /api/v1/me"`, `"POST /api/v1/checkouts"`), e `MemoryRouter` com as rotas `/pedido`, `/pedido/checkout/:id` e `/carteira`. Casos obrigatórios:

1. **Monta o pedido e paga:** `/me` com 2 filhos e saldo 500; `/service-days` com um dia e itens Misto (900) e Suco (450); `/checkouts?serviceDate=…` vazio. Clica "+" no Misto do primeiro filho duas vezes e no Suco do segundo uma vez → aparece "Pagar R$ 22,50". Clica → o `POST /api/v1/checkouts` recebe corpo `{ serviceDate, orders: [{ studentId: <1º>, items: [{ menuItemId: misto, qty: 2 }] }, { studentId: <2º>, items: [{ menuItemId: suco, qty: 1 }] }] }` e header `Idempotency-Key` não vazio; a tela navega para o checkout devolvido.
2. **Repetição usa a mesma chave:** o primeiro POST responde 0 (rede) → mostra "Sem conexão…"; clicar de novo envia a mesma `Idempotency-Key`.
3. **Erro de corte:** POST responde 409 `cutoff_passed` → "O horário de pedidos para este dia já encerrou."
4. **Filho com pedido:** `/checkouts?serviceDate=…` devolve um checkout `paid` com pedido `confirmed` do primeiro filho → mostra "Pedido já feito" para ele e nenhum botão "+" para esse filho.
5. **Pix e polling:** em `/pedido/checkout/c1`, primeira resposta `pending_payment` com `pixCopyPaste: "PIXCODE"` → mostra o código e "Copiar código Pix"; use `vi.useFakeTimers({ shouldAdvanceTime: true })`, avance 3 s, a segunda resposta é `paid` → "Pedido confirmado!".
6. **Cancelar:** checkout `paid`; `window.confirm` simulado com `true`; `POST /api/v1/checkouts/c1/cancel` responde `cancelled` → "Pedido cancelado. O valor voltou para a sua carteira."
7. **Carteira:** `/carteira` com saldo 1350 e um lançamento `late_payment_credit` de 850 → "Saldo: R$ 13,50" e "Pagamento após o horário".

Monte as respostas com objetos que passam pelos schemas de `contracts` (UUIDs válidos, datas ISO), senão `apiFetch` devolve `invalid_response`.

Run: `pnpm --filter @app-lanche/web exec vitest run src` → FAIL.

- [ ] **Step 2: Implementar**

`apps/web/src/ui/money.ts`:

```ts
/** Formata centavos como "R$ 1.250,00" sem ponto flutuante (CLAUDE.md regra 6). */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(cents));
  const reais = Math.floor(abs / 100);
  const centavos = String(abs % 100).padStart(2, "0");
  const grouped = String(reais).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${sign}R$ ${grouped},${centavos}`;
}
```

`apps/web/src/app/api.ts` — `init` ganha `idempotencyKey?: string`; monte os headers assim:

```ts
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.idempotencyKey) headers["idempotency-key"] = init.idempotencyKey;
```

`apps/web/src/areas/guardian/DayOrder.tsx`:

```tsx
import {
  CheckoutListResponse,
  CheckoutView,
  type GuardianServiceDay,
  type MeResponse,
} from "@app-lanche/contracts";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ApiError, apiFetch } from "../../app/api";
import { errorMessage } from "../../ui/messages";
import { formatCents } from "../../ui/money";

type Cart = Record<string, Record<string, number>>; // studentId → menuItemId → qty
const ACTIVE = new Set(["pending", "confirmed", "delivered"]);

export function DayOrder({ day, me }: { day: GuardianServiceDay; me: MeResponse }) {
  const navigate = useNavigate();
  const [cart, setCart] = useState<Cart>({});
  const [ordered, setOrdered] = useState<Map<string, string>>(new Map()); // studentId → checkoutId
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const keyRef = useRef<string | null>(null);

  useEffect(() => {
    setCart({});
    keyRef.current = null;
    apiFetch(`/api/v1/checkouts?serviceDate=${day.serviceDate}`, CheckoutListResponse).then(
      (res) => {
        const map = new Map<string, string>();
        for (const c of res.checkouts) for (const o of c.orders) if (ACTIVE.has(o.status)) map.set(o.studentId, c.id);
        setOrdered(map);
      },
      (err) => setError(errorMessage(err instanceof ApiError ? err.code : "internal_error")),
    );
  }, [day.serviceDate]);

  function change(studentId: string, menuItemId: string, delta: number) {
    keyRef.current = null;
    setCart((prev) => {
      const current = prev[studentId]?.[menuItemId] ?? 0;
      const qty = Math.min(10, Math.max(0, current + delta));
      return { ...prev, [studentId]: { ...prev[studentId], [menuItemId]: qty } };
    });
  }

  const price = new Map(day.items.map((i) => [i.menuItemId, i.priceCents]));
  const orders = Object.entries(cart)
    .map(([studentId, items]) => ({
      studentId,
      items: Object.entries(items)
        .filter(([, qty]) => qty > 0)
        .map(([menuItemId, qty]) => ({ menuItemId, qty })),
    }))
    .filter((o) => o.items.length > 0);
  const total = orders.reduce((sum, o) => sum + o.items.reduce((s, i) => s + (price.get(i.menuItemId) ?? 0) * i.qty, 0), 0);

  async function pay() {
    setBusy(true);
    setError(null);
    keyRef.current ??= crypto.randomUUID();
    try {
      const checkout = await apiFetch("/api/v1/checkouts", CheckoutView, {
        method: "POST",
        body: { serviceDate: day.serviceDate, orders },
        idempotencyKey: keyRef.current,
      });
      navigate(`/pedido/checkout/${checkout.id}`);
    } catch (err) {
      setError(errorMessage(err instanceof ApiError ? err.code : "internal_error"));
    } finally {
      setBusy(false);
    }
  }

  const cutoff = new Date(day.cutoffAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return (
    <section>
      <p>Pedidos até {cutoff}</p>
      {me.students.map((s) => (
        <article key={s.id}>
          <h2>{s.firstName}</h2>
          {ordered.has(s.id) ? (
            <p>
              Pedido já feito · <Link to={`/pedido/checkout/${ordered.get(s.id)}`}>Ver pedido</Link>
            </p>
          ) : (
            <ul>
              {day.items.map((item) => {
                const qty = cart[s.id]?.[item.menuItemId] ?? 0;
                return (
                  <li key={item.menuItemId}>
                    {item.name} — {formatCents(item.priceCents)}{" "}
                    <button type="button" aria-label={`Remover ${item.name} de ${s.firstName}`} onClick={() => change(s.id, item.menuItemId, -1)}>
                      −
                    </button>{" "}
                    {qty}{" "}
                    <button type="button" aria-label={`Adicionar ${item.name} para ${s.firstName}`} onClick={() => change(s.id, item.menuItemId, 1)}>
                      +
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </article>
      ))}
      {error && <p role="alert">{error}</p>}
      <button type="button" disabled={total === 0 || busy} onClick={pay}>
        Pagar {formatCents(total)}
      </button>
    </section>
  );
}
```

`apps/web/src/areas/guardian/OrderHome.tsx`:

```tsx
import { GuardianServiceDayListResponse, MeResponse } from "@app-lanche/contracts";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ApiError, apiFetch } from "../../app/api";
import { errorMessage } from "../../ui/messages";
import { formatCents } from "../../ui/money";
import { DayOrder } from "./DayOrder";

export function OrderHome() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [days, setDays] = useState<GuardianServiceDayListResponse["serviceDays"] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fail = (err: unknown) => setError(errorMessage(err instanceof ApiError ? err.code : "internal_error"));
    apiFetch("/api/v1/me", MeResponse).then(setMe, fail);
    apiFetch("/api/v1/service-days", GuardianServiceDayListResponse).then((r) => {
      setDays(r.serviceDays);
      setSelected(r.serviceDays[0]?.serviceDate ?? null);
    }, fail);
  }, []);

  if (error) return <main><p role="alert">{error}</p></main>;
  if (!me || !days) return <main><p>Carregando…</p></main>;
  const day = days.find((d) => d.serviceDate === selected);

  return (
    <main>
      <h1>Olá, {me.guardian.firstName}</h1>
      <p>
        Saldo na carteira: {formatCents(me.walletBalanceCents)} · <Link to="/carteira">Minha carteira</Link>
      </p>
      {days.length === 0 ? (
        <p>Nenhum dia aberto para pedidos no momento.</p>
      ) : (
        <>
          <label>
            Dia{" "}
            <select value={selected ?? ""} onChange={(e) => setSelected(e.target.value)}>
              {days.map((d) => (
                <option key={d.serviceDate} value={d.serviceDate}>
                  {d.serviceDate.split("-").reverse().join("/")}
                </option>
              ))}
            </select>
          </label>
          {day && <DayOrder day={day} me={me} />}
        </>
      )}
    </main>
  );
}
```

`apps/web/src/areas/guardian/CheckoutPage.tsx`:

```tsx
import { CheckoutView } from "@app-lanche/contracts";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { ApiError, apiFetch } from "../../app/api";
import { errorMessage } from "../../ui/messages";

const FINAL_TEXT: Partial<Record<CheckoutView["status"], string>> = {
  expired: "Este pedido expirou sem pagamento.",
  late_credited: "O pagamento chegou depois do horário. O valor virou crédito na sua carteira.",
  cancelled: "Pedido cancelado. O valor voltou para a sua carteira.",
};

export function CheckoutPage() {
  const { id } = useParams();
  const [checkout, setCheckout] = useState<CheckoutView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const fail = (err: unknown) => setError(errorMessage(err instanceof ApiError ? err.code : "internal_error"));

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const load = () =>
      apiFetch(`/api/v1/checkouts/${id}`, CheckoutView).then(
        (c) => {
          if (stopped) return;
          setCheckout(c);
          if (c.status === "pending_payment") timer = setTimeout(load, 3000);
        },
        (err) => {
          if (!stopped) fail(err);
        },
      );
    void load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [id]);

  async function cancel() {
    if (!window.confirm("Cancelar este pedido?")) return;
    try {
      setCheckout(await apiFetch(`/api/v1/checkouts/${id}/cancel`, CheckoutView, { method: "POST" }));
    } catch (err) {
      fail(err);
    }
  }

  if (!checkout) return <main>{error ? <p role="alert">{error}</p> : <p>Carregando…</p>}</main>;
  const until = new Date(checkout.cutoffAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const pix = checkout.payment;

  return (
    <main>
      {checkout.status === "pending_payment" &&
        (pix?.pixCopyPaste ? (
          <section>
            <p>Pague com Pix até {until}</p>
            {pix.pixQrPngBase64 && <img alt="QR Code Pix" src={`data:image/png;base64,${pix.pixQrPngBase64}`} />}
            <textarea readOnly value={pix.pixCopyPaste} aria-label="Código Pix" />
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(pix.pixCopyPaste!).then(() => setCopied(true), () => setCopied(false))}
            >
              {copied ? "Código copiado" : "Copiar código Pix"}
            </button>
          </section>
        ) : (
          <p>Gerando o Pix… aguarde alguns segundos.</p>
        ))}
      {checkout.status === "paid" && (
        <section>
          <p>Pedido confirmado!</p>
          <ul>
            {checkout.orders.map((o) => (
              <li key={o.id}>
                {o.studentFirstName}: {o.items.map((i) => `${i.qty}x ${i.name}`).join(", ")}
              </li>
            ))}
          </ul>
        </section>
      )}
      {FINAL_TEXT[checkout.status] && <p>{FINAL_TEXT[checkout.status]}</p>}
      {(checkout.status === "paid" || checkout.status === "pending_payment") && (
        <button type="button" onClick={cancel}>
          Cancelar pedido
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      <Link to="/pedido">Voltar</Link>
    </main>
  );
}
```

`apps/web/src/areas/guardian/WalletPage.tsx`:

```tsx
import { WalletResponse } from "@app-lanche/contracts";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ApiError, apiFetch } from "../../app/api";
import { errorMessage } from "../../ui/messages";
import { formatCents } from "../../ui/money";

const LABEL: Record<WalletResponse["entries"][number]["kind"], string> = {
  checkout_hold: "Usado em pedido",
  hold_release: "Devolução de saldo reservado",
  late_payment_credit: "Pagamento após o horário",
  cancel_credit: "Pedido cancelado",
  refund: "Reembolso",
  manual_adjustment: "Ajuste da escola",
};

export function WalletPage() {
  const [wallet, setWallet] = useState<WalletResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch("/api/v1/wallet", WalletResponse).then(setWallet, (err) =>
      setError(errorMessage(err instanceof ApiError ? err.code : "internal_error")),
    );
  }, []);

  if (error) return <main><p role="alert">{error}</p></main>;
  if (!wallet) return <main><p>Carregando…</p></main>;
  return (
    <main>
      <h1>Saldo: {formatCents(wallet.balanceCents)}</h1>
      <ul>
        {wallet.entries.map((e) => (
          <li key={e.id}>
            {new Date(e.createdAt).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })} · {LABEL[e.kind]} ·{" "}
            {e.amountCents > 0 ? "+" : ""}
            {formatCents(e.amountCents)}
          </li>
        ))}
      </ul>
      <Link to="/pedido">Voltar</Link>
    </main>
  );
}
```

Em `App.tsx`, acrescente `<Route path="/pedido/checkout/:id" element={<CheckoutPage />} />` e `<Route path="/carteira" element={<WalletPage />} />`. Acrescente as mensagens a `MESSAGES` em `messages.ts`.

Se o teste do caso 5 com timers falsos ficar instável com `findByText`, use `vi.advanceTimersByTimeAsync(3000)` seguido de `await screen.findByText(...)`; não aumente o intervalo de 3 s.

- [ ] **Step 3: Rodar e ver passar; commit**

Run: `pnpm --filter @app-lanche/web exec vitest run src` → PASS. Depois `pnpm typecheck && pnpm lint && pnpm test` e `pnpm --filter @app-lanche/web build`.

```bash
git add apps/web/src
git commit -m "feat(web): add guardian ordering, Pix payment screen, cancellation and wallet"
```

---

### Task 12: Web da secretaria — cardápio, dias de serviço e fechamento

**Files:**
- Create: `apps/web/src/areas/admin/MenuAdmin.tsx`, `apps/web/src/areas/admin/ServiceDaysAdmin.tsx`, `apps/web/src/areas/admin/catalogAdmin.test.tsx`
- Modify: `apps/web/src/areas/admin/AdminHome.tsx`, `apps/web/src/ui/messages.ts`

**Interfaces:**
- Consumes: `GET/POST /api/admin/v1/menu-items`, `PATCH /api/admin/v1/menu-items/:id`, `GET /api/admin/v1/service-days?from=`, `PUT /api/admin/v1/service-days/:date`, `POST /api/admin/v1/service-days/:date/close`; `apiFetch` com `idempotencyKey`; `formatCents`.

Comportamento (só para papéis `admin` e `secretaria`; `AdminHome` já carrega `/api/admin/v1/me` e conhece o papel — mostre as duas seções abaixo do que já existe, e não as mostre para `cozinha`):
- **Cardápio** (`MenuAdmin`): lista "Nome — R$ X (inativo)" com botão "Desativar"/"Ativar" (PATCH `active`). Formulário "Novo item" com campos "Nome" e "Preço (R$)" (texto; aceita `9`, `9,5`, `9,50`; converte para centavos com `parsePriceToCents`, abaixo) e botão "Adicionar" (POST com `idempotencyKey = crypto.randomUUID()` gerado por envio do formulário). Preço inválido → "Preço inválido." sem chamar a API.
- **Dias de serviço** (`ServiceDaysAdmin`): lista os próximos dias (`GET ?from` omitido) com data `dd/mm/aaaa`, "corte HH:MM", estado ("Aberto"/"Fechado") e itens. Formulário "Abrir dia": campo de data (`<input type="date">`), horário de corte opcional (`<input type="time">`, vazio = padrão da escola), caixas de seleção dos itens ativos e botão "Salvar dia" (PUT). Para dias abertos, botão "Fechar dia" (pede `window.confirm("Fechar o dia? Os pedidos não pagos expiram e o romaneio fica congelado.")`) → POST close → mostra "Dia fechado: N pedidos." e recarrega a lista.
- Mensagens novas em `STAFF_MESSAGES`:
  - `cutoff_passed`: "O horário de corte deste dia já passou."
  - `service_day_locked`: "Este dia já tem pedidos ou está fechado; o cardápio não pode mudar."
  - `menu_item_name_taken`: "Já existe um item com esse nome."
  - `validation_failed`: "Confira os dados e tente de novo."

`parsePriceToCents` (exporte de `MenuAdmin.tsx` ou de `ui/money.ts`; teste em `money.test.ts`):

```ts
/** "9" → 900, "9,5" → 950, "9,50" → 950, "1.250,00" → 125000; inválido ou zero → null. Sem ponto flutuante. */
export function parsePriceToCents(text: string): number | null {
  const m = /^\s*(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{1,2}))?\s*$/.exec(text);
  if (!m) return null;
  const reais = Number(m[1]!.replace(/\./g, ""));
  const cents = Number((m[2] ?? "0").padEnd(2, "0"));
  const total = reais * 100 + cents;
  return total > 0 && total <= 1_000_000 ? total : null;
}
```

- [ ] **Step 1: Testes que falham**

Em `money.test.ts`, casos de `parsePriceToCents`: `"9"→900`, `"9,5"→950`, `"9,50"→950`, `"1.250,00"→125000`, `"0"→null`, `"9.5"→null`, `"abc"→null`, `"10000,01"→null`.

`apps/web/src/areas/admin/catalogAdmin.test.tsx` (mesmo padrão de `admin.test.tsx`, `mockApi` por método + URL). Casos:
1. Lista itens e cria um novo: digita "Pão de queijo" e "4,50", clica "Adicionar" → POST com corpo `{ name: "Pão de queijo", priceCents: 450 }` e header `Idempotency-Key`; o item aparece na lista.
2. Preço "abc" → "Preço inválido." e nenhum POST.
3. Desativar envia PATCH `{ active: false }`.
4. Abrir dia: escolhe a data `2030-03-04`, marca um item, "Salvar dia" → PUT `/api/admin/v1/service-days/2030-03-04` com `{ items: [{ menuItemId }] }` (sem `cutoffTime` quando vazio).
5. Fechar dia: `window.confirm` → `true`; POST close devolve um manifesto com `totals.orders: 3` → "Dia fechado: 3 pedidos."
6. Erro `service_day_locked` no PUT → "Este dia já tem pedidos ou está fechado; o cardápio não pode mudar."
7. Usuário `cozinha`: não aparecem "Cardápio" nem "Dias de serviço".

Run: `pnpm --filter @app-lanche/web exec vitest run src/areas/admin src/ui` → FAIL.

- [ ] **Step 2: Implementar**

Implemente `MenuAdmin.tsx` e `ServiceDaysAdmin.tsx` seguindo o comportamento acima e o estilo de `DayOrder.tsx` (estado local com `useState`, `apiFetch` com os schemas de `contracts`, erros por `staffErrorMessage(code)`). Os títulos das seções são `<h2>Cardápio</h2>` e `<h2>Dias de serviço</h2>`. A resposta do fechamento é validada com `ManifestResponse`. Em `AdminHome.tsx`, renderize `<MenuAdmin />` e `<ServiceDaysAdmin />` quando `role` for `admin` ou `secretaria`.

- [ ] **Step 3: Rodar e ver passar; commit**

Run: `pnpm --filter @app-lanche/web exec vitest run src` → PASS. Depois `pnpm typecheck && pnpm lint && pnpm test` e `pnpm --filter @app-lanche/web build`.

```bash
git add apps/web/src
git commit -m "feat(web): add menu and service day management with day close for staff"
```

---

### Task 13: Adaptador Efí Pix (`efi`)

**Files:**
- Create: `apps/api/src/modules/payments/efi/money.ts`, `apps/api/src/modules/payments/efi/client.ts`, `apps/api/src/modules/payments/efi/efiProvider.ts`, `apps/api/src/modules/payments/efi/efi.test.ts`, `apps/api/src/modules/webhooks/efiWebhook.test.ts`
- Create: `apps/api/src/cli/efiSetup.ts`; Modify: `apps/api/package.json` (script `cli:efi-setup`)
- Modify: `apps/api/src/modules/payments/registry.ts`, `apps/api/src/platform/config.ts` (+ `config.test.ts`), `apps/api/src/app.ts` (serializer de log), `apps/api/src/app.test.ts`
- Create: `docs/efi-pix.md` (cópia de `.superpowers/sdd/2026-11-17-f2-pedidos-pagamento-carteira/efi-pix-reference.md`, com título em português e a lista de itens não confirmados); Modify: `docs/deploy.md`

**Interfaces:**
- Consumes: `PaymentProvider`, `WebhookInput`, `WebhookEvent`, `Charge`, `ChargeRequest` (Task 5); `getSecret` (Task 5); `safeEqual` (`platform/hmac.ts`); `handleWebhook` (Task 8).
- Produces:
  - `efiProvider: PaymentProvider` (`name: "efi"`), sempre registrado em `getProvider("efi")`.
  - `money.ts`: `centsToReais(cents: number): string` (`1350 → "13.50"`), `reaisToCents(text: string): number` (`"13.50" → 1350`; aceita só `/^\d+\.\d{2}$/`, senão lança), `bpsToPercent(bps: number): string` (`1000 → "10.00"`, `9000 → "90.00"`, `250 → "2.50"`). Só aritmética inteira.
  - `client.ts`: `type EfiCredentials = { client_id: string; client_secret: string; pix_key: string; certificate_p12_base64: string; certificate_passphrase?: string }`; `loadCredentials(ref: string): EfiCredentials` (lê `getSecret(ref)` como JSON validado por zod; erro cita o ref, nunca o valor); `type EfiTransport = (req: { credentials: EfiCredentials; method: string; path: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; body: unknown }>`; `efiCall(credentials, method, path, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: unknown }>`; `setEfiTransportForTests(t: EfiTransport | null): void`; `resetEfiForTests(): void`.
  - `txidFor(paymentId: string): string` = UUID sem hífens (32 caracteres); `splitConfigIdFor(schoolId: string): string` = `"sp" + schoolId sem hífens` (34 caracteres).
- Config: `PAYMENT_PROVIDER: z.enum(["fake", "efi"])` (padrão `"fake"`); `EFI_ENV: z.enum(["production", "homologacao"])` (padrão `"homologacao"`); `EFI_PLATFORM_ACCOUNT` opcional, JSON `{ "document_type": "cpf" | "cnpj", "document": "<só dígitos>", "account": "<número da conta Efí>" }` validado por zod no boot (inválido → `invalid environment: EFI_PLATFORM_ACCOUNT`). `Config` ganha `efiEnv` e `efiPlatformAccount: { documentType; document; account } | null`. A trava "fake só com `ENABLE_FAKE_PAYMENTS=true`" continua valendo apenas quando `PAYMENT_PROVIDER=fake`.

Regras (referência: `docs/efi-pix.md`):
1. **Credenciais por escola:** `schools.payment_account_ref` é o nome da variável de ambiente com o JSON `EfiCredentials` (mapeada do Secret Manager). `schools.payment_webhook_secret_ref` continua sendo o segredo do webhook; para a Efí ele precisa casar `/^[A-Za-z0-9_-]{32,}$/` (vai na URL).
2. **Transporte:** `node:https` com `https.Agent({ pfx: Buffer.from(certificate_p12_base64, "base64"), passphrase, keepAlive: true })`, um agente por `client_id`. Host `pix.api.efipay.com.br` (production) ou `pix-h.api.efipay.com.br` (homologacao). Corpo JSON; resposta vazia → `body: null`. Timeout de 15 s (rejeita).
3. **Token OAuth:** `POST /oauth/token`, `Authorization: Basic base64(client_id:client_secret)`, corpo `{"grant_type":"client_credentials"}`. Cache por `client_id` até `expires_in − 300` s. Uma resposta 401 numa chamada da API descarta o token e repete a chamada uma vez.
4. **`createCharge`:** `PUT /v2/cob/<txid>` com `{ calendario: { expiracao }, valor: { original: centsToReais(amountCents) }, chave: pix_key, solicitacaoPagador: description }`, `expiracao = max(60, segundos até expiresAt)`. 200/201 → usa a resposta; 409 → `GET /v2/cob/<txid>` e reaproveita (a cobrança já existia); outro status → lança `Error("efi cob failed: <status>")` (sem corpo na mensagem). Se `valor.original` da cobrança difere do pedido → lança. Com `platformFeeBps > 0`: `PUT /v2/gn/split/cob/<txid>/vinculo/<splitConfigIdFor(schoolId)>` sem corpo; qualquer 2xx ok, senão lança (a cobrança fica sem Pix gravado e a próxima tentativa repete — o Pix só é mostrado depois do split vinculado).
5. **Mapeamento da cobrança:** `ATIVA` → `pending`; `CONCLUIDA` → `paid` com `paidAt = new Date(pix[0].horario)` e `amountCents = reaisToCents(pix[0].valor)`; `REMOVIDA_PELO_USUARIO_RECEBEDOR` ou `REMOVIDA_PELO_PSP` → `expired`; outro → lança. Fora de `CONCLUIDA`, `amountCents = reaisToCents(valor.original)`. `pixCopyPaste = pixCopiaECola ?? null`; `pixQrPngBase64 = null` (a imagem da Efí é SVG; o app mostra o copia-e-cola).
6. **`getCharge(txid, accountRef)`:** `GET /v2/cob/<txid>`; 2xx → mapeamento; senão lança.
7. **`parseWebhook`:** a Efí não assina o corpo. (a) `query.token` comparado em tempo constante com o segredo → senão `invalid_signature`; (b) corpo JSON (inválido → `validation_failed`); sem array `pix` (notificação de teste) → `[]`; (c) para cada item: sem `txid` → `{ eventId: endToEndId, kind: "ignored", chargeId: null }`; com `txid` → `getCharge(txid)` na Efí; pago → `charge_paid` com valor e horário **da consulta** (nunca do corpo); não pago → `ignored`. `eventId = endToEndId`.
8. **URL do webhook** registrada na Efí: `<API_BASE_URL>/webhooks/payments/efi/<school_id>?token=<segredo>&ignorar=` (a Efí acrescenta `/pix` ao final, que cai no valor de `ignorar`).
9. **Logs:** o serializer de requisição do Fastify registra só `method`, o caminho sem query string (`url.split("?")[0]`), `hostname` e `remoteAddress` — o token do webhook nunca vai para log. Vale para o logger padrão e para o passado em `buildApp({ logger })` quando for objeto.
10. **CLI `pnpm --filter @app-lanche/api cli:efi-setup <school_id> <api_base_url>`:** lê a escola com `withTenant`, carrega credenciais e segredo; `PUT /v2/webhook/<encodeURIComponent(pix_key)>` com header `x-skip-mtls-checking: true` e corpo `{ "webhookUrl": <URL da regra 8> }`; se `platform_fee_bps > 0`, exige `EFI_PLATFORM_ACCOUNT` e faz `PUT /v2/gn/split/config/<splitConfigIdFor(school_id)>` com
   `{ descricao: "Taxa da plataforma", lancamento: { imediato: true }, split: { divisaoTarifa: "assumir_total", minhaParte: { tipo: "porcentagem", valor: bpsToPercent(10000 - fee) }, repasses: [{ tipo: "porcentagem", valor: bpsToPercent(fee), favorecido: { [document_type]: document, conta: account } }] } }`.
   Imprime só o resultado de cada passo (`webhook: ok`, `split: ok (config sp…)`), nunca a URL com token nem credenciais. Falha → código de saída 1 com o status HTTP.

- [ ] **Step 1: Testes que falham**

`apps/api/src/modules/payments/efi/efi.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEfiForTests, setEfiTransportForTests, type EfiTransport } from "./client";
import { efiProvider, splitConfigIdFor, txidFor } from "./efiProvider";
import { bpsToPercent, centsToReais, reaisToCents } from "./money";

const REF = "EFI_TEST_CREDENTIALS";
const SECRET = "efi-webhook-secret-0123456789abcdefghij";
const PAYMENT_ID = "0193a3b0-0000-7000-8000-000000000001";
const SCHOOL_ID = "0193a3b0-0000-7000-8000-0000000000aa";
const TXID = "0193a3b0000070008000000000000001";

type Call = { method: string; path: string; headers: Record<string, string>; body?: unknown };
let calls: Call[];
let routes: Record<string, (call: Call) => { status: number; body: unknown }>;

beforeEach(() => {
  process.env[REF] = JSON.stringify({
    client_id: "Client_Id_test",
    client_secret: "Client_Secret_test",
    pix_key: "chave-pix-escola",
    certificate_p12_base64: "AA==",
  });
  calls = [];
  routes = {
    "POST /oauth/token": () => ({ status: 200, body: { access_token: "tok-1", token_type: "Bearer", expires_in: 3600 } }),
  };
  const transport: EfiTransport = async (req) => {
    const call = { method: req.method, path: req.path, headers: req.headers, body: req.body ? JSON.parse(req.body) : undefined };
    calls.push(call);
    const handler = routes[`${req.method} ${req.path}`];
    if (!handler) throw new Error(`unexpected ${req.method} ${req.path}`);
    return handler(call);
  };
  setEfiTransportForTests(transport);
});

afterEach(() => {
  setEfiTransportForTests(null);
  resetEfiForTests();
});

const activeCob = { txid: TXID, status: "ATIVA", valor: { original: "13.50" }, pixCopiaECola: "000201EFI" };
const paidCob = {
  txid: TXID,
  status: "CONCLUIDA",
  valor: { original: "13.50" },
  pix: [{ endToEndId: "E123", txid: TXID, valor: "13.50", horario: "2030-03-04T10:00:00.000Z" }],
};

const chargeRequest = (platformFeeBps = 0) => ({
  paymentId: PAYMENT_ID,
  schoolId: SCHOOL_ID,
  amountCents: 1350,
  expiresAt: new Date(Date.now() + 3_600_000),
  description: "Lanche escolar",
  accountRef: REF,
  platformFeeBps,
});

describe("efi money helpers", () => {
  it("converts with integer arithmetic", () => {
    expect(centsToReais(1350)).toBe("13.50");
    expect(centsToReais(5)).toBe("0.05");
    expect(reaisToCents("13.50")).toBe(1350);
    expect(reaisToCents("0.01")).toBe(1);
    expect(() => reaisToCents("13.5")).toThrow();
    expect(() => reaisToCents("1,00")).toThrow();
    expect(bpsToPercent(1000)).toBe("10.00");
    expect(bpsToPercent(9000)).toBe("90.00");
    expect(bpsToPercent(250)).toBe("2.50");
  });

  it("derives txid and split config ids", () => {
    expect(txidFor(PAYMENT_ID)).toBe(TXID);
    expect(splitConfigIdFor(SCHOOL_ID)).toBe("sp0193a3b00000700080000000000000aa");
  });
});

describe("efi createCharge", () => {
  it("authenticates once and creates the charge with our txid", async () => {
    routes[`PUT /v2/cob/${TXID}`] = () => ({ status: 201, body: activeCob });
    const charge = await efiProvider.createCharge(chargeRequest());
    expect(charge).toEqual({ chargeId: TXID, status: "pending", amountCents: 1350, paidAt: null, pixCopyPaste: "000201EFI", pixQrPngBase64: null });
    await efiProvider.createCharge(chargeRequest());
    expect(calls.filter((c) => c.path === "/oauth/token")).toHaveLength(1);
    const oauth = calls.find((c) => c.path === "/oauth/token")!;
    expect(oauth.headers.authorization).toBe(`Basic ${Buffer.from("Client_Id_test:Client_Secret_test").toString("base64")}`);
    expect(oauth.body).toEqual({ grant_type: "client_credentials" });
    const cob = calls.find((c) => c.method === "PUT")!;
    expect(cob.headers.authorization).toBe("Bearer tok-1");
    expect(cob.body).toMatchObject({ valor: { original: "13.50" }, chave: "chave-pix-escola", solicitacaoPagador: "Lanche escolar" });
    expect((cob.body as { calendario: { expiracao: number } }).calendario.expiracao).toBeGreaterThan(3500);
  });

  it("reuses an existing charge on 409", async () => {
    routes[`PUT /v2/cob/${TXID}`] = () => ({ status: 409, body: { nome: "txid_duplicado" } });
    routes[`GET /v2/cob/${TXID}`] = () => ({ status: 200, body: activeCob });
    expect((await efiProvider.createCharge(chargeRequest())).pixCopyPaste).toBe("000201EFI");
  });

  it("links the platform split before returning the Pix code", async () => {
    routes[`PUT /v2/cob/${TXID}`] = () => ({ status: 201, body: activeCob });
    routes[`PUT /v2/gn/split/cob/${TXID}/vinculo/${splitConfigIdFor(SCHOOL_ID)}`] = () => ({ status: 204, body: null });
    await efiProvider.createCharge(chargeRequest(1000));
    expect(calls.map((c) => `${c.method} ${c.path}`)).toContain(`PUT /v2/gn/split/cob/${TXID}/vinculo/${splitConfigIdFor(SCHOOL_ID)}`);
  });

  it("fails without leaking the response body and refreshes an expired token once", async () => {
    routes[`PUT /v2/cob/${TXID}`] = () => ({ status: 500, body: { detail: "secret detail" } });
    await expect(efiProvider.createCharge(chargeRequest())).rejects.toThrow(/^efi cob failed: 500$/);

    let first = true;
    routes[`PUT /v2/cob/${TXID}`] = () => {
      if (first) {
        first = false;
        return { status: 401, body: null };
      }
      return { status: 201, body: activeCob };
    };
    await efiProvider.createCharge(chargeRequest());
    expect(calls.filter((c) => c.path === "/oauth/token")).toHaveLength(2);
  });

  it("names the missing credential reference, never a value", async () => {
    await expect(efiProvider.createCharge({ ...chargeRequest(), accountRef: "EFI_MISSING_REF" })).rejects.toThrow(/EFI_MISSING_REF/);
  });
});

describe("efi getCharge and parseWebhook", () => {
  it("maps a concluded charge to paid with the gateway's time and amount", async () => {
    routes[`GET /v2/cob/${TXID}`] = () => ({ status: 200, body: paidCob });
    expect(await efiProvider.getCharge(TXID, REF)).toMatchObject({
      status: "paid",
      amountCents: 1350,
      paidAt: new Date("2030-03-04T10:00:00.000Z"),
    });
  });

  const hook = (body: unknown, token = SECRET) =>
    efiProvider.parseWebhook({ headers: {}, query: { token, ignorar: "/pix" }, rawBody: JSON.stringify(body), secret: SECRET, accountRef: REF });

  it("rejects a wrong token and accepts the registration ping", async () => {
    await expect(hook({ pix: [] }, "wrong-token-0123456789abcdefghijklmn")).rejects.toMatchObject({ code: "invalid_signature" });
    expect(await hook({ evento: "teste_webhook" })).toEqual([]);
  });

  it("trusts the charge lookup, not the notification body", async () => {
    routes[`GET /v2/cob/${TXID}`] = () => ({ status: 200, body: paidCob });
    const events = await hook({ pix: [{ endToEndId: "E123", txid: TXID, valor: "99.99", horario: "2020-01-01T00:00:00Z" }] });
    expect(events).toEqual([
      { eventId: "E123", kind: "charge_paid", chargeId: TXID, amountCents: 1350, paidAt: new Date("2030-03-04T10:00:00.000Z") },
    ]);
  });

  it("ignores payments without txid and charges not yet concluded", async () => {
    routes[`GET /v2/cob/${TXID}`] = () => ({ status: 200, body: activeCob });
    expect(await hook({ pix: [{ endToEndId: "E1", valor: "1.00" }, { endToEndId: "E2", txid: TXID, valor: "13.50" }] })).toEqual([
      { eventId: "E1", kind: "ignored", chargeId: null },
      { eventId: "E2", kind: "ignored", chargeId: TXID },
    ]);
  });
});
```

`apps/api/src/modules/webhooks/efiWebhook.test.ts` — rota completa com o provedor `efi` (transporte simulado com `setEfiTransportForTests`, como acima):
1. Escola com `payment_account_ref = "EFI_TEST_CREDENTIALS"` e `payment_webhook_secret_ref = "PAYMENT_WEBHOOK_SECRET_TEST"`; família, dia (`seedServiceDay`) e um checkout pendente criado pela API (provedor padrão `fake`); depois, via `adminDb`, troque o pagamento para `provider = 'efi'` e `provider_charge_id = txidFor(paymentId)`.
2. `POST /webhooks/payments/efi/<school_id>?token=<segredo>&ignorar=/pix` com o corpo de notificação da Efí → 200, checkout `paid`.
3. O mesmo corpo de novo → 200 e um único `payment.confirmed` na outbox.
4. Token errado → 401 e nenhuma linha em `payment_events`.
5. Um logger de captura (`buildApp({ logger: { level: "info", stream } })`) não contém o segredo em nenhuma linha depois da requisição do item 2.

Em `app.test.ts`: uma requisição `GET /healthz?token=abc123segredo` com logger de captura não registra `abc123segredo`.

Em `config.test.ts`: `PAYMENT_PROVIDER=efi` sobe sem `ENABLE_FAKE_PAYMENTS`; `EFI_ENV` padrão `homologacao`; `EFI_PLATFORM_ACCOUNT` inválido derruba o boot citando o nome; válido vira `{ documentType, document, account }`.

Run: `pnpm --filter @app-lanche/api exec vitest run src/modules/payments/efi src/modules/webhooks src/app.test.ts src/platform/config.test.ts` → FAIL.

- [ ] **Step 2: Implementar**

`apps/api/src/modules/payments/efi/money.ts`:

```ts
const REAIS = /^(\d+)\.(\d{2})$/;

export function centsToReais(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error("invalid cents");
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

export function reaisToCents(text: string): number {
  const m = REAIS.exec(text);
  if (!m) throw new Error("invalid amount format");
  const cents = Number(m[1]) * 100 + Number(m[2]);
  if (!Number.isSafeInteger(cents)) throw new Error("invalid amount");
  return cents;
}

/** Pontos-base para o percentual com duas casas que a Efí espera ("10.00"). */
export function bpsToPercent(bps: number): string {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new Error("invalid bps");
  return `${Math.floor(bps / 100)}.${String(bps % 100).padStart(2, "0")}`;
}
```

`apps/api/src/modules/payments/efi/client.ts`:

```ts
import https from "node:https";
import { z } from "zod";
import { config } from "../../../platform/config";
import { getSecret } from "../../../platform/secrets";

const Credentials = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  pix_key: z.string().min(1),
  certificate_p12_base64: z.string().min(1),
  certificate_passphrase: z.string().optional(),
});
export type EfiCredentials = z.infer<typeof Credentials>;

export type EfiTransport = (req: {
  credentials: EfiCredentials;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}) => Promise<{ status: number; body: unknown }>;

const HOSTS = { production: "pix.api.efipay.com.br", homologacao: "pix-h.api.efipay.com.br" } as const;
const TIMEOUT_MS = 15_000;
const agents = new Map<string, https.Agent>();
const tokens = new Map<string, { value: string; expiresAt: number }>();

export function loadCredentials(ref: string): EfiCredentials {
  const raw = getSecret(ref);
  try {
    return Credentials.parse(JSON.parse(raw));
  } catch {
    throw new Error(`secret ${ref} is not valid Efí credentials JSON`);
  }
}

function agentFor(c: EfiCredentials): https.Agent {
  let agent = agents.get(c.client_id);
  if (!agent) {
    agent = new https.Agent({
      pfx: Buffer.from(c.certificate_p12_base64, "base64"),
      passphrase: c.certificate_passphrase ?? "",
      keepAlive: true,
    });
    agents.set(c.client_id, agent);
  }
  return agent;
}

const httpsTransport: EfiTransport = (req) =>
  new Promise((resolve, reject) => {
    const r = https.request(
      {
        host: HOSTS[config().efiEnv],
        path: req.path,
        method: req.method,
        headers: { ...req.headers, ...(req.body ? { "content-type": "application/json" } : {}) },
        agent: agentFor(req.credentials),
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: unknown = null;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            body = null;
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    r.on("timeout", () => r.destroy(new Error("efi request timed out")));
    r.on("error", reject);
    if (req.body) r.write(req.body);
    r.end();
  });

let transport: EfiTransport = httpsTransport;

export function setEfiTransportForTests(t: EfiTransport | null): void {
  transport = t ?? httpsTransport;
}

export function resetEfiForTests(): void {
  tokens.clear();
  for (const a of agents.values()) a.destroy();
  agents.clear();
}

async function accessToken(c: EfiCredentials): Promise<string> {
  const cached = tokens.get(c.client_id);
  // Relógio local só para validade do token OAuth, nunca para regra de negócio.
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const res = await transport({
    credentials: c,
    method: "POST",
    path: "/oauth/token",
    headers: { authorization: `Basic ${Buffer.from(`${c.client_id}:${c.client_secret}`).toString("base64")}` },
    body: JSON.stringify({ grant_type: "client_credentials" }),
  });
  const parsed = z.object({ access_token: z.string().min(1), expires_in: z.number().int().positive() }).safeParse(res.body);
  if (res.status !== 200 || !parsed.success) throw new Error(`efi oauth failed: ${res.status}`);
  tokens.set(c.client_id, { value: parsed.data.access_token, expiresAt: Date.now() + (parsed.data.expires_in - 300) * 1000 });
  return parsed.data.access_token;
}

export async function efiCall(
  c: EfiCredentials,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const send = async () =>
    transport({
      credentials: c,
      method,
      path,
      headers: { ...headers, authorization: `Bearer ${await accessToken(c)}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const res = await send();
  if (res.status !== 401) return res;
  tokens.delete(c.client_id);
  return send();
}
```

`apps/api/src/modules/payments/efi/efiProvider.ts`:

```ts
import { z } from "zod";
import { DomainError } from "../../../platform/errors";
import { safeEqual } from "../../../platform/hmac";
import type { Charge, ChargeRequest, PaymentProvider, WebhookEvent, WebhookInput } from "../provider";
import { efiCall, loadCredentials } from "./client";
import { centsToReais, reaisToCents } from "./money";

export const txidFor = (paymentId: string): string => paymentId.replace(/-/g, "");
export const splitConfigIdFor = (schoolId: string): string => `sp${schoolId.replace(/-/g, "")}`;

const Cob = z.object({
  txid: z.string(),
  status: z.string(),
  valor: z.object({ original: z.string() }),
  pixCopiaECola: z.string().optional(),
  pix: z.array(z.object({ endToEndId: z.string(), valor: z.string(), horario: z.string() })).optional(),
});
type Cob = z.infer<typeof Cob>;

const Notification = z.object({
  pix: z.array(z.object({ endToEndId: z.string().min(1), txid: z.string().optional() })).optional(),
});

const is2xx = (status: number) => status >= 200 && status < 300;

function credentialsFor(accountRef: string | null) {
  if (!accountRef) throw new Error("school has no payment account reference");
  return loadCredentials(accountRef);
}

function toCharge(cob: Cob): Charge {
  const base = { chargeId: cob.txid, pixCopyPaste: cob.pixCopiaECola ?? null, pixQrPngBase64: null };
  if (cob.status === "ATIVA") return { ...base, status: "pending", amountCents: reaisToCents(cob.valor.original), paidAt: null };
  if (cob.status === "CONCLUIDA") {
    const pix = cob.pix?.[0];
    if (!pix) throw new Error("efi concluded charge without pix");
    return { ...base, status: "paid", amountCents: reaisToCents(pix.valor), paidAt: new Date(pix.horario) };
  }
  if (cob.status === "REMOVIDA_PELO_USUARIO_RECEBEDOR" || cob.status === "REMOVIDA_PELO_PSP") {
    return { ...base, status: "expired", amountCents: reaisToCents(cob.valor.original), paidAt: null };
  }
  throw new Error("efi charge in unknown status");
}

function parseCob(body: unknown): Cob {
  const parsed = Cob.safeParse(body);
  if (!parsed.success) throw new Error("efi returned an unexpected charge body");
  return parsed.data;
}

export const efiProvider: PaymentProvider = {
  name: "efi",

  async createCharge(req: ChargeRequest): Promise<Charge> {
    const c = credentialsFor(req.accountRef);
    const txid = txidFor(req.paymentId);
    const expiracao = Math.max(60, Math.floor((req.expiresAt.getTime() - Date.now()) / 1000));
    const put = await efiCall(c, "PUT", `/v2/cob/${txid}`, {
      calendario: { expiracao },
      valor: { original: centsToReais(req.amountCents) },
      chave: c.pix_key,
      solicitacaoPagador: req.description,
    });
    let cob: Cob;
    if (is2xx(put.status)) cob = parseCob(put.body);
    else if (put.status === 409) {
      const got = await efiCall(c, "GET", `/v2/cob/${txid}`);
      if (!is2xx(got.status)) throw new Error(`efi cob failed: ${got.status}`);
      cob = parseCob(got.body);
    } else throw new Error(`efi cob failed: ${put.status}`);
    if (cob.valor.original !== centsToReais(req.amountCents)) throw new Error("efi charge amount differs");

    if (req.platformFeeBps > 0) {
      const link = await efiCall(c, "PUT", `/v2/gn/split/cob/${txid}/vinculo/${splitConfigIdFor(req.schoolId)}`);
      if (!is2xx(link.status)) throw new Error(`efi split link failed: ${link.status}`);
    }
    return toCharge(cob);
  },

  async getCharge(chargeId: string, accountRef: string | null): Promise<Charge> {
    const res = await efiCall(credentialsFor(accountRef), "GET", `/v2/cob/${chargeId}`);
    if (!is2xx(res.status)) throw new Error(`efi cob lookup failed: ${res.status}`);
    return toCharge(parseCob(res.body));
  },

  /** A Efí não assina a notificação: exige o token da URL e confirma cada cobrança consultando a própria Efí. */
  async parseWebhook({ query, rawBody, secret, accountRef }: WebhookInput): Promise<WebhookEvent[]> {
    if (!safeEqual(query.token ?? "", secret)) throw new DomainError("invalid_signature");
    let parsed: z.infer<typeof Notification>;
    try {
      parsed = Notification.parse(JSON.parse(rawBody));
    } catch {
      throw new DomainError("validation_failed");
    }
    const events: WebhookEvent[] = [];
    for (const item of parsed.pix ?? []) {
      if (!item.txid) {
        events.push({ eventId: item.endToEndId, kind: "ignored", chargeId: null });
        continue;
      }
      const charge = await this.getCharge(item.txid, accountRef);
      events.push(
        charge.status === "paid" && charge.paidAt
          ? { eventId: item.endToEndId, kind: "charge_paid", chargeId: item.txid, amountCents: charge.amountCents, paidAt: charge.paidAt }
          : { eventId: item.endToEndId, kind: "ignored", chargeId: item.txid },
      );
    }
    return events;
  },
};
```

(Se o TypeScript reclamar de `this` dentro do objeto literal, chame `efiProvider.getCharge`.)

`registry.ts`: `if (name === "efi") return efiProvider;` antes da checagem do `fake`.

`config.ts`: os campos novos conforme as Interfaces.

`app.ts`: no `logger` padrão e no objeto recebido em `options.logger`, acrescente

```ts
serializers: {
  req: (req: { method: string; url: string; hostname?: string; ip?: string }) => ({
    method: req.method,
    url: req.url.split("?")[0],
    hostname: req.hostname,
    remoteAddress: req.ip,
  }),
},
```

(com `options.logger` objeto, faça `{ ...options.logger, serializers: { ...SERIALIZERS, ...(options.logger.serializers ?? {}) } }`; `true`/`false` ficam como estão).

`apps/api/src/cli/efiSetup.ts`: siga o estilo de `cli/createSchool.ts` (validação de argumentos, `config()`, `closeDb()` no fim, `process.exitCode = 1` em erro) e a regra 10.

`docs/deploy.md` ganha a seção "Efí (Pix)", em português:
- `PAYMENT_PROVIDER=efi`, `EFI_ENV` (`homologacao` até o piloto; `production` depois), `EFI_PLATFORM_ACCOUNT` (conta Efí da plataforma que recebe o split).
- Por escola: segredo JSON de credenciais (`client_id`, `client_secret`, `pix_key`, `certificate_p12_base64` = certificado `.p12` em base64, `certificate_passphrase` se houver) mapeado numa variável cujo nome vai em `schools.payment_account_ref`; segredo do webhook (`openssl rand -hex 32`) numa variável cujo nome vai em `schools.payment_webhook_secret_ref`.
- Escopos que a aplicação da escola precisa ter no painel Efí: `cob.write`, `cob.read`, `pix.read`, `webhook.write`, `webhook.read`, `gn.split.write`, `gn.split.read`.
- Depois do deploy: `pnpm --filter @app-lanche/api cli:efi-setup <school_id> <URL do Cloud Run>` (registra o webhook com `x-skip-mtls-checking` e cria o split).
- Checklist de homologação (itens não confirmados em `docs/efi-pix.md`): criar cobrança e pagar no ambiente de homologação; conferir que o webhook chega com `?token=…&ignorar=/pix`; repetir o PUT do mesmo txid (espera-se 409 ou 2xx); conferir o split vinculado; conferir a senha do `.p12`.

- [ ] **Step 3: Rodar e ver passar; commit**

Run: os testes do Step 1 → PASS. Depois `pnpm typecheck && pnpm lint && pnpm test`.

```bash
git add apps/api docs/efi-pix.md docs/deploy.md
git commit -m "feat(api): add Efí Pix provider with mTLS client, verified webhook and platform split"
```

---

## Fora desta fase

- Validação do adaptador Efí em homologação com conta e certificado reais (checklist em `docs/deploy.md`, Task 13).
- Rotas internas do n8n (`schedule/due`, `reminders/*`, `service-days/*/close` interno, `magic-links`), dispatcher da outbox e fechamento de segurança pelo Cloud Scheduler — F3 (reutilizam `closeServiceDay`).
- Job de conciliação a cada 5 min — F6 (reutiliza `reconcileServiceDay`/`confirmPayment`).
- Reembolso em dinheiro com OTP — fase da reverificação do responsável.
- Limpeza de `idempotency_keys` antigas — F6 (retenção).
