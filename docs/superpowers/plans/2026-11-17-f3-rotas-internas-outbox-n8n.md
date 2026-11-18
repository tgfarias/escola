# F3 — Rotas internas, outbox e fluxos n8n — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O n8n passa a enviar lembretes com magic link, fechar o dia no `freeze_at` e entregar por WhatsApp/e-mail os eventos da outbox, com um fechamento de segurança e um dispatcher que não dependem do n8n.

**Architecture:** As rotas `/internal/v1/**` (HMAC, spec 6.1) expõem a agenda (`list_due_actions()`), a preparação de lembretes por página, o registro de entregas, o fechamento/romaneio (reuso de `closeServiceDay`) e a emissão avulsa de magic link com validade calculada pelo banco. Um dispatcher em `modules/outbox` lista escolas com eventos pendentes por uma função `SECURITY DEFINER`, reserva eventos com `FOR UPDATE SKIP LOCKED`, faz `POST` assinado no n8n fora de transação e registra entrega/backoff; é acionado logo após o commit (gancho `afterCommit`) e por Cloud Scheduler em rotas `/jobs/v1/**`. Os fluxos n8n são Code nodes gerados a partir de arquivos JS versionados e testados contra a API real.

**Tech Stack:** Fastify 5, Kysely + `pg`, PostgreSQL 16 (RLS), zod 4, Vitest + Testcontainers, `fetch`/`node:http`/`node:crypto` nativos, n8n (Code node v2, Webhook v2, IF v1, Send Email v2.1).

**Spec:** `docs/superpowers/specs/2026-11-16-app-lanche-design.md` (seções 3, 4.1, 4.4, 5.6, 6, 12, 14)

## Global Constraints

- Todo acesso ao banco dentro de `withTenant(schoolId, async (trx) => …)`; `school_id` vem da sessão ou do caminho de rota autenticada por segredo (HMAC interno, token de job, token de webhook), nunca do corpo/query/header.
- As únicas consultas sem tenant são funções `SECURITY DEFINER` (spec 4.4). Esta fase cria exatamente duas: `list_due_actions()` e `list_schools_with_pending_events()`. `search_path` fixado em `pg_catalog, public, pg_temp`; `REVOKE ALL … FROM PUBLIC`; `GRANT EXECUTE … TO app_user`. Elas são chamadas com `getDb()` só a partir de `repo.ts`, como as `resolve_*` da F1.
- Toda tabela nova: `school_id uuid NOT NULL`, RLS `tenant_isolation`, `UNIQUE (school_id, id)`, FKs compostas `(school_id, …)`; entra em `TENANT_TABLES` (ordem alfabética) e em `seedTenant`.
- Rotas `/internal/v1/**` declaram `auth: "internal"` (token de serviço + HMAC com timestamp, plugin de `platform/hmac`). Rotas `/jobs/v1/**` declaram `auth: "job"`. O vínculo prefixo ↔ `auth` é verificado no `onRoute`.
- Transição de estado é `UPDATE … WHERE status = '<anterior>'`; zero linhas = já feito, sem erro. Deduplicação por `UNIQUE` + `ON CONFLICT DO NOTHING`, nunca `SELECT` seguido de `INSERT`.
- A única fonte de tempo para regra de negócio é o banco (`now()`): vencimento de magic link, agenda, backoff, abandono após 24 h e OTP vencido são calculados em SQL.
- Efeito externo só a partir de `outbox_events`. Chamada HTTP ao n8n acontece fora de transação de banco.
- Após entregar um `auth.otp_requested`, o `data` do evento vira `{}`. Um OTP vencido ou um evento com mais de 24 h nunca é enviado: é abandonado (`failed_at`) e, se for OTP, também tem o `data` apagado.
- Logs só com ids internos e códigos de status: nunca telefone, e-mail, nome, token, OTP, link, corpo de evento ou de resposta do n8n/WhatsApp.
- Mensagens usam só primeiro nome (spec 4.5). Corpos trocados com o n8n em `snake_case`.
- Erros de domínio: `DomainError(code)`; código novo entra em `packages/contracts/src/errors.ts` e no `STATUS` de `apps/api/src/platform/errors.ts` no mesmo commit (esta fase não prevê código novo).
- Mudou um contrato? Schema em `packages/contracts`, exemplo na spec e fixture de teste no mesmo commit (CLAUDE.md regra 23).
- Texto de interface/mensagem em português do Brasil; código, nomes e commits em inglês.
- Não adicione dependência. Não edite migração aplicada (0001–0006); esta fase cria a `0007`.
- Regra de negócio nova tem teste de integração com banco real; sem mock de banco. Testes rodam em paralelo por arquivo no mesmo banco: um teste nunca executa um job que percorre **todas** as escolas (dispatcher global, fechamento de segurança global); usa o filtro `schoolIds` ou espiona o serviço na rota.
- Antes de cada commit: `pnpm typecheck && pnpm lint` e os testes do pacote tocado.

## Decisões da fase (o executor não reabre)

1. **`school_id` no caminho das rotas internas.** A spec 6.2 mostrava `school_id` no corpo de `reminders/prepare` e `magic-links`, contrariando a 4.4 e a regra 2 do CLAUDE.md. Os caminhos passam a ser `POST /internal/v1/schools/{school_id}/reminders/prepare`, `POST /internal/v1/schools/{school_id}/reminders/{batch_id}/deliveries` e `POST /internal/v1/schools/{school_id}/magic-links`; os corpos são `strict()` (um `school_id` no corpo é recusado com 400). `close` e `manifest` mantêm os caminhos da spec.
2. **Rotas internas são naturalmente idempotentes.** `prepare` reutiliza o lote `(school_id, service_date)` e pula quem já está `sent`; `deliveries` é `UPDATE` por `(batch_id, guardian_id)`; `close` devolve o mesmo romaneio; `magic-links` emite um link novo e reutilizável. Guardar a resposta em `idempotency_keys` gravaria tokens de magic link em claro. O n8n envia `Idempotency-Key` (spec 6.1) e a API o ignora.
3. **Lembrete vence em `cutoff_at - schools.reminder_lead_minutes`** (coluna nova, padrão 720 = 12 h antes do corte, entre 30 e 2880). Sai da agenda quando o lote do dia tem `completed_at` (última página servida), quando o corte passa ou quando o dia fecha.
4. **`list_due_actions()` não recebe parâmetro**: usa `now()` do banco (regra 15). Devolve `(action, school_id, service_date, overdue)`; `overdue = now() >= cutoff_at + 10 min` alimenta o fechamento de segurança e não sai na rota do n8n.
5. **Magic link com validade do banco.** `createMagicLink` deixa de receber `expiresAt`: escopo `order` vale até o `cutoff_at` do dia (que precisa estar `open` e antes do corte, senão `cutoff_passed`), escopo `documents` vale `now() + 7 days`. `order` exige `service_date`; `documents` não aceita.
6. **Jobs do Cloud Scheduler em `/jobs/v1/**`** com `X-Job-Token` comparado em tempo constante com `JOBS_TOKEN` (≥ 32 caracteres, obrigatório). O Cloud Scheduler não calcula HMAC com timestamp, e verificar OIDC exigiria dependência nova. As rotas só fazem o que o próprio agendador faria (despachar a outbox, fechar dias vencidos), então um replay do token não causa dano além de antecipar o trabalho.
7. **Disparo imediato da outbox** por `afterCommit(trx, fn)` em `db/index.ts`: `enqueueEvent` registra um "kick" da escola que roda depois do commit, sem bloquear a resposta. É melhor esforço; o job de 1 min garante a entrega.
8. **Dispatcher:** lotes de 50 com `FOR UPDATE SKIP LOCKED` e arrendamento (`next_attempt_at = now() + 2 min`) antes do HTTP; sucesso = resposta 2xx do n8n; falha → `attempts + 1`, `next_attempt_at = now() + min(2^min(attempts, 6) min, 60 min)`; evento com mais de 24 h vira `failed_at`. Sem `N8N_EVENTS_URL` configurado, o dispatcher não faz nada (desenvolvimento) e os eventos ficam pendentes.
9. **Assinatura Node → n8n:** mesmos `X-Timestamp`/`X-Signature` da spec 6.1, segredo `N8N_HMAC_SECRET`, caminho = `pathname + search` de `N8N_EVENTS_URL`.
10. **`cutoff_local_time`** (`"07:30"`, no fuso da escola, calculado no banco) entra em cada destinatário de `prepare`, para o n8n não formatar hora em outro fuso.
11. **Fluxos n8n são Code nodes** com o código em `n8n/code/*.js`; `n8n/build.mjs` gera `jsCode = lib.js + "\n" + <arquivo>` em cada nó marcado com `"notes": "code:<arquivo>"`. Um teste garante que o JSON está em dia e executa os Code nodes contra a API real (via `app.inject`) com o WhatsApp simulado.
12. **Mensagens de WhatsApp** usam modelos aprovados (Cloud API, `type: "template"`, idioma `pt_BR`), com nomes vindos de variáveis de ambiente do n8n; o link vai como parâmetro de texto do corpo. Parâmetro de modelo não tem quebra de linha. OTP por e-mail sai pelo nó Send Email (SMTP do n8n). Eventos de e-mail não entram na deduplicação do n8n (código repetido é inofensivo).
13. **O resumo da cozinha** vai só quando o fechamento é feito pelo fluxo do n8n (resposta do `close`), como na spec. Se o fechamento de segurança fechar antes, não há resumo; o KDS é o canal principal.

---

## Mapa de arquivos

```
db/migrations/0007_reminders_outbox_dispatch.sql     (Task 1)
apps/api/src/db/index.ts                              afterCommit (Task 6)
apps/api/src/db/types.ts                              regenerado (Task 1)
apps/api/src/db/rls.test.ts · schema.test.ts          (Task 1)
apps/api/test/helpers.ts                              seedTenant, internalRequest (Tasks 1, 2)
apps/api/src/platform/config.ts (+test)               JOBS_TOKEN, N8N_* (Task 5)
apps/api/src/platform/jobAuth.ts (+test)              X-Job-Token (Task 6)
apps/api/src/platform/outbox.ts (+test)               kick após commit (Task 6)
apps/api/src/app.ts                                   auth "job", rotas novas, kick handler (Tasks 2, 6)
apps/api/src/modules/auth/{magicLink,repo,service}.ts validade pelo banco, issueMagicLink (Task 2)
apps/api/src/modules/internal/routes.ts (+tests)      rotas do n8n (Tasks 2, 3, 4)
apps/api/src/modules/serviceDays/{repo,service}.ts    listDueActions, safetyClose (Tasks 3, 6)
apps/api/src/modules/reminders/{repo,service}.ts      prepare, deliveries (Task 4)
apps/api/src/modules/outbox/{repo,service}.ts (+test) dispatcher (Task 5)
apps/api/src/modules/jobs/routes.ts (+test)           rotas do Cloud Scheduler (Task 6)
apps/api/test/n8n.test.ts                             fluxos n8n (Task 7)
packages/contracts/src/internal.ts (+test)            contratos n8n e jobs (Tasks 2–6)
n8n/code/{lib,schedule,events}.js · n8n/build.mjs · n8n/workflows/*.json   (Task 7)
docs/n8n.md · docs/deploy.md · spec                   (Tasks 2, 6, 7)
```

---

### Task 1: Migração 0007 — lotes de lembrete, entregas, abandono de evento e funções de agenda

**Files:**
- Create: `db/migrations/0007_reminders_outbox_dispatch.sql`
- Regenerate: `apps/api/src/db/types.ts`
- Modify: `apps/api/src/db/rls.test.ts` (`TENANT_TABLES`)
- Modify: `apps/api/src/db/schema.test.ts`
- Modify: `apps/api/test/helpers.ts` (`SeedIds`, `seedTenant`)

**Interfaces:**
- Produces: tabelas `reminder_batches (id, school_id, service_date, completed_at, created_at)` e `message_deliveries (id, school_id, batch_id, guardian_id, status 'prepared'|'sent'|'failed', wa_message_id, error, updated_at)`; colunas `schools.reminder_lead_minutes integer` e `outbox_events.failed_at timestamptz`; funções `list_due_actions() → (action text, school_id uuid, service_date date, overdue boolean)` e `list_schools_with_pending_events() → (school_id uuid)`; tipos Kysely `ReminderBatches`, `MessageDeliveries`.
- Produces: `SeedIds` ganha `reminderBatchId` (lote do dia `2099-12-31`, `completed_at` preenchido).

- [ ] **Step 1: Escrever os testes de esquema (falham)**

Em `apps/api/src/db/rls.test.ts`, `TENANT_TABLES` passa a incluir, em ordem alfabética, `"message_deliveries"` (depois de `"menu_items"`) e `"reminder_batches"` (depois de `"payments"`).

Acrescente em `apps/api/src/db/schema.test.ts`:

```ts
describe("F3 schema", () => {
  it("pins the search_path of the F3 security definer functions and keeps them away from PUBLIC", async () => {
    const { rows } = await sql<{ proname: string; proconfig: string[]; prosecdef: boolean; publicExec: boolean }>`
      SELECT proname, proconfig, prosecdef,
             has_function_privilege('public', oid, 'EXECUTE') AS public_exec
      FROM pg_proc
      WHERE proname IN ('list_due_actions', 'list_schools_with_pending_events') ORDER BY proname`.execute(adminDb());
    expect(rows).toEqual([
      { proname: "list_due_actions", proconfig: ["search_path=pg_catalog, public, pg_temp"], prosecdef: true, publicExec: false },
      { proname: "list_schools_with_pending_events", proconfig: ["search_path=pg_catalog, public, pg_temp"], prosecdef: true, publicExec: false },
    ]);
  });

  it("lets the application role update but never delete reminder rows", async () => {
    const { rows } = await sql<{ table: string; update: boolean; del: boolean }>`
      SELECT t AS table,
             has_table_privilege('app_user', t, 'UPDATE') AS update,
             has_table_privilege('app_user', t, 'DELETE') AS del
      FROM unnest(ARRAY['reminder_batches', 'message_deliveries']) AS t ORDER BY t`.execute(adminDb());
    expect(rows).toEqual([
      { table: "message_deliveries", update: true, del: false },
      { table: "reminder_batches", update: true, del: false },
    ]);
  });

  it("restricts a delivery error to a short code", async () => {
    const schoolId = await createSchool();
    const seed = await seedTenant(schoolId);
    await expect(
      adminDb()
        .insertInto("messageDeliveries")
        .values({ id: uuidv7(), schoolId, batchId: seed.reminderBatchId, guardianId: seed.guardianId, status: "failed", error: "Número +55 11 inválido" })
        .execute(),
    ).rejects.toThrow(/check/i);
  });

  it("lists due reminders and closes by the database clock", async () => {
    const schoolId = await createSchool();
    await adminDb().updateTable("schools").set({ reminderLeadMinutes: 120 }).where("id", "=", schoolId).execute();
    await seedServiceDay(schoolId, { serviceDate: "2031-01-06", cutoffInMinutes: 60 }); // reminder window open
    await seedServiceDay(schoolId, { serviceDate: "2031-01-07", cutoffInMinutes: 600 }); // too early to remind
    await seedServiceDay(schoolId, { serviceDate: "2031-01-08", cutoffInMinutes: -7 }); // freeze passed, not overdue
    await seedServiceDay(schoolId, { serviceDate: "2031-01-09", cutoffInMinutes: -11 }); // overdue
    const { rows } = await sql<{ action: string; serviceDate: string; overdue: boolean }>`
      SELECT action, service_date, overdue FROM list_due_actions() WHERE school_id = ${schoolId}
      ORDER BY service_date, action`.execute(getDb());
    expect(rows).toEqual([
      { action: "send_reminders", serviceDate: "2031-01-06", overdue: false },
      { action: "close_service_day", serviceDate: "2031-01-08", overdue: false },
      { action: "close_service_day", serviceDate: "2031-01-09", overdue: true },
    ]);
  });

  it("drops reminders from the agenda once the batch is completed", async () => {
    const schoolId = await createSchool();
    await seedServiceDay(schoolId, { serviceDate: "2031-02-03", cutoffInMinutes: 60 });
    await adminDb()
      .insertInto("reminderBatches")
      .values({ id: uuidv7(), schoolId, serviceDate: "2031-02-03", completedAt: new Date() })
      .execute();
    const { rows } = await sql`SELECT 1 FROM list_due_actions() WHERE school_id = ${schoolId}`.execute(getDb());
    expect(rows).toHaveLength(0);
  });

  it("lists only schools with events ready to send", async () => {
    const ready = await createSchool();
    const later = await createSchool();
    const done = await createSchool();
    const insert = (schoolId: string, extra: Record<string, unknown>) =>
      adminDb().insertInto("outboxEvents").values({ id: uuidv7(), schoolId, type: "t", data: "{}", ...extra }).execute();
    await insert(ready, {});
    await insert(later, { nextAttemptAt: sql`now() + interval '1 hour'` });
    await insert(done, { deliveredAt: new Date() });
    await insert(done, { failedAt: new Date() });
    const { rows } = await sql<{ schoolId: string }>`SELECT school_id FROM list_schools_with_pending_events()`.execute(getDb());
    const ids = rows.map((r) => r.schoolId);
    expect(ids).toContain(ready);
    expect(ids).not.toContain(later);
    expect(ids).not.toContain(done);
  });
});
```

Imports necessários no topo do arquivo (acrescente os que faltarem): `sql` de `kysely`, `uuidv7` de `uuidv7`, `getDb` de `../db/index` (ou `./index`, conforme o arquivo), e `adminDb, createSchool, seedServiceDay, seedTenant` de `../../test/helpers`.

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm --filter @app-lanche/api test -- src/db`
Expected: FAIL (tabelas e funções inexistentes).

- [ ] **Step 3: Escrever a migração**

`db/migrations/0007_reminders_outbox_dispatch.sql`:

```sql
-- F3: lembretes, entregas de mensagem, abandono de evento da outbox e agenda (spec 4.4, 6.2, 6.3).

ALTER TABLE schools ADD COLUMN reminder_lead_minutes integer NOT NULL DEFAULT 720
  CHECK (reminder_lead_minutes BETWEEN 30 AND 2880);

-- Evento abandonado (mais de 24 h sem entrega, ou OTP vencido): nunca mais é enviado.
ALTER TABLE outbox_events ADD COLUMN failed_at timestamptz;
ALTER TABLE outbox_events ADD CHECK (delivered_at IS NULL OR failed_at IS NULL);
DROP INDEX outbox_events_pending;
CREATE INDEX outbox_events_pending ON outbox_events (school_id, next_attempt_at)
  WHERE delivered_at IS NULL AND failed_at IS NULL;

CREATE TABLE reminder_batches (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  service_date date NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, service_date)
);

CREATE TABLE message_deliveries (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  batch_id uuid NOT NULL,
  guardian_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared', 'sent', 'failed')),
  wa_message_id text CHECK (length(wa_message_id) BETWEEN 1 AND 200),
  error text CHECK (error ~ '^[a-z0-9_]{1,64}$'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, batch_id, guardian_id),
  FOREIGN KEY (school_id, batch_id) REFERENCES reminder_batches (school_id, id),
  FOREIGN KEY (school_id, guardian_id) REFERENCES guardians (school_id, id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['reminder_batches', 'message_deliveries']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (school_id = app_school_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO app_user', t);
  END LOOP;
END $$;

-- Agenda do n8n e do fechamento de segurança (spec 4.4). Usa o relógio do banco.
CREATE FUNCTION list_due_actions()
RETURNS TABLE (action text, school_id uuid, service_date date, overdue boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT 'send_reminders'::text, d.school_id, d.service_date, false
  FROM service_days d JOIN schools s ON s.id = d.school_id
  WHERE d.status = 'open'
    AND now() >= d.cutoff_at - make_interval(mins => s.reminder_lead_minutes)
    AND now() < d.cutoff_at
    AND NOT EXISTS (
      SELECT 1 FROM reminder_batches b
      WHERE b.school_id = d.school_id AND b.service_date = d.service_date AND b.completed_at IS NOT NULL)
  UNION ALL
  SELECT 'close_service_day'::text, d.school_id, d.service_date, now() >= d.cutoff_at + interval '10 minutes'
  FROM service_days d
  WHERE d.status = 'open' AND now() >= d.freeze_at
  ORDER BY 3, 2, 1
$$;

-- Quinta consulta sem tenant (spec 6.3): o dispatcher não enxerga a outbox sob RLS sem saber a escola.
CREATE FUNCTION list_schools_with_pending_events()
RETURNS TABLE (school_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT DISTINCT o.school_id FROM outbox_events o
  WHERE o.delivered_at IS NULL AND o.failed_at IS NULL AND o.next_attempt_at <= now()
$$;

REVOKE ALL ON FUNCTION list_due_actions() FROM PUBLIC;
REVOKE ALL ON FUNCTION list_schools_with_pending_events() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_due_actions() TO app_user;
GRANT EXECUTE ON FUNCTION list_schools_with_pending_events() TO app_user;
```

- [ ] **Step 4: Semente e tipos**

Rode a migração e regenere os tipos (comandos no `common-context.md` do workspace; `pnpm db:types` com o banco local migrado). Confira em `types.ts`: `ReminderBatches.serviceDate: string`, `Schools.reminderLeadMinutes`, `OutboxEvents.failedAt`.

Em `apps/api/test/helpers.ts`: `SeedIds` ganha `reminderBatchId: string`; em `seedTenant`, depois do bloco de `idempotencyKeys`:

```ts
  ids.reminderBatchId = uuidv7();
  await db
    .insertInto("reminderBatches")
    .values({ id: ids.reminderBatchId, schoolId, serviceDate: ids.serviceDate, completedAt: new Date() })
    .execute();
  await db
    .insertInto("messageDeliveries")
    .values({ id: uuidv7(), schoolId, batchId: ids.reminderBatchId, guardianId: ids.guardianId, status: "sent", waMessageId: "wamid.seed" })
    .execute();
```

(inicialize `reminderBatchId: ""` no literal de `ids` ou gere o uuid já no literal — o tipo não pode ficar opcional.)

- [ ] **Step 5: Rodar e ver passar**

Run: `pnpm --filter @app-lanche/api test -- src/db && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add db/migrations/0007_reminders_outbox_dispatch.sql apps/api/src/db apps/api/test/helpers.ts
git commit -m "feat(db): add reminder batches, deliveries and the agenda functions"
```

---

### Task 2: Magic link com validade do banco e rota interna de emissão

**Files:**
- Modify: `apps/api/src/modules/auth/magicLink.ts`, `apps/api/src/modules/auth/repo.ts`, `apps/api/src/modules/auth/service.ts`
- Modify: `apps/api/src/modules/auth/magicLink.test.ts`, `apps/api/src/modules/auth/guardianAuth.test.ts` (e qualquer outro chamador de `createMagicLink`)
- Create: `packages/contracts/src/internal.ts`, `packages/contracts/src/internal.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `apps/api/src/modules/internal/routes.ts`, `apps/api/src/modules/internal/magicLinks.test.ts`
- Modify: `apps/api/src/app.ts` (registrar `internalRoutes`)
- Modify: `apps/api/test/helpers.ts` (`internalRequest`)
- Modify: spec 6.2 (caminhos com `school_id`) e 14 (pendência resolvida)

**Interfaces:**
- Consumes: `generateToken`, `hashToken` (`auth/tokens.ts`); `signInternal` (`platform/hmac.ts`).
- Produces: `createMagicLink(trx, { schoolId, guardianId, scope: GuardianScope, serviceDate?: string }): Promise<{ url: string; expiresAt: Date }>` (lança `DomainError("cutoff_passed")` quando o escopo `order` não tem dia aberto antes do corte); exportado também por `auth/service.ts`.
- Produces: `issueMagicLink(schoolId: string, body: InternalMagicLinkRequest): Promise<InternalMagicLinkResponse>` em `auth/service.ts`.
- Produces: `internalRoutes(app)` em `modules/internal/routes.ts`, onde as Tasks 3 e 4 acrescentam rotas.
- Produces (contracts): `InternalMagicLinkRequest`, `InternalMagicLinkResponse`.
- Produces (test helper): `internalRequest(method: "GET" | "POST", url: string, payload?: unknown): InjectOptions`.

- [ ] **Step 1: Contrato e fixture (falham)**

`packages/contracts/src/internal.ts`:

```ts
import { z } from "zod";
import { IsoDate, IsoDateTime, Uuid } from "./common";

/** POST /internal/v1/schools/{school_id}/magic-links (spec 6.2). */
export const InternalMagicLinkRequest = z
  .object({
    guardian_id: Uuid,
    scope: z.enum(["order", "documents"]),
    service_date: IsoDate.optional(),
  })
  .strict()
  .refine((b) => (b.scope === "order") === (b.service_date !== undefined), {
    message: "service_date is required for order links and not allowed for document links",
  });
export type InternalMagicLinkRequest = z.infer<typeof InternalMagicLinkRequest>;

export const InternalMagicLinkResponse = z.object({
  link_url: z.string().url(),
  expires_at: IsoDateTime,
});
export type InternalMagicLinkResponse = z.infer<typeof InternalMagicLinkResponse>;
```

Acrescente `export * from "./internal";` em `packages/contracts/src/index.ts` (ordem alfabética).

`packages/contracts/src/internal.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { InternalMagicLinkRequest, InternalMagicLinkResponse } from "./internal";

const G = "0193a3b0-0000-7000-8000-000000000001";

describe("internal contracts", () => {
  it("accepts the magic-link examples from spec 6.2", () => {
    const req = { guardian_id: G, scope: "order", service_date: "2026-11-17" };
    expect(InternalMagicLinkRequest.parse(req)).toEqual(req);
    const res = { link_url: "https://app.example/l#Zk3", expires_at: "2026-11-17T07:30:00-03:00" };
    expect(InternalMagicLinkResponse.parse(res)).toEqual(res);
  });

  it("rejects a school_id in the body and a date on document links", () => {
    expect(() => InternalMagicLinkRequest.parse({ school_id: G, guardian_id: G, scope: "order", service_date: "2026-11-17" })).toThrow();
    expect(() => InternalMagicLinkRequest.parse({ guardian_id: G, scope: "documents", service_date: "2026-11-17" })).toThrow();
    expect(() => InternalMagicLinkRequest.parse({ guardian_id: G, scope: "order" })).toThrow();
  });
});
```

Run: `pnpm --filter @app-lanche/contracts test` → FAIL; implemente e rode até PASS.

- [ ] **Step 2: Testes do magic link com validade do banco (falham)**

Reescreva `apps/api/src/modules/auth/magicLink.test.ts` para a nova assinatura:

```ts
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { adminDb, createSchool, seedServiceDay, seedTenant } from "../../../test/helpers";
import { withTenant } from "../../db/index";
import { createMagicLink } from "./magicLink";
import { hashToken } from "./tokens";

describe("createMagicLink", () => {
  it("returns a URL with the token in the fragment and stores only its hash", async () => {
    const schoolId = await createSchool();
    const seed = await seedTenant(schoolId);
    const day = await seedServiceDay(schoolId, { cutoffInMinutes: 60 });
    const link = await withTenant(schoolId, (trx) =>
      createMagicLink(trx, { schoolId, guardianId: seed.guardianId, scope: "order", serviceDate: day.serviceDate }),
    );
    expect(link.url.startsWith("https://app.test/l#")).toBe(true);
    const token = link.url.split("#")[1]!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = await adminDb().selectFrom("magicLinks").selectAll().where("tokenHash", "=", hashToken(token)).executeTakeFirstOrThrow();
    expect(row.guardianId).toBe(seed.guardianId);
    expect(row.scope).toBe("order");
    const all = await adminDb().selectFrom("magicLinks").select("tokenHash").where("schoolId", "=", schoolId).execute();
    expect(all.some((r) => r.tokenHash === token)).toBe(false);
  });

  it("expires an order link at the cutoff of its day", async () => {
    const schoolId = await createSchool();
    const seed = await seedTenant(schoolId);
    const day = await seedServiceDay(schoolId, { cutoffInMinutes: 90 });
    const link = await withTenant(schoolId, (trx) =>
      createMagicLink(trx, { schoolId, guardianId: seed.guardianId, scope: "order", serviceDate: day.serviceDate }),
    );
    const cutoff = await adminDb().selectFrom("serviceDays").select("cutoffAt").where("id", "=", day.serviceDayId).executeTakeFirstOrThrow();
    expect(link.expiresAt.getTime()).toBe(cutoff.cutoffAt.getTime());
  });

  it("expires a documents link seven days after now() of the database", async () => {
    const schoolId = await createSchool();
    const seed = await seedTenant(schoolId);
    const link = await withTenant(schoolId, (trx) =>
      createMagicLink(trx, { schoolId, guardianId: seed.guardianId, scope: "documents" }),
    );
    const { rows } = await sql<{ diff: number }>`
      SELECT extract(epoch FROM (${link.expiresAt}::timestamptz - (now() + interval '7 days')))::float8 AS diff`.execute(adminDb());
    expect(Math.abs(rows[0]!.diff)).toBeLessThan(60);
  });

  it("refuses an order link after the cutoff, for a closed day or for a missing day", async () => {
    const schoolId = await createSchool();
    const seed = await seedTenant(schoolId);
    const past = await seedServiceDay(schoolId, { serviceDate: "2031-03-03", cutoffInMinutes: -1 });
    const closed = await seedServiceDay(schoolId, { serviceDate: "2031-03-04", cutoffInMinutes: 60 });
    await adminDb().updateTable("serviceDays").set({ status: "closed", closedAt: new Date() }).where("id", "=", closed.serviceDayId).execute();
    for (const serviceDate of [past.serviceDate, closed.serviceDate, "2031-03-05"]) {
      await expect(
        withTenant(schoolId, (trx) => createMagicLink(trx, { schoolId, guardianId: seed.guardianId, scope: "order", serviceDate })),
      ).rejects.toMatchObject({ code: "cutoff_passed" });
    }
  });

  it("generates a different token each time", async () => {
    const schoolId = await createSchool();
    const seed = await seedTenant(schoolId);
    const day = await seedServiceDay(schoolId, { cutoffInMinutes: 60 });
    const input = { schoolId, guardianId: seed.guardianId, scope: "order" as const, serviceDate: day.serviceDate };
    const [a, b] = await withTenant(schoolId, async (trx) => [await createMagicLink(trx, input), await createMagicLink(trx, input)]);
    expect(a.url).not.toBe(b.url);
  });
});
```

Em `guardianAuth.test.ts` (e em qualquer outro chamador encontrado com `grep -rn createMagicLink apps/api/src`): troque as chamadas para a nova assinatura criando antes um dia aberto (`seedServiceDay(schoolId, { cutoffInMinutes: 60 })`, com `serviceDate` distinto por teste quando o mesmo teste já cria outro dia). Teste que precisa de link **vencido** passa a inserir a linha direto com `adminDb().insertInto("magicLinks")` e `expiresAt` no passado (o token em claro vem de `generateToken()`, a coluna recebe `hashToken(token)`). Não mude o que esses testes verificam.

Run: `pnpm --filter @app-lanche/api test -- src/modules/auth` → FAIL.

- [ ] **Step 3: Implementar a validade pelo banco**

`apps/api/src/modules/auth/repo.ts` — substitua `insertMagicLink`:

```ts
/** Grava o link com a validade calculada pelo banco; undefined quando não há dia aberto antes do corte. */
export async function insertMagicLink(
  trx: Trx,
  row: {
    id: string;
    schoolId: string;
    guardianId: string;
    tokenHash: string;
    scope: "order" | "documents";
    serviceDate: string | null;
  },
): Promise<Date | undefined> {
  const { rows } = await sql<{ expiresAt: Date }>`
    INSERT INTO magic_links (id, school_id, guardian_id, token_hash, scope, service_date, expires_at)
    SELECT ${row.id}::uuid, ${row.schoolId}::uuid, ${row.guardianId}::uuid, ${row.tokenHash}::text, ${row.scope}::text,
           ${row.serviceDate}::date, e.expires_at
    FROM (
      SELECT CASE
        WHEN ${row.scope}::text = 'documents' THEN now() + interval '7 days'
        ELSE (SELECT d.cutoff_at FROM service_days d
              WHERE d.service_date = ${row.serviceDate}::date AND d.status = 'open' AND d.cutoff_at > now())
      END AS expires_at
    ) e
    WHERE e.expires_at IS NOT NULL
    RETURNING expires_at`.execute(trx);
  return rows[0]?.expiresAt;
}

export async function guardianExists(trx: Trx, guardianId: string): Promise<boolean> {
  const row = await trx.selectFrom("guardians").select("id").where("id", "=", guardianId).executeTakeFirst();
  return row !== undefined;
}
```

`apps/api/src/modules/auth/magicLink.ts`:

```ts
import { uuidv7 } from "uuidv7";
import type { Trx } from "../../db/index";
import { config } from "../../platform/config";
import { DomainError } from "../../platform/errors";
import type { GuardianScope } from "../../platform/session";
import * as repo from "./repo";
import { generateToken, hashToken } from "./tokens";

/**
 * Cria um link reutilizável. A validade vem do banco: `order` até o corte do dia (aberto e antes do corte),
 * `documents` por 7 dias (spec 4.1).
 */
export async function createMagicLink(
  trx: Trx,
  input: { schoolId: string; guardianId: string; scope: GuardianScope; serviceDate?: string },
): Promise<{ url: string; expiresAt: Date }> {
  if ((input.scope === "order") !== (input.serviceDate !== undefined)) {
    throw new Error("order links need a service date and document links must not have one");
  }
  const token = generateToken();
  const expiresAt = await repo.insertMagicLink(trx, {
    id: uuidv7(),
    schoolId: input.schoolId,
    guardianId: input.guardianId,
    tokenHash: hashToken(token),
    scope: input.scope,
    serviceDate: input.serviceDate ?? null,
  });
  if (!expiresAt) throw new DomainError("cutoff_passed");
  return { url: `${config().appBaseUrl}/l#${token}`, expiresAt };
}
```

Em `apps/api/src/modules/auth/service.ts`, acrescente:

```ts
export { createMagicLink } from "./magicLink";

/** POST /internal/v1/schools/:school_id/magic-links — reenvio avulso pelo n8n. */
export async function issueMagicLink(
  schoolId: string,
  body: InternalMagicLinkRequest,
): Promise<InternalMagicLinkResponse> {
  return withTenant(schoolId, async (trx) => {
    if (!(await repo.guardianExists(trx, body.guardian_id))) throw new DomainError("not_found");
    const link = await createMagicLink(trx, {
      schoolId,
      guardianId: body.guardian_id,
      scope: body.scope,
      serviceDate: body.service_date,
    });
    return { link_url: link.url, expires_at: link.expiresAt.toISOString() };
  });
}
```

(importe `InternalMagicLinkRequest`/`InternalMagicLinkResponse` como tipos de `@app-lanche/contracts` e `createMagicLink` de `./magicLink` para uso local.)

- [ ] **Step 4: Helper de teste e teste da rota (falham)**

Em `apps/api/test/helpers.ts`:

```ts
import type { InjectOptions } from "fastify";
import { signInternal } from "../src/platform/hmac";

/** Requisição n8n → API assinada como na spec 6.1. */
export function internalRequest(method: "GET" | "POST", url: string, payload?: unknown): InjectOptions {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const timestamp = new Date().toISOString();
  return {
    method,
    url,
    headers: {
      authorization: `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}`,
      "x-timestamp": timestamp,
      "x-signature": signInternal(process.env.INTERNAL_HMAC_SECRET!, { method, path: url, timestamp, body }),
      "idempotency-key": crypto.randomUUID(),
      ...(body === "" ? {} : { "content-type": "application/json" }),
    },
    ...(body === "" ? {} : { payload: body }),
  };
}
```

`apps/api/src/modules/internal/magicLinks.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { adminDb, createSchool, internalRequest, seedServiceDay, seedTenant } from "../../../test/helpers";
import { buildApp } from "../../app";
import { hashToken } from "../auth/tokens";

describe("POST /internal/v1/schools/:school_id/magic-links", () => {
  it("issues an order link that expires at the cutoff", async () => {
    const schoolId = await createSchool();
    const seed = await seedTenant(schoolId);
    const day = await seedServiceDay(schoolId, { cutoffInMinutes: 60 });
    const res = await buildApp().inject(
      internalRequest("POST", `/internal/v1/schools/${schoolId}/magic-links`, {
        guardian_id: seed.guardianId,
        scope: "order",
        service_date: day.serviceDate,
      }),
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const token = body.link_url.split("#")[1];
    const row = await adminDb().selectFrom("magicLinks").select(["schoolId", "expiresAt"]).where("tokenHash", "=", hashToken(token)).executeTakeFirstOrThrow();
    expect(row.schoolId).toBe(schoolId);
    expect(new Date(body.expires_at).getTime()).toBe(row.expiresAt.getTime());
  });

  it("does not issue a link for a guardian of another school", async () => {
    const schoolA = await createSchool();
    const schoolB = await createSchool();
    const seedB = await seedTenant(schoolB);
    const res = await buildApp().inject(
      internalRequest("POST", `/internal/v1/schools/${schoolA}/magic-links`, { guardian_id: seedB.guardianId, scope: "documents" }),
    );
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("answers 409 cutoff_passed when the day is past its cutoff", async () => {
    const schoolId = await createSchool();
    const seed = await seedTenant(schoolId);
    const day = await seedServiceDay(schoolId, { cutoffInMinutes: -1 });
    const res = await buildApp().inject(
      internalRequest("POST", `/internal/v1/schools/${schoolId}/magic-links`, {
        guardian_id: seed.guardianId,
        scope: "order",
        service_date: day.serviceDate,
      }),
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("cutoff_passed");
  });

  it("rejects a school_id in the body and an unsigned request", async () => {
    const schoolId = await createSchool();
    const seed = await seedTenant(schoolId);
    const app = buildApp();
    const withSchool = await app.inject(
      internalRequest("POST", `/internal/v1/schools/${schoolId}/magic-links`, { school_id: uuidv7(), guardian_id: seed.guardianId, scope: "documents" }),
    );
    expect(withSchool.statusCode).toBe(400);
    const unsigned = await app.inject({
      method: "POST",
      url: `/internal/v1/schools/${schoolId}/magic-links`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ guardian_id: seed.guardianId, scope: "documents" }),
    });
    expect(unsigned.statusCode).toBe(401);
  });
});
```

Run: `pnpm --filter @app-lanche/api test -- src/modules/internal` → FAIL.

- [ ] **Step 5: Rotas internas**

`apps/api/src/modules/internal/routes.ts`:

```ts
import { InternalMagicLinkRequest, Uuid } from "@app-lanche/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import * as auth from "../auth/service";

/** Rotas chamadas pelo n8n (spec 6.2). A escola vem do caminho, autenticado pelo HMAC. */
export const INTERNAL = { config: { auth: "internal" as const } };
export const SchoolParams = z.object({ school_id: Uuid });

export async function internalRoutes(app: FastifyInstance): Promise<void> {
  app.post("/internal/v1/schools/:school_id/magic-links", INTERNAL, async (req) =>
    auth.issueMagicLink(SchoolParams.parse(req.params).school_id, InternalMagicLinkRequest.parse(req.body)),
  );
}
```

Em `app.ts`, `app.register(internalRoutes);` depois de `serviceDayRoutes`.

- [ ] **Step 6: Spec**

Na spec 6.2, troque os blocos de `reminders/prepare`, `deliveries` e `magic-links` para os novos caminhos (Decisão 1), removendo `school_id` dos corpos; acrescente uma linha: "A escola vem sempre do caminho, coberto pela assinatura HMAC; os corpos não aceitam `school_id`." Acrescente ao exemplo de destinatário de `prepare` o campo `"cutoff_local_time": "07:30"` (Decisão 10). Na seção 14, retire "criação de magic link com validade calculada pelo banco (`/internal/v1/magic-links` e lembretes, F3)" das pendências. Na 4.1, item 5, acrescente: "A validade é calculada pelo banco (`cutoff_at` do dia ou `now() + 7 dias`)."

- [ ] **Step 7: Rodar e commitar**

Run: `pnpm --filter @app-lanche/contracts test && pnpm --filter @app-lanche/api test -- src/modules/auth src/modules/internal && pnpm typecheck && pnpm lint`
Expected: PASS.

```bash
git add packages/contracts/src apps/api/src/modules/auth apps/api/src/modules/internal apps/api/src/app.ts apps/api/test/helpers.ts docs/superpowers/specs/2026-11-16-app-lanche-design.md
git commit -m "feat(api): compute magic link expiry in the database and add the internal magic-link route"
```

---

### Task 3: Agenda e fechamento pelo n8n

**Files:**
- Modify: `packages/contracts/src/internal.ts`, `packages/contracts/src/internal.test.ts`
- Modify: `apps/api/src/modules/serviceDays/repo.ts`, `apps/api/src/modules/serviceDays/service.ts`
- Modify: `apps/api/src/modules/internal/routes.ts`
- Create: `apps/api/src/modules/internal/schedule.test.ts`
- Modify: `eslint.config.js` (libera `getDb` em `apps/api/src/modules/serviceDays/repo.ts`)

**Interfaces:**
- Consumes: `internalRoutes`, `INTERNAL`, `internalRequest` (Task 2); `closeServiceDay`, `getManifest` (F2).
- Produces: `listDueActions(): Promise<DueAction[]>` em `serviceDays/service.ts`, com `type DueAction = { action: "send_reminders" | "close_service_day"; schoolId: string; serviceDate: string; overdue: boolean }` (a Task 6 usa `overdue`).
- Produces (contracts): `ScheduleDueResponse`.

- [ ] **Step 1: Contrato (falha)**

Em `internal.ts`:

```ts
export const DueActionName = z.enum(["send_reminders", "close_service_day"]);

/** GET /internal/v1/schedule/due */
export const ScheduleDueResponse = z.object({
  due: z.array(z.object({ action: DueActionName, school_id: Uuid, service_date: IsoDate })),
});
export type ScheduleDueResponse = z.infer<typeof ScheduleDueResponse>;
```

Fixture em `internal.test.ts`:

```ts
  it("accepts the schedule example from spec 6.2", () => {
    const example = {
      due: [
        { action: "send_reminders", school_id: G, service_date: "2026-11-17" },
        { action: "close_service_day", school_id: G, service_date: "2026-11-17" },
      ],
    };
    expect(ScheduleDueResponse.parse(example)).toEqual(example);
  });
```

- [ ] **Step 2: Testes das rotas (falham)**

`apps/api/src/modules/internal/schedule.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { adminDb, createSchool, internalRequest, seedServiceDay, seedTenant } from "../../../test/helpers";
import { buildApp } from "../../app";

describe("internal schedule and close routes", () => {
  it("lists due actions for the school without the overdue flag", async () => {
    const schoolId = await createSchool();
    await seedTenant(schoolId);
    await seedServiceDay(schoolId, { serviceDate: "2031-04-01", cutoffInMinutes: 60 });
    await seedServiceDay(schoolId, { serviceDate: "2031-04-02", cutoffInMinutes: -11 });
    const res = await buildApp().inject(internalRequest("GET", "/internal/v1/schedule/due"));
    expect(res.statusCode).toBe(200);
    const mine = res.json().due.filter((d: { school_id: string }) => d.school_id === schoolId);
    expect(mine).toEqual([
      { action: "send_reminders", school_id: schoolId, service_date: "2031-04-01" },
      { action: "close_service_day", school_id: schoolId, service_date: "2031-04-02" },
    ]);
  });

  it("closes the day once and returns the same manifest on repetition", async () => {
    const schoolId = await createSchool();
    await seedTenant(schoolId);
    await adminDb().updateTable("schools").set({ kitchenPhone: "+5511988880000" }).where("id", "=", schoolId).execute();
    const day = await seedServiceDay(schoolId, { serviceDate: "2031-04-03", cutoffInMinutes: -6 });
    const app = buildApp();
    const url = `/internal/v1/service-days/${schoolId}/${day.serviceDate}/close`;
    const first = await app.inject(internalRequest("POST", url));
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ status: "closed", manifest_version: 1, kitchen_phone: "+5511988880000" });
    const again = await app.inject(internalRequest("POST", url));
    expect(again.json()).toEqual(first.json());
    const manifest = await app.inject(internalRequest("GET", `/internal/v1/service-days/${schoolId}/${day.serviceDate}/manifest`));
    expect(manifest.statusCode).toBe(200);
    expect(manifest.json()).toEqual(first.json());
  });

  it("answers 409 service_day_open before the cutoff, for close and for manifest", async () => {
    const schoolId = await createSchool();
    await seedTenant(schoolId);
    const day = await seedServiceDay(schoolId, { serviceDate: "2031-04-04", cutoffInMinutes: 60 });
    const app = buildApp();
    const close = await app.inject(internalRequest("POST", `/internal/v1/service-days/${schoolId}/${day.serviceDate}/close`));
    expect(close.statusCode).toBe(409);
    expect(close.json().error.code).toBe("service_day_open");
    const manifest = await app.inject(internalRequest("GET", `/internal/v1/service-days/${schoolId}/${day.serviceDate}/manifest`));
    expect(manifest.statusCode).toBe(409);
  });

  it("rejects a request signed for another school's path", async () => {
    const schoolA = await createSchool();
    const schoolB = await createSchool();
    const signed = internalRequest("POST", `/internal/v1/service-days/${schoolA}/2031-04-05/close`);
    const res = await buildApp().inject({ ...signed, url: `/internal/v1/service-days/${schoolB}/2031-04-05/close` });
    expect(res.statusCode).toBe(401);
  });
});
```

Run → FAIL.

- [ ] **Step 3: Implementar**

`serviceDays/repo.ts`:

```ts
import { getDb } from "../../db/index";

/** Agenda de todas as escolas (função SECURITY DEFINER, spec 4.4). */
export async function listDueActions() {
  const { rows } = await sql<{ action: "send_reminders" | "close_service_day"; schoolId: string; serviceDate: string; overdue: boolean }>`
    SELECT action, school_id, service_date, overdue FROM list_due_actions()`.execute(getDb());
  return rows;
}
```

`serviceDays/service.ts`:

```ts
export type DueAction = { action: "send_reminders" | "close_service_day"; schoolId: string; serviceDate: string; overdue: boolean };

export async function listDueActions(): Promise<DueAction[]> {
  return repo.listDueActions();
}
```

`internal/routes.ts` (acrescente):

```ts
const DayParams = z.object({ school_id: Uuid, date: IsoDate });

  app.get("/internal/v1/schedule/due", INTERNAL, async (): Promise<ScheduleDueResponse> => ({
    due: (await serviceDays.listDueActions()).map((d) => ({ action: d.action, school_id: d.schoolId, service_date: d.serviceDate })),
  }));

  app.post("/internal/v1/service-days/:school_id/:date/close", INTERNAL, async (req) => {
    const p = DayParams.parse(req.params);
    return serviceDays.closeServiceDay(p.school_id, p.date, { log: req.log });
  });

  app.get("/internal/v1/service-days/:school_id/:date/manifest", INTERNAL, async (req) => {
    const p = DayParams.parse(req.params);
    return serviceDays.getManifest(p.school_id, p.date);
  });
```

(imports: `IsoDate`, `ScheduleDueResponse` de `@app-lanche/contracts`; `* as serviceDays from "../serviceDays/service"`.)

Em `eslint.config.js`, acrescente `"apps/api/src/modules/serviceDays/repo.ts"` aos `ignores` da regra de `getDb` e troque a mensagem por `"getDb só é permitido em src/db, nos repo.ts que chamam funções SECURITY DEFINER e em testes. Use withTenant."` (atualize também o comentário acima da regra).

- [ ] **Step 4: Rodar e commitar**

Run: `pnpm --filter @app-lanche/contracts test && pnpm --filter @app-lanche/api test -- src/modules/internal src/modules/serviceDays && pnpm typecheck && pnpm lint` → PASS.

```bash
git add packages/contracts/src apps/api/src/modules/serviceDays apps/api/src/modules/internal eslint.config.js
git commit -m "feat(api): expose the agenda, close and manifest routes to n8n"
```

---

### Task 4: Lembretes — `prepare` e `deliveries`

**Files:**
- Modify: `packages/contracts/src/internal.ts`, `packages/contracts/src/internal.test.ts`
- Create: `apps/api/src/modules/reminders/repo.ts`, `apps/api/src/modules/reminders/service.ts`
- Modify: `apps/api/src/modules/internal/routes.ts`
- Create: `apps/api/src/modules/internal/reminders.test.ts`

**Interfaces:**
- Consumes: `catalog.lockServiceDayByDate(trx, date, "share")` → `LockedServiceDay | undefined`; `auth.createMagicLink` (Task 2); `wallet.balanceOf(trx, guardianId): Promise<number>`.
- Produces: `prepareReminders(schoolId: string, body: RemindersPrepareRequest): Promise<RemindersPrepareResponse>`; `recordDeliveries(schoolId: string, batchId: string, body: DeliveriesRequest): Promise<void>`; `REMINDER_PAGE_SIZE = 200`.
- Produces (contracts): `RemindersPrepareRequest`, `ReminderRecipient`, `RemindersPrepareResponse`, `DeliveryResult`, `DeliveriesRequest`.

- [ ] **Step 1: Contratos (falham)**

```ts
/** POST /internal/v1/schools/{school_id}/reminders/prepare */
export const RemindersPrepareRequest = z.object({ service_date: IsoDate, cursor: Uuid.nullable() }).strict();
export type RemindersPrepareRequest = z.infer<typeof RemindersPrepareRequest>;

export const ReminderRecipient = z.object({
  guardian_id: Uuid,
  phone: z.string(),
  first_name: z.string(),
  students: z.array(z.string()).min(1),
  link_url: z.string().url(),
  wallet_balance_cents: z.number().int().nonnegative(),
  cutoff_at: IsoDateTime,
  cutoff_local_time: z.string().regex(/^\d{2}:\d{2}$/),
});
export const RemindersPrepareResponse = z.object({
  batch_id: Uuid,
  next_cursor: Uuid.nullable(),
  recipients: z.array(ReminderRecipient).max(200),
});
export type RemindersPrepareResponse = z.infer<typeof RemindersPrepareResponse>;

/** POST /internal/v1/schools/{school_id}/reminders/{batch_id}/deliveries → 204 */
export const DeliveryResult = z.discriminatedUnion("status", [
  z.object({ guardian_id: Uuid, status: z.literal("sent"), wa_message_id: z.string().min(1).max(200) }).strict(),
  z.object({ guardian_id: Uuid, status: z.literal("failed"), error: z.string().regex(/^[a-z0-9_]{1,64}$/) }).strict(),
]);
export const DeliveriesRequest = z.object({ results: z.array(DeliveryResult).min(1).max(200) }).strict();
export type DeliveriesRequest = z.infer<typeof DeliveriesRequest>;
```

Fixtures (exemplos da spec 6.2, com ids válidos e `cutoff_local_time`):

```ts
  it("accepts the reminder examples from spec 6.2", () => {
    const req = { service_date: "2026-11-17", cursor: null };
    expect(RemindersPrepareRequest.parse(req)).toEqual(req);
    const res = {
      batch_id: G,
      next_cursor: null,
      recipients: [
        {
          guardian_id: G,
          phone: "+5511999990000",
          first_name: "Ana",
          students: ["Léo", "Bia"],
          link_url: "https://app.example/l#Zk3",
          wallet_balance_cents: 1200,
          cutoff_at: "2026-11-17T07:30:00-03:00",
          cutoff_local_time: "07:30",
        },
      ],
    };
    expect(RemindersPrepareResponse.parse(res)).toEqual(res);
    const deliveries = {
      results: [
        { guardian_id: G, status: "sent", wa_message_id: "wamid.X" },
        { guardian_id: G, status: "failed", error: "invalid_number" },
      ],
    };
    expect(DeliveriesRequest.parse(deliveries)).toEqual(deliveries);
  });

  it("rejects a free-text delivery error", () => {
    expect(() => DeliveriesRequest.parse({ results: [{ guardian_id: G, status: "failed", error: "Número inválido +55" }] })).toThrow();
  });
```

- [ ] **Step 2: Testes de integração (falham)**

`apps/api/src/modules/internal/reminders.test.ts`:

```ts
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { adminDb, createSchool, internalRequest, seedFamily, seedServiceDay } from "../../../test/helpers";
import { buildApp } from "../../app";
import { hashToken } from "../auth/tokens";

const prepare = (schoolId: string, body: unknown) =>
  internalRequest("POST", `/internal/v1/schools/${schoolId}/reminders/prepare`, body);

async function confirmOrder(schoolId: string, serviceDayId: string, serviceDate: string, guardianId: string, studentId: string) {
  const checkoutId = crypto.randomUUID();
  await adminDb().insertInto("checkouts").values({ id: checkoutId, schoolId, guardianId, serviceDayId, status: "paid", totalCents: 900 }).execute();
  await adminDb().insertInto("orders").values({ id: crypto.randomUUID(), schoolId, checkoutId, studentId, serviceDate, status: "confirmed" }).execute();
}

describe("reminders", () => {
  it("prepares one recipient per guardian with a link valid until the cutoff", async () => {
    const schoolId = await createSchool();
    const fam = await seedFamily(schoolId, ["Léo", "Bia"]);
    const day = await seedServiceDay(schoolId, { serviceDate: "2031-05-05", cutoffInMinutes: 60 });
    const res = await buildApp().inject(prepare(schoolId, { service_date: day.serviceDate, cursor: null }));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.next_cursor).toBeNull();
    expect(body.recipients).toHaveLength(1);
    const r = body.recipients[0];
    expect(r).toMatchObject({ guardian_id: fam.guardianId, first_name: "Ana", students: ["Bia", "Léo"], wallet_balance_cents: 0 });
    expect(r.cutoff_local_time).toMatch(/^\d{2}:\d{2}$/);
    const link = await adminDb().selectFrom("magicLinks").select(["expiresAt", "scope", "serviceDate"]).where("tokenHash", "=", hashToken(r.link_url.split("#")[1])).executeTakeFirstOrThrow();
    expect(link).toMatchObject({ scope: "order", serviceDate: day.serviceDate });
    expect(link.expiresAt.toISOString()).toBe(new Date(r.cutoff_at).toISOString());
    const batch = await adminDb().selectFrom("reminderBatches").select(["id", "completedAt"]).where("schoolId", "=", schoolId).executeTakeFirstOrThrow();
    expect(batch.id).toBe(body.batch_id);
    expect(batch.completedAt).not.toBeNull();
  });

  it("formats the local cutoff in the school's timezone", async () => {
    const schoolId = await createSchool();
    await seedFamily(schoolId, ["Léo"]);
    const day = await seedServiceDay(schoolId, { serviceDate: "2031-05-06", cutoffInMinutes: 60 });
    const { rows } = await sql<{ local: string }>`
      SELECT to_char(cutoff_at AT TIME ZONE 'America/Sao_Paulo', 'HH24:MI') AS local FROM service_days WHERE id = ${day.serviceDayId}`.execute(adminDb());
    const res = await buildApp().inject(prepare(schoolId, { service_date: day.serviceDate, cursor: null }));
    expect(res.json().recipients[0].cutoff_local_time).toBe(rows[0]!.local);
  });

  it("skips guardians whose children all have a confirmed order, and inactive children", async () => {
    const schoolId = await createSchool();
    const done = await seedFamily(schoolId, ["Léo"]);
    const partial = await seedFamily(schoolId, ["Bia", "Caio"]);
    const day = await seedServiceDay(schoolId, { serviceDate: "2031-05-07", cutoffInMinutes: 60 });
    await confirmOrder(schoolId, day.serviceDayId, day.serviceDate, done.guardianId, done.studentIds[0]!);
    await confirmOrder(schoolId, day.serviceDayId, day.serviceDate, partial.guardianId, partial.studentIds[0]!);
    const res = await buildApp().inject(prepare(schoolId, { service_date: day.serviceDate, cursor: null }));
    const ids = res.json().recipients.map((r: { guardian_id: string }) => r.guardian_id);
    expect(ids).toEqual([partial.guardianId]);
    await adminDb().updateTable("students").set({ active: false }).where("id", "=", partial.studentIds[1]!).execute();
    const again = await buildApp().inject(prepare(schoolId, { service_date: day.serviceDate, cursor: null }));
    expect(again.json().recipients).toEqual([]);
  });

  it("paginates by 200 with a cursor and reuses the batch", async () => {
    const schoolId = await createSchool();
    for (let i = 0; i < 201; i += 1) await seedFamily(schoolId, ["Léo"]);
    const day = await seedServiceDay(schoolId, { serviceDate: "2031-05-08", cutoffInMinutes: 60 });
    const app = buildApp();
    const first = (await app.inject(prepare(schoolId, { service_date: day.serviceDate, cursor: null }))).json();
    expect(first.recipients).toHaveLength(200);
    expect(first.next_cursor).toBe(first.recipients[199].guardian_id);
    let batch = await adminDb().selectFrom("reminderBatches").select("completedAt").where("schoolId", "=", schoolId).executeTakeFirstOrThrow();
    expect(batch.completedAt).toBeNull();
    const second = (await app.inject(prepare(schoolId, { service_date: day.serviceDate, cursor: first.next_cursor }))).json();
    expect(second.batch_id).toBe(first.batch_id);
    expect(second.recipients).toHaveLength(1);
    expect(second.next_cursor).toBeNull();
    batch = await adminDb().selectFrom("reminderBatches").select("completedAt").where("schoolId", "=", schoolId).executeTakeFirstOrThrow();
    expect(batch.completedAt).not.toBeNull();
  }, 60_000);

  it("never resends to a guardian already marked sent, and failed stays retryable", async () => {
    const schoolId = await createSchool();
    const sent = await seedFamily(schoolId, ["Léo"]);
    const failed = await seedFamily(schoolId, ["Bia"]);
    const day = await seedServiceDay(schoolId, { serviceDate: "2031-05-09", cutoffInMinutes: 60 });
    const app = buildApp();
    const page = (await app.inject(prepare(schoolId, { service_date: day.serviceDate, cursor: null }))).json();
    const res = await app.inject(
      internalRequest("POST", `/internal/v1/schools/${schoolId}/reminders/${page.batch_id}/deliveries`, {
        results: [
          { guardian_id: sent.guardianId, status: "sent", wa_message_id: "wamid.A" },
          { guardian_id: failed.guardianId, status: "failed", error: "invalid_number" },
        ],
      }),
    );
    expect(res.statusCode).toBe(204);
    // Um "failed" atrasado não desfaz um "sent".
    await app.inject(
      internalRequest("POST", `/internal/v1/schools/${schoolId}/reminders/${page.batch_id}/deliveries`, {
        results: [{ guardian_id: sent.guardianId, status: "failed", error: "timeout" }],
      }),
    );
    const rows = await adminDb().selectFrom("messageDeliveries").select(["guardianId", "status", "waMessageId", "error"]).where("batchId", "=", page.batch_id).orderBy("guardianId").execute();
    expect(rows).toEqual(
      [
        { guardianId: sent.guardianId, status: "sent", waMessageId: "wamid.A", error: null },
        { guardianId: failed.guardianId, status: "failed", waMessageId: null, error: "invalid_number" },
      ].sort((a, b) => a.guardianId.localeCompare(b.guardianId)),
    );
    const again = (await app.inject(prepare(schoolId, { service_date: day.serviceDate, cursor: null }))).json();
    expect(again.recipients.map((r: { guardian_id: string }) => r.guardian_id)).toEqual([failed.guardianId]);
  });

  it("answers 404 for a batch of another school and ignores guardians not in the batch", async () => {
    const schoolA = await createSchool();
    const schoolB = await createSchool();
    const famA = await seedFamily(schoolA, ["Léo"]);
    await seedFamily(schoolB, ["Bia"]);
    const dayA = await seedServiceDay(schoolA, { serviceDate: "2031-05-12", cutoffInMinutes: 60 });
    const app = buildApp();
    const pageA = (await app.inject(prepare(schoolA, { service_date: dayA.serviceDate, cursor: null }))).json();
    const cross = await app.inject(
      internalRequest("POST", `/internal/v1/schools/${schoolB}/reminders/${pageA.batch_id}/deliveries`, {
        results: [{ guardian_id: famA.guardianId, status: "sent", wa_message_id: "wamid.X" }],
      }),
    );
    expect(cross.statusCode).toBe(404);
    const stranger = await app.inject(
      internalRequest("POST", `/internal/v1/schools/${schoolA}/reminders/${pageA.batch_id}/deliveries`, {
        results: [{ guardian_id: crypto.randomUUID(), status: "sent", wa_message_id: "wamid.Y" }],
      }),
    );
    expect(stranger.statusCode).toBe(204);
  });

  it("answers 404 without a service day and 409 after the cutoff", async () => {
    const schoolId = await createSchool();
    await seedFamily(schoolId, ["Léo"]);
    const app = buildApp();
    const missing = await app.inject(prepare(schoolId, { service_date: "2031-05-13", cursor: null }));
    expect(missing.statusCode).toBe(404);
    const past = await seedServiceDay(schoolId, { serviceDate: "2031-05-14", cutoffInMinutes: -1 });
    const late = await app.inject(prepare(schoolId, { service_date: past.serviceDate, cursor: null }));
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe("cutoff_passed");
  });
});
```

Run → FAIL.

- [ ] **Step 3: Repositório**

`apps/api/src/modules/reminders/repo.ts`:

```ts
import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import type { Trx } from "../../db/index";

/** Um lote por escola e data: repetir o prepare reaproveita o mesmo lote. */
export async function ensureBatch(trx: Trx, schoolId: string, serviceDate: string): Promise<string> {
  await trx
    .insertInto("reminderBatches")
    .values({ id: uuidv7(), schoolId, serviceDate })
    .onConflict((oc) => oc.columns(["schoolId", "serviceDate"]).doNothing())
    .execute();
  const row = await trx.selectFrom("reminderBatches").select("id").where("serviceDate", "=", serviceDate).executeTakeFirstOrThrow();
  return row.id;
}

export async function batchExists(trx: Trx, batchId: string): Promise<boolean> {
  const row = await trx.selectFrom("reminderBatches").select("id").where("id", "=", batchId).executeTakeFirst();
  return row !== undefined;
}

/**
 * Responsáveis com ao menos um filho ativo sem pedido confirmado/entregue na data, que ainda não
 * constam como `sent` no lote; ordenados por id a partir do cursor. Traz `limit + 1` para saber se há próxima página.
 */
export async function candidates(trx: Trx, input: { batchId: string; serviceDate: string; cursor: string | null; limit: number }) {
  const { rows } = await sql<{ guardianId: string; phone: string; firstName: string; students: string[] }>`
    SELECT g.id AS guardian_id, g.phone_e164 AS phone, g.first_name,
           array_agg(st.first_name ORDER BY st.first_name, st.id) AS students
    FROM guardians g
    JOIN guardian_students gs ON gs.guardian_id = g.id
    JOIN students st ON st.id = gs.student_id AND st.active
    LEFT JOIN LATERAL (
      SELECT true AS ordered FROM orders o
      WHERE o.student_id = st.id AND o.service_date = ${input.serviceDate}::date AND o.status IN ('confirmed', 'delivered')
      LIMIT 1
    ) o ON true
    WHERE (${input.cursor}::uuid IS NULL OR g.id > ${input.cursor}::uuid)
      AND NOT EXISTS (
        SELECT 1 FROM message_deliveries md
        WHERE md.batch_id = ${input.batchId}::uuid AND md.guardian_id = g.id AND md.status = 'sent')
    GROUP BY g.id
    HAVING bool_or(o.ordered IS NULL)
    ORDER BY g.id
    LIMIT ${input.limit + 1}`.execute(trx);
  return rows;
}

export async function markPrepared(trx: Trx, schoolId: string, batchId: string, guardianIds: string[]): Promise<void> {
  if (guardianIds.length === 0) return;
  await trx
    .insertInto("messageDeliveries")
    .values(guardianIds.map((guardianId) => ({ id: uuidv7(), schoolId, batchId, guardianId })))
    .onConflict((oc) => oc.columns(["schoolId", "batchId", "guardianId"]).doNothing())
    .execute();
}

export async function completeBatch(trx: Trx, batchId: string): Promise<void> {
  await trx.updateTable("reminderBatches").set({ completedAt: sql`now()` }).where("id", "=", batchId).where("completedAt", "is", null).execute();
}

/** Hora local do corte no fuso da escola, calculada pelo banco. */
export async function cutoffLocalTime(trx: Trx, serviceDayId: string): Promise<string> {
  const { rows } = await sql<{ local: string }>`
    SELECT to_char(d.cutoff_at AT TIME ZONE s.timezone, 'HH24:MI') AS local
    FROM service_days d JOIN schools s ON s.id = d.school_id WHERE d.id = ${serviceDayId}`.execute(trx);
  return rows[0]!.local;
}

/** "sent" é terminal: um resultado atrasado não o desfaz. */
export async function recordResult(
  trx: Trx,
  batchId: string,
  r: { guardianId: string; status: "sent" | "failed"; waMessageId: string | null; error: string | null },
): Promise<void> {
  await trx
    .updateTable("messageDeliveries")
    .set({ status: r.status, waMessageId: r.waMessageId, error: r.error, updatedAt: sql`now()` })
    .where("batchId", "=", batchId)
    .where("guardianId", "=", r.guardianId)
    .where("status", "<>", "sent")
    .execute();
}
```

- [ ] **Step 4: Serviço e rotas**

`apps/api/src/modules/reminders/service.ts`:

```ts
import type { DeliveriesRequest, RemindersPrepareRequest, RemindersPrepareResponse } from "@app-lanche/contracts";
import { withTenant } from "../../db/index";
import { DomainError } from "../../platform/errors";
import * as auth from "../auth/service";
import * as catalog from "../catalog/service";
import * as wallet from "../wallet/service";
import * as repo from "./repo";

export const REMINDER_PAGE_SIZE = 200;

export async function prepareReminders(schoolId: string, body: RemindersPrepareRequest): Promise<RemindersPrepareResponse> {
  return withTenant(schoolId, async (trx) => {
    const day = await catalog.lockServiceDayByDate(trx, body.service_date, "share");
    if (!day) throw new DomainError("not_found");
    if (day.status !== "open" || !day.beforeCutoff) throw new DomainError("cutoff_passed");

    const batchId = await repo.ensureBatch(trx, schoolId, body.service_date);
    const rows = await repo.candidates(trx, { batchId, serviceDate: body.service_date, cursor: body.cursor, limit: REMINDER_PAGE_SIZE });
    const page = rows.slice(0, REMINDER_PAGE_SIZE);
    const hasMore = rows.length > REMINDER_PAGE_SIZE;
    const cutoffLocal = await repo.cutoffLocalTime(trx, day.id);

    const recipients = [];
    for (const g of page) {
      const link = await auth.createMagicLink(trx, { schoolId, guardianId: g.guardianId, scope: "order", serviceDate: body.service_date });
      recipients.push({
        guardian_id: g.guardianId,
        phone: g.phone,
        first_name: g.firstName,
        students: g.students,
        link_url: link.url,
        wallet_balance_cents: await wallet.balanceOf(trx, g.guardianId),
        cutoff_at: day.cutoffAt.toISOString(),
        cutoff_local_time: cutoffLocal,
      });
    }
    await repo.markPrepared(trx, schoolId, batchId, page.map((g) => g.guardianId));
    if (!hasMore) await repo.completeBatch(trx, batchId);
    return { batch_id: batchId, next_cursor: hasMore ? page[page.length - 1]!.guardianId : null, recipients };
  });
}

export async function recordDeliveries(schoolId: string, batchId: string, body: DeliveriesRequest): Promise<void> {
  await withTenant(schoolId, async (trx) => {
    if (!(await repo.batchExists(trx, batchId))) throw new DomainError("not_found");
    for (const r of body.results) {
      await repo.recordResult(trx, batchId, {
        guardianId: r.guardian_id,
        status: r.status,
        waMessageId: r.status === "sent" ? r.wa_message_id : null,
        error: r.status === "failed" ? r.error : null,
      });
    }
  });
}
```

`internal/routes.ts` (acrescente):

```ts
const BatchParams = z.object({ school_id: Uuid, batch_id: Uuid });

  app.post("/internal/v1/schools/:school_id/reminders/prepare", INTERNAL, async (req) =>
    reminders.prepareReminders(SchoolParams.parse(req.params).school_id, RemindersPrepareRequest.parse(req.body)),
  );

  app.post("/internal/v1/schools/:school_id/reminders/:batch_id/deliveries", INTERNAL, async (req, reply) => {
    const p = BatchParams.parse(req.params);
    await reminders.recordDeliveries(p.school_id, p.batch_id, DeliveriesRequest.parse(req.body));
    return reply.status(204).send();
  });
```

- [ ] **Step 5: Rodar e commitar**

Run: `pnpm --filter @app-lanche/contracts test && pnpm --filter @app-lanche/api test -- src/modules/internal && pnpm typecheck && pnpm lint` → PASS.

```bash
git add packages/contracts/src apps/api/src/modules/reminders apps/api/src/modules/internal
git commit -m "feat(api): prepare reminder pages with magic links and record deliveries"
```

---

### Task 5: Dispatcher da outbox

**Files:**
- Modify: `apps/api/src/platform/config.ts`, `apps/api/src/platform/config.test.ts`
- Create: `apps/api/src/modules/outbox/repo.ts`, `apps/api/src/modules/outbox/service.ts`, `apps/api/src/modules/outbox/dispatch.test.ts`
- Modify: `apps/api/test/setupEnv.ts` (`JOBS_TOKEN`)
- Modify: `eslint.config.js` (libera `getDb` em `apps/api/src/modules/outbox/repo.ts`)

**Interfaces:**
- Consumes: `signInternal` (`platform/hmac`); `OutboxEnvelope` (contracts); `list_schools_with_pending_events()` (Task 1).
- Produces: `config().jobsToken: string`, `config().n8nEventsUrl: string | null`, `config().n8nHmacSecret: string | null`.
- Produces: `dispatchSchool(schoolId: string, log: FastifyBaseLogger): Promise<DispatchCounts>`; `dispatchOutbox(opts: { log: FastifyBaseLogger; schoolIds?: string[] }): Promise<DispatchResult>`; `signedEventRequest(envelope: OutboxEnvelope): { url: string; headers: Record<string, string>; body: string }`; `type DispatchCounts = { delivered: number; failed: number; abandoned: number }`; `type DispatchResult = DispatchCounts & { schools: number }`.

- [ ] **Step 1: Config (teste falha)**

`config.ts`: no `Env`, acrescente

```ts
  JOBS_TOKEN: secret,
  N8N_EVENTS_URL: z.url().optional(),
  N8N_HMAC_SECRET: secret.optional(),
```

depois do `PAYMENT_PROVIDER` check:

```ts
  if ((env.N8N_EVENTS_URL === undefined) !== (env.N8N_HMAC_SECRET === undefined)) {
    throw new Error("invalid environment: N8N_EVENTS_URL, N8N_HMAC_SECRET");
  }
```

`Config` ganha `jobsToken: string; n8nEventsUrl: string | null; n8nHmacSecret: string | null;` preenchidos com `env.JOBS_TOKEN`, `env.N8N_EVENTS_URL ?? null`, `env.N8N_HMAC_SECRET ?? null`.

`config.test.ts`: `valid` ganha `JOBS_TOKEN: "j".repeat(32)`; o `toEqual` do teste "parses a valid environment" ganha `jobsToken: "j".repeat(32), n8nEventsUrl: null, n8nHmacSecret: null`. Novos casos:

```ts
  it("requires JOBS_TOKEN with at least 32 characters", () => {
    setEnv({ JOBS_TOKEN: "short" });
    expect(() => config()).toThrow("invalid environment: JOBS_TOKEN");
  });

  it("requires the n8n URL and secret together", () => {
    setEnv({ N8N_EVENTS_URL: "https://n8n.example.com/webhook/app-lanche-events" });
    expect(() => config()).toThrow("invalid environment: N8N_EVENTS_URL, N8N_HMAC_SECRET");
    resetConfigForTests();
    setEnv({ N8N_EVENTS_URL: "https://n8n.example.com/webhook/app-lanche-events", N8N_HMAC_SECRET: "n".repeat(32) });
    expect(config()).toMatchObject({ n8nEventsUrl: "https://n8n.example.com/webhook/app-lanche-events", n8nHmacSecret: "n".repeat(32) });
  });
```

`test/setupEnv.ts`: `process.env.JOBS_TOKEN = "test-jobs-token-with-at-least-32-chars";`

- [ ] **Step 2: Testes do dispatcher (falham)**

`apps/api/src/modules/outbox/dispatch.test.ts`:

```ts
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { adminDb, createSchool, seedTenant } from "../../../test/helpers";
import { withTenant } from "../../db/index";
import { config, resetConfigForTests } from "../../platform/config";
import { signInternal } from "../../platform/hmac";
import { enqueueEvent } from "../../platform/outbox";
import { dispatchOutbox, dispatchSchool } from "./service";

const SECRET = "test-n8n-hmac-secret-with-at-least-32-chars";
const log = { warn: () => undefined, info: () => undefined, error: () => undefined } as never;

type Received = { headers: IncomingMessage["headers"]; body: string; path: string };
let server: Server;
let received: Received[] = [];
let status = 200;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body, path: req.url ?? "" });
      res.statusCode = status;
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  process.env.N8N_EVENTS_URL = `http://127.0.0.1:${port}/webhook/app-lanche-events?x=1`;
  process.env.N8N_HMAC_SECRET = SECRET;
  resetConfigForTests();
});

afterAll(async () => {
  delete process.env.N8N_EVENTS_URL;
  delete process.env.N8N_HMAC_SECRET;
  resetConfigForTests();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  received = [];
  status = 200;
});

const forSchool = (schoolId: string) => received.map((r) => JSON.parse(r.body)).filter((e) => e.school_id === schoolId);

async function otp(schoolId: string, expiresAt = new Date(Date.now() + 300_000)) {
  return withTenant(schoolId, (trx) =>
    enqueueEvent(trx, schoolId, {
      type: "auth.otp_requested",
      data: { channel: "whatsapp", to: "+5511999990001", first_name: "Ana", code: "123456", expires_at: expiresAt.toISOString() },
    }),
  );
}

const row = (id: string) =>
  adminDb()
    .selectFrom("outboxEvents")
    .select(["attempts", "deliveredAt", "failedAt", sql<string>`data::text`.as("data"), sql<boolean>`next_attempt_at > now() + interval '30 seconds'`.as("backedOff")])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();

describe("outbox dispatcher", () => {
  it("posts a signed envelope and scrubs the OTP after delivery", async () => {
    const schoolId = await createSchool();
    await seedTenant(schoolId);
    const id = await otp(schoolId);
    const counts = await dispatchSchool(schoolId, log);
    expect(counts.delivered).toBeGreaterThanOrEqual(1);
    const sent = received.find((r) => JSON.parse(r.body).id === id)!;
    expect(sent.path).toBe("/webhook/app-lanche-events?x=1");
    const envelope = JSON.parse(sent.body);
    expect(envelope).toMatchObject({ id, type: "auth.otp_requested", school_id: schoolId, data: { code: "123456" } });
    const expected = signInternal(SECRET, {
      method: "POST",
      path: "/webhook/app-lanche-events?x=1",
      timestamp: String(sent.headers["x-timestamp"]),
      body: sent.body,
    });
    expect(sent.headers["x-signature"]).toBe(expected);
    const after = await row(id);
    expect(after.deliveredAt).not.toBeNull();
    expect(after.attempts).toBe(1);
    expect(JSON.parse(after.data)).toEqual({});
  });

  it("keeps other events' data after delivery and does not resend a delivered event", async () => {
    const schoolId = await createSchool();
    await seedTenant(schoolId);
    const id = await withTenant(schoolId, (trx) =>
      enqueueEvent(trx, schoolId, { type: "service_day.closed", data: { service_date: "2031-06-02", orders: 3, late_credits: 0 } }),
    );
    await dispatchSchool(schoolId, log);
    await dispatchSchool(schoolId, log);
    expect(forSchool(schoolId).filter((e) => e.id === id)).toHaveLength(1);
    expect(JSON.parse((await row(id)).data)).toEqual({ service_date: "2031-06-02", orders: 3, late_credits: 0 });
  });

  it("backs off after a failed attempt and keeps the event pending", async () => {
    const schoolId = await createSchool();
    await seedTenant(schoolId);
    const id = await otp(schoolId);
    status = 503;
    const counts = await dispatchSchool(schoolId, log);
    expect(counts.failed).toBeGreaterThanOrEqual(1);
    const after = await row(id);
    expect(after).toMatchObject({ attempts: 1, deliveredAt: null, failedAt: null, backedOff: true });
    expect(JSON.parse(after.data)).toMatchObject({ code: "123456" });
  });

  it("abandons an expired OTP without sending it and scrubs it", async () => {
    const schoolId = await createSchool();
    await seedTenant(schoolId);
    const id = await otp(schoolId, new Date(Date.now() - 1000));
    const counts = await dispatchSchool(schoolId, log);
    expect(counts.abandoned).toBeGreaterThanOrEqual(1);
    expect(forSchool(schoolId).some((e) => e.id === id)).toBe(false);
    const after = await row(id);
    expect(after.failedAt).not.toBeNull();
    expect(JSON.parse(after.data)).toEqual({});
  });

  it("abandons an event older than 24 hours", async () => {
    const schoolId = await createSchool();
    await seedTenant(schoolId);
    const id = uuidv7();
    await adminDb()
      .insertInto("outboxEvents")
      .values({ id, schoolId, type: "service_day.closed", data: "{}", occurredAt: sql`now() - interval '25 hours'` })
      .execute();
    await dispatchSchool(schoolId, log);
    expect(forSchool(schoolId).some((e) => e.id === id)).toBe(false);
    expect((await row(id)).failedAt).not.toBeNull();
  });

  it("does not send the same event twice when two dispatchers race", async () => {
    const schoolId = await createSchool();
    await seedTenant(schoolId);
    const ids = [];
    for (let i = 0; i < 20; i += 1) ids.push(await otp(schoolId));
    await Promise.all([dispatchSchool(schoolId, log), dispatchSchool(schoolId, log), dispatchSchool(schoolId, log)]);
    const sentIds = forSchool(schoolId).map((e) => e.id).filter((id) => ids.includes(id));
    expect(sentIds.sort()).toEqual([...ids].sort());
  });

  it("dispatches only the listed schools when asked", async () => {
    const a = await createSchool();
    const b = await createSchool();
    await seedTenant(a);
    await seedTenant(b);
    const idA = await otp(a);
    const idB = await otp(b);
    const result = await dispatchOutbox({ log, schoolIds: [a] });
    expect(result.schools).toBe(1);
    expect(forSchool(a).some((e) => e.id === idA)).toBe(true);
    expect(forSchool(b).some((e) => e.id === idB)).toBe(false);
  });

  it("does nothing without an n8n URL", async () => {
    const schoolId = await createSchool();
    await seedTenant(schoolId);
    const id = await otp(schoolId);
    const saved = process.env.N8N_EVENTS_URL;
    const savedSecret = process.env.N8N_HMAC_SECRET;
    delete process.env.N8N_EVENTS_URL;
    delete process.env.N8N_HMAC_SECRET;
    resetConfigForTests();
    try {
      expect(config().n8nEventsUrl).toBeNull();
      expect(await dispatchSchool(schoolId, log)).toEqual({ delivered: 0, failed: 0, abandoned: 0 });
      expect((await row(id)).attempts).toBe(0);
    } finally {
      process.env.N8N_EVENTS_URL = saved;
      process.env.N8N_HMAC_SECRET = savedSecret;
      resetConfigForTests();
    }
  });
});
```

Run → FAIL.

- [ ] **Step 3: Repositório**

`apps/api/src/modules/outbox/repo.ts`:

```ts
import { sql } from "kysely";
import { getDb, type Trx } from "../../db/index";

export type ClaimedEvent = {
  id: string;
  type: string;
  data: string;
  occurredAt: Date;
  /** Mais de 24 h sem entrega, ou OTP já vencido: não deve ser enviado. */
  abandon: boolean;
};

/** Escolas com eventos prontos (função SECURITY DEFINER, spec 6.3). */
export async function listSchoolsWithPendingEvents(): Promise<string[]> {
  const { rows } = await sql<{ schoolId: string }>`SELECT school_id FROM list_schools_with_pending_events()`.execute(getDb());
  return rows.map((r) => r.schoolId);
}

/**
 * Reserva até `limit` eventos prontos: trava com SKIP LOCKED e arrenda por 2 min antes de qualquer HTTP,
 * para outro dispatcher não pegar o mesmo evento enquanto este envia.
 */
export async function claim(trx: Trx, limit: number): Promise<ClaimedEvent[]> {
  const { rows } = await sql<ClaimedEvent>`
    WITH c AS (
      SELECT id FROM outbox_events
      WHERE delivered_at IS NULL AND failed_at IS NULL AND next_attempt_at <= now()
      ORDER BY next_attempt_at, id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE outbox_events o SET next_attempt_at = now() + interval '2 minutes'
    FROM c WHERE o.id = c.id
    RETURNING o.id, o.type, o.data::text AS data, o.occurred_at,
      (o.occurred_at < now() - interval '24 hours'
        OR (o.type = 'auth.otp_requested' AND (o.data->>'expires_at')::timestamptz <= now())) AS abandon`.execute(trx);
  return rows.sort((a, b) => (a.id < b.id ? -1 : 1));
}

const SCRUB_OTP = sql`CASE WHEN type = 'auth.otp_requested' THEN '{}'::jsonb ELSE data END`;

export async function markDelivered(trx: Trx, id: string): Promise<void> {
  await sql`
    UPDATE outbox_events SET delivered_at = now(), attempts = attempts + 1, data = ${SCRUB_OTP}
    WHERE id = ${id} AND delivered_at IS NULL AND failed_at IS NULL`.execute(trx);
}

export async function markAttemptFailed(trx: Trx, id: string): Promise<void> {
  await sql`
    UPDATE outbox_events SET
      attempts = attempts + 1,
      next_attempt_at = now() + least(power(2, least(attempts, 6)) * interval '1 minute', interval '60 minutes'),
      failed_at = CASE WHEN occurred_at < now() - interval '24 hours' THEN now() END,
      data = CASE WHEN occurred_at < now() - interval '24 hours' THEN ${SCRUB_OTP} ELSE data END
    WHERE id = ${id} AND delivered_at IS NULL AND failed_at IS NULL`.execute(trx);
}

export async function abandon(trx: Trx, id: string): Promise<void> {
  await sql`
    UPDATE outbox_events SET failed_at = now(), data = ${SCRUB_OTP}
    WHERE id = ${id} AND delivered_at IS NULL AND failed_at IS NULL`.execute(trx);
}
```

Em `eslint.config.js`, acrescente `"apps/api/src/modules/outbox/repo.ts"` aos `ignores` da regra de `getDb`.

- [ ] **Step 4: Serviço**

`apps/api/src/modules/outbox/service.ts`:

```ts
import { OutboxEnvelope } from "@app-lanche/contracts";
import type { FastifyBaseLogger } from "fastify";
import { withTenant } from "../../db/index";
import { config } from "../../platform/config";
import { signInternal } from "../../platform/hmac";
import * as repo from "./repo";

export type DispatchCounts = { delivered: number; failed: number; abandoned: number };
export type DispatchResult = DispatchCounts & { schools: number };

const BATCH = 50;
const MAX_BATCHES_PER_SCHOOL = 4;
const TIMEOUT_MS = 10_000;

/** Monta o POST assinado para o n8n (spec 6.1: mesmo esquema, outro segredo). */
export function signedEventRequest(envelope: OutboxEnvelope): { url: string; headers: Record<string, string>; body: string } {
  const { n8nEventsUrl, n8nHmacSecret } = config();
  if (!n8nEventsUrl || !n8nHmacSecret) throw new Error("n8n is not configured");
  const url = new URL(n8nEventsUrl);
  const body = JSON.stringify(OutboxEnvelope.parse(envelope));
  const timestamp = new Date().toISOString();
  return {
    url: url.toString(),
    body,
    headers: {
      "content-type": "application/json",
      "x-timestamp": timestamp,
      "x-signature": signInternal(n8nHmacSecret, { method: "POST", path: url.pathname + url.search, timestamp, body }),
    },
  };
}

async function post(envelope: OutboxEnvelope): Promise<number | null> {
  const req = signedEventRequest(envelope);
  try {
    const res = await fetch(req.url, { method: "POST", headers: req.headers, body: req.body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    await res.arrayBuffer().catch(() => undefined);
    return res.status;
  } catch {
    return null;
  }
}

/** Entrega os eventos prontos de uma escola. Nunca lança por falha do n8n. */
export async function dispatchSchool(schoolId: string, log: FastifyBaseLogger): Promise<DispatchCounts> {
  const counts: DispatchCounts = { delivered: 0, failed: 0, abandoned: 0 };
  if (!config().n8nEventsUrl) return counts;
  for (let i = 0; i < MAX_BATCHES_PER_SCHOOL; i += 1) {
    const events = await withTenant(schoolId, (trx) => repo.claim(trx, BATCH));
    if (events.length === 0) break;
    for (const e of events) {
      if (e.abandon) {
        await withTenant(schoolId, (trx) => repo.abandon(trx, e.id));
        counts.abandoned += 1;
        log.warn({ event_id: e.id, event_type: e.type, school_id: schoolId }, "outbox event abandoned");
        continue;
      }
      const status = await post({
        id: e.id,
        type: e.type,
        school_id: schoolId,
        occurred_at: e.occurredAt.toISOString(),
        data: JSON.parse(e.data) as Record<string, unknown>,
      });
      if (status !== null && status >= 200 && status < 300) {
        await withTenant(schoolId, (trx) => repo.markDelivered(trx, e.id));
        counts.delivered += 1;
      } else {
        await withTenant(schoolId, (trx) => repo.markAttemptFailed(trx, e.id));
        counts.failed += 1;
        log.warn({ event_id: e.id, event_type: e.type, school_id: schoolId, status }, "outbox delivery failed");
      }
    }
    if (events.length < BATCH) break;
  }
  return counts;
}

/** Job do Cloud Scheduler: todas as escolas com eventos prontos, uma por vez. `schoolIds` restringe (testes). */
export async function dispatchOutbox(opts: { log: FastifyBaseLogger; schoolIds?: string[] }): Promise<DispatchResult> {
  const result: DispatchResult = { schools: 0, delivered: 0, failed: 0, abandoned: 0 };
  if (!config().n8nEventsUrl) return result;
  const pending = await repo.listSchoolsWithPendingEvents();
  const schools = opts.schoolIds ? pending.filter((id) => opts.schoolIds!.includes(id)) : pending;
  for (const schoolId of schools) {
    const c = await dispatchSchool(schoolId, opts.log);
    result.schools += 1;
    result.delivered += c.delivered;
    result.failed += c.failed;
    result.abandoned += c.abandoned;
  }
  return result;
}
```

- [ ] **Step 5: Rodar e commitar**

Run: `pnpm --filter @app-lanche/api test -- src/modules/outbox src/platform && pnpm typecheck && pnpm lint` → PASS. Rode também a suíte inteira da API uma vez (`pnpm test:api`): os testes de OTP leem o código em `outbox_events.data` e precisam continuar passando (o dispatcher não roda neles porque `N8N_EVENTS_URL` não está definido no ambiente de teste).

```bash
git add apps/api/src/platform/config.ts apps/api/src/platform/config.test.ts apps/api/src/modules/outbox apps/api/test/setupEnv.ts eslint.config.js
git commit -m "feat(api): dispatch outbox events to n8n with backoff and OTP scrubbing"
```

---

### Task 6: Jobs do Cloud Scheduler, disparo imediato e fechamento de segurança

**Files:**
- Modify: `apps/api/src/db/index.ts` (`afterCommit`)
- Modify: `apps/api/src/platform/outbox.ts`, `apps/api/src/platform/outbox.test.ts`
- Create: `apps/api/src/platform/jobAuth.ts`
- Modify: `apps/api/src/app.ts` (`RouteAuth` `"job"`, vínculo `/jobs/`, `preHandler`, kick handler, `jobRoutes`)
- Modify: `apps/api/src/modules/outbox/service.ts` (`kickOutbox`)
- Modify: `apps/api/src/modules/serviceDays/service.ts` (`safetyClose`)
- Create: `apps/api/src/modules/jobs/routes.ts`, `apps/api/src/modules/jobs/jobs.test.ts`
- Modify: `apps/api/src/modules/serviceDays/close.test.ts` (caso de `safetyClose`)
- Modify: `apps/api/src/modules/outbox/dispatch.test.ts` (caso de `kickOutbox`)
- Modify: `packages/contracts/src/internal.ts` (`JobDispatchResponse`, `SafetyCloseResponse`)
- Modify: `apps/api/src/app.test.ts` (vínculo de prefixo)
- Modify: `docs/deploy.md`, spec (3, 5.6, 6.3)

**Interfaces:**
- Consumes: `dispatchOutbox`, `dispatchSchool` (Task 5); `listDueActions` (Task 3); `closeServiceDay` (F2).
- Produces: `afterCommit(trx: Trx, fn: () => void): void` em `db/index.ts`; `setOutboxKickHandler(handler: (schoolId: string) => void): void` em `platform/outbox.ts`; `kickOutbox(schoolId: string, log: FastifyBaseLogger): void`; `safetyClose(opts: { log: FastifyBaseLogger; schoolIds?: string[] }): Promise<{ closed: number; failed: number }>`; rotas `POST /jobs/v1/outbox/dispatch` e `POST /jobs/v1/service-days/safety-close`.

- [ ] **Step 1: `afterCommit` e kick (testes falham)**

Em `apps/api/src/platform/outbox.test.ts`, acrescente:

```ts
  it("kicks the dispatcher only after the transaction commits", async () => {
    const schoolId = await createSchool();
    const kicked: string[] = [];
    setOutboxKickHandler((id) => kicked.push(id));
    try {
      await withTenant(schoolId, async (trx) => {
        await enqueueEvent(trx, schoolId, { type: "service_day.closed", data: { service_date: "2031-07-01", orders: 0, late_credits: 0 } });
        expect(kicked).toEqual([]);
      });
      expect(kicked).toEqual([schoolId]);
      await expect(
        withTenant(schoolId, async (trx) => {
          await enqueueEvent(trx, schoolId, { type: "service_day.closed", data: { service_date: "2031-07-02", orders: 0, late_credits: 0 } });
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      expect(kicked).toEqual([schoolId]);
    } finally {
      setOutboxKickHandler(() => undefined);
    }
  });
```

(imports: `setOutboxKickHandler` de `./outbox`, `withTenant` de `../db/index`, `createSchool` de `../../test/helpers`, conforme o que o arquivo já importa.)

Em `dispatch.test.ts`, acrescente:

```ts
  it("delivers right after commit when kicked", async () => {
    const schoolId = await createSchool();
    await seedTenant(schoolId);
    setOutboxKickHandler((id) => kickOutbox(id, log));
    try {
      const id = await otp(schoolId);
      await vi.waitFor(() => expect(forSchool(schoolId).some((e) => e.id === id)).toBe(true), { timeout: 5000 });
    } finally {
      setOutboxKickHandler(() => undefined);
    }
  });
```

(imports: `vi` de `vitest`, `setOutboxKickHandler` de `../../platform/outbox`, `kickOutbox` de `./service`.)

- [ ] **Step 2: Implementar `afterCommit` e o kick**

`apps/api/src/db/index.ts`:

```ts
const commitHooks = new WeakMap<Trx, Array<() => void>>();

/** Agenda `fn` para depois do commit da transação de `withTenant`; não roda se ela desfizer. */
export function afterCommit(trx: Trx, fn: () => void): void {
  const hooks = commitHooks.get(trx);
  if (hooks) hooks.push(fn);
  else commitHooks.set(trx, [fn]);
}

/** Único caminho para ler ou gravar dados de uma escola. */
export async function withTenant<T>(schoolId: string, fn: (trx: Trx) => Promise<T>): Promise<T> {
  let current: Trx | undefined;
  const result = await getDb()
    .transaction()
    .execute(async (trx) => {
      current = trx;
      await sql`SELECT set_config('app.school_id', ${schoolId}, true)`.execute(trx);
      return fn(trx);
    });
  const hooks = current && commitHooks.get(current);
  if (current) commitHooks.delete(current);
  for (const hook of hooks ?? []) {
    try {
      hook();
    } catch {
      // Gancho é melhor esforço; quem precisa de garantia usa o job.
    }
  }
  return result;
}
```

`apps/api/src/platform/outbox.ts`:

```ts
import { afterCommit, type Trx } from "../db/index";

let kickHandler: (schoolId: string) => void = () => undefined;

/** O app registra aqui o disparo imediato do dispatcher (platform não importa módulos). */
export function setOutboxKickHandler(handler: (schoolId: string) => void): void {
  kickHandler = handler;
}
```

e, em `enqueueEvent`, depois do `insert`: `afterCommit(trx, () => kickHandler(schoolId));`.

`apps/api/src/modules/outbox/service.ts`:

```ts
const running = new Map<string, { again: boolean }>();

/** Disparo imediato após um commit: não bloqueia a requisição; repete se outro kick chegar durante o envio. */
export function kickOutbox(schoolId: string, log: FastifyBaseLogger): void {
  if (!config().n8nEventsUrl) return;
  const state = running.get(schoolId);
  if (state) {
    state.again = true;
    return;
  }
  const mine = { again: false };
  running.set(schoolId, mine);
  void (async () => {
    try {
      do {
        mine.again = false;
        await dispatchSchool(schoolId, log);
      } while (mine.again);
    } catch (err) {
      log.warn({ school_id: schoolId, err_name: (err as Error).name }, "outbox kick failed");
    } finally {
      running.delete(schoolId);
    }
  })();
}
```

Run: `pnpm --filter @app-lanche/api test -- src/platform/outbox src/modules/outbox` → PASS.

- [ ] **Step 3: Fechamento de segurança (teste falha)**

Em `serviceDays/close.test.ts`, acrescente:

```ts
describe("safetyClose", () => {
  it("closes only days 10 minutes past the cutoff", async () => {
    const schoolId = await createSchool();
    await seedTenant(schoolId);
    const overdue = await seedServiceDay(schoolId, { serviceDate: "2031-08-01", cutoffInMinutes: -11 });
    const frozen = await seedServiceDay(schoolId, { serviceDate: "2031-08-02", cutoffInMinutes: -7 });
    const result = await safetyClose({ log: silentLog, schoolIds: [schoolId] });
    expect(result).toEqual({ closed: 1, failed: 0 });
    const days = await adminDb().selectFrom("serviceDays").select(["id", "status"]).where("id", "in", [overdue.serviceDayId, frozen.serviceDayId]).execute();
    expect(Object.fromEntries(days.map((d) => [d.id, d.status]))).toEqual({ [overdue.serviceDayId]: "closed", [frozen.serviceDayId]: "open" });
  });
});
```

(use o logger silencioso que o arquivo já usa para `closeServiceDay`, ou `const silentLog = { warn: () => undefined, info: () => undefined, error: () => undefined } as never;`.)

Em `serviceDays/service.ts`:

```ts
/** Fecha dias que passaram 10 min do corte sem o n8n fechar (spec 5.6). `schoolIds` restringe (testes). */
export async function safetyClose(opts: { log: FastifyBaseLogger; schoolIds?: string[] }): Promise<{ closed: number; failed: number }> {
  const due = (await listDueActions()).filter(
    (d) => d.action === "close_service_day" && d.overdue && (!opts.schoolIds || opts.schoolIds.includes(d.schoolId)),
  );
  let closed = 0;
  let failed = 0;
  for (const d of due) {
    try {
      await closeServiceDay(d.schoolId, d.serviceDate, { log: opts.log });
      closed += 1;
    } catch (err) {
      failed += 1;
      opts.log.error({ school_id: d.schoolId, service_date: d.serviceDate, err_name: (err as Error).name }, "safety close failed");
    }
  }
  return { closed, failed };
}
```

- [ ] **Step 4: Autenticação de job e rotas (testes falham)**

`packages/contracts/src/internal.ts`:

```ts
export const JobDispatchResponse = z.object({
  schools: z.number().int().nonnegative(),
  delivered: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  abandoned: z.number().int().nonnegative(),
});
export type JobDispatchResponse = z.infer<typeof JobDispatchResponse>;

export const SafetyCloseResponse = z.object({ closed: z.number().int().nonnegative(), failed: z.number().int().nonnegative() });
export type SafetyCloseResponse = z.infer<typeof SafetyCloseResponse>;
```

`apps/api/src/modules/jobs/jobs.test.ts` (as rotas percorrem todas as escolas, então o teste espiona os serviços):

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../app";
import * as outbox from "../outbox/service";
import * as serviceDays from "../serviceDays/service";

const TOKEN = "test-jobs-token-with-at-least-32-chars";

afterEach(() => vi.restoreAllMocks());

describe("Cloud Scheduler job routes", () => {
  it("dispatches the outbox with the job token", async () => {
    const spy = vi.spyOn(outbox, "dispatchOutbox").mockResolvedValue({ schools: 2, delivered: 3, failed: 0, abandoned: 1 });
    const res = await buildApp().inject({ method: "POST", url: "/jobs/v1/outbox/dispatch", headers: { "x-job-token": TOKEN } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ schools: 2, delivered: 3, failed: 0, abandoned: 1 });
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]![0].schoolIds).toBeUndefined();
  });

  it("runs the safety close with the job token", async () => {
    const spy = vi.spyOn(serviceDays, "safetyClose").mockResolvedValue({ closed: 1, failed: 0 });
    const res = await buildApp().inject({ method: "POST", url: "/jobs/v1/service-days/safety-close", headers: { "x-job-token": TOKEN } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ closed: 1, failed: 0 });
    expect(spy).toHaveBeenCalledOnce();
  });

  it("rejects a missing or wrong token without running anything", async () => {
    const spy = vi.spyOn(outbox, "dispatchOutbox");
    const app = buildApp();
    for (const headers of [{}, { "x-job-token": "nope" }, { authorization: `Bearer ${TOKEN}` }]) {
      const res = await app.inject({ method: "POST", url: "/jobs/v1/outbox/dispatch", headers });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("unauthenticated");
    }
    expect(spy).not.toHaveBeenCalled();
  });
});
```

Se `vi.spyOn` não conseguir redefinir a exportação ESM (erro "Cannot redefine property"), as rotas chamam os serviços por um objeto exportado — `export const jobs = { dispatchOutbox, safetyClose }` em `modules/jobs/routes.ts` — e o teste espiona `jobs`; registre a escolha no relatório.

Em `app.test.ts`, acrescente (seguindo o padrão dos testes de `/internal/` e `/webhooks/` existentes):

```ts
  it("binds the job auth to the /jobs/ prefix", () => {
    const outside = buildApp();
    outside.post("/api/v1/x", { config: { auth: "job" } }, async () => ({}));
    expect(() => outside.ready()).rejects.toThrow(/must live under \/jobs\//);
    const inside = buildApp();
    inside.post("/jobs/v1/x", { config: { auth: "public" } }, async () => ({}));
    expect(() => inside.ready()).rejects.toThrow(/under \/jobs\/ and must use auth "job"/);
  });
```

(ajuste a forma — `await expect(app.ready()).rejects…` ou captura síncrona do `onRoute` — à que os testes de prefixo existentes usam.)

`apps/api/src/platform/jobAuth.ts`:

```ts
import type { FastifyRequest } from "fastify";
import { config } from "./config";
import { DomainError } from "./errors";
import { safeEqual } from "./hmac";

/** Rotas do Cloud Scheduler: o agendador envia um cabeçalho fixo, não calcula HMAC. */
export function verifyJobRequest(req: FastifyRequest): void {
  const token = req.headers["x-job-token"];
  if (typeof token !== "string" || !safeEqual(token, config().jobsToken)) throw new DomainError("unauthenticated");
}
```

`apps/api/src/modules/jobs/routes.ts`:

```ts
import type { JobDispatchResponse, SafetyCloseResponse } from "@app-lanche/contracts";
import type { FastifyInstance } from "fastify";
import * as outbox from "../outbox/service";
import * as serviceDays from "../serviceDays/service";

const JOB = { config: { auth: "job" as const } };

export async function jobRoutes(app: FastifyInstance): Promise<void> {
  app.post("/jobs/v1/outbox/dispatch", JOB, async (req): Promise<JobDispatchResponse> => outbox.dispatchOutbox({ log: req.log }));
  app.post("/jobs/v1/service-days/safety-close", JOB, async (req): Promise<SafetyCloseResponse> =>
    serviceDays.safetyClose({ log: req.log }),
  );
}
```

`app.ts`:
- `RouteAuth` ganha `| "job"`.
- No `onRoute`, depois do bloco de webhook:

```ts
    const jobPrefix = route.url.startsWith("/jobs/");
    const jobAuth = route.config.auth === "job";
    if (jobPrefix && !jobAuth) {
      throw new Error(`route ${String(route.method)} ${route.url} is under /jobs/ and must use auth "job"`);
    }
    if (jobAuth && !jobPrefix) {
      throw new Error(`route ${String(route.method)} ${route.url} uses auth "job" and must live under /jobs/`);
    }
```

- No `preHandler`: `else if (auth === "job") verifyJobRequest(req);` antes do ramo de sessão.
- `redact` ganha `"req.headers['x-job-token']"`.
- Depois de criar o app: `setOutboxKickHandler((schoolId) => kickOutbox(schoolId, app.log));`
- `app.register(jobRoutes);`

- [ ] **Step 5: Documentação**

`docs/deploy.md`, nova seção "Jobs e n8n":
- variáveis novas: `JOBS_TOKEN` (obrigatória, ≥ 32), `N8N_EVENTS_URL` e `N8N_HMAC_SECRET` (juntas; sem elas a outbox fica pendente), todas via `--set-secrets`;
- Cloud Scheduler (região `southamerica-east1`, fuso `America/Sao_Paulo`), alvo HTTP na URL do Cloud Run (não do Hosting), método `POST`, cabeçalho `X-Job-Token: <JOBS_TOKEN>`:
  - `outbox-dispatch`: `* * * * *` → `/jobs/v1/outbox/dispatch`;
  - `safety-close`: `*/5 * * * *` → `/jobs/v1/service-days/safety-close`;
  - exemplo `gcloud scheduler jobs create http outbox-dispatch --schedule="* * * * *" --uri="$RUN_URL/jobs/v1/outbox/dispatch" --http-method=POST --headers="X-Job-Token=$JOBS_TOKEN" --location=southamerica-east1 --time-zone=America/Sao_Paulo`.

Spec:
- seção 3, linha do Cloud Scheduler: "(dispatcher da outbox e fechamento de segurança em `/jobs/v1/**` com `X-Job-Token`; conciliação na F6)";
- 5.6, último parágrafo: "Um Cloud Scheduler chama `POST /jobs/v1/service-days/safety-close` a cada 5 min e fecha qualquer dia que passou 10 min do corte, caso o n8n esteja fora.";
- 6.3: troque o bloco "Pendências do dispatcher (fase F3)" por: "O dispatcher usa a função `list_schools_with_pending_events()` (quinta consulta sem tenant, além das quatro da seção 4.4), reserva eventos com `FOR UPDATE SKIP LOCKED` e arrendamento de 2 min, e envia fora de transação. Retry: `next_attempt_at = now() + min(2^tentativas, 60) min`; depois de 24 h o evento é abandonado (`failed_at`). Após entregar um `auth.otp_requested`, o `data` vira `{}`; um OTP vencido não é enviado e também é apagado. O disparo imediato roda depois do commit (`afterCommit`); o job de 1 min (`POST /jobs/v1/outbox/dispatch`) garante a entrega." Na seção 14, retire "limpeza do código do OTP na outbox antes de qualquer envio real (F3)" das pendências.

- [ ] **Step 6: Rodar e commitar**

Run: `pnpm --filter @app-lanche/contracts test && pnpm test:api && pnpm typecheck && pnpm lint` → PASS.

```bash
git add apps/api packages/contracts/src docs/deploy.md docs/superpowers/specs/2026-11-16-app-lanche-design.md
git commit -m "feat(api): add scheduler job routes, post-commit outbox kick and the safety close"
```

---

### Task 7: Fluxos n8n (agenda e eventos) testados contra a API

**Files:**
- Create: `n8n/code/lib.js`, `n8n/code/schedule.js`, `n8n/code/events.js`
- Create: `n8n/build.mjs`
- Create: `n8n/workflows/schedule.json`, `n8n/workflows/events.json` (gerados pelo build a partir do esqueleto abaixo)
- Create: `apps/api/test/n8n.test.ts`
- Modify: `package.json` (script `n8n:build`), `eslint.config.js` (ignorar `n8n/code/**`)
- Create: `docs/n8n.md`

**Interfaces:**
- Consumes: rotas internas (Tasks 2–4); `signedEventRequest` (Task 5); `internalRequest` não é usado — o código do n8n assina sozinho e o teste verifica que a API aceita.
- Produces: fluxos importáveis no n8n; variáveis de ambiente do n8n listadas em `docs/n8n.md`.

- [ ] **Step 1: Código compartilhado dos Code nodes**

`n8n/code/lib.js` (é prefixado em cada Code node; roda no n8n com `NODE_FUNCTION_ALLOW_BUILTIN=crypto` e `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`):

```js
// ---- lib.js (gerado em cada Code node por n8n/build.mjs; edite em n8n/code/lib.js) ----
const crypto = require("crypto");
const API = String($env.APP_LANCHE_API_URL || "").replace(/\/+$/, "");

function sign(secret, method, pathWithQuery, timestamp, body) {
  return crypto
    .createHmac("sha256", secret)
    .update(`${method.toUpperCase()}\n${pathWithQuery}\n${timestamp}\n${body}`)
    .digest("hex");
}

function parseBody(body) {
  if (body === undefined || body === null || body === "") return null;
  if (Buffer.isBuffer(body)) body = body.toString("utf8");
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }
  return body;
}

/** Chamada assinada à API (spec 6.1). Devolve { status, body }. */
async function api(ctx, method, path, payload) {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const timestamp = new Date().toISOString();
  const headers = {
    authorization: `Bearer ${$env.APP_LANCHE_SERVICE_TOKEN}`,
    "x-timestamp": timestamp,
    "x-signature": sign($env.APP_LANCHE_HMAC_SECRET, method, path, timestamp, body),
  };
  if (method === "POST") headers["idempotency-key"] = crypto.randomUUID();
  if (body !== "") headers["content-type"] = "application/json";
  const res = await ctx.helpers.httpRequest({
    method,
    url: API + path,
    headers,
    body: body === "" ? undefined : body,
    json: false,
    returnFullResponse: true,
    ignoreHttpStatusErrors: true,
  });
  return { status: res.statusCode, body: parseBody(res.body) };
}

function ensureOk(res, what) {
  if (res.status < 200 || res.status >= 300) {
    const code = res.body && res.body.error ? res.body.error.code : "unknown";
    throw new Error(`${what} failed: ${res.status} ${code}`);
  }
  return res.body;
}

/** WhatsApp Cloud API, mensagem de modelo. Parâmetros sem quebra de linha. */
async function whatsapp(ctx, to, template, params, extraComponents) {
  const components = [
    { type: "body", parameters: params.map((p) => ({ type: "text", text: String(p).replace(/\s+/g, " ").trim() })) },
    ...(extraComponents || []),
  ];
  const res = await ctx.helpers.httpRequest({
    method: "POST",
    url: `https://graph.facebook.com/${$env.WHATSAPP_API_VERSION || "v21.0"}/${$env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    headers: { authorization: `Bearer ${$env.WHATSAPP_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: String(to).replace(/^\+/, ""),
      type: "template",
      template: { name: template, language: { code: "pt_BR" }, components },
    }),
    json: false,
    returnFullResponse: true,
    ignoreHttpStatusErrors: true,
  });
  const body = parseBody(res.body);
  if (res.statusCode >= 200 && res.statusCode < 300) {
    const id = body && body.messages && body.messages[0] && body.messages[0].id;
    return { ok: true, id: id || "unknown" };
  }
  const code = body && body.error && body.error.code;
  return { ok: false, error: code === 131026 || code === 100 ? "invalid_number" : typeof code === "number" ? `wa_${code}` : "send_failed" };
}

/** Centavos inteiros → "R$ 1.234,56" (sem ponto flutuante). */
function brl(cents) {
  const reais = String(Math.trunc(cents / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `R$ ${reais},${String(Math.abs(cents % 100)).padStart(2, "0")}`;
}

function joinNames(names) {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} e ${names[names.length - 1]}`;
}

/** "2026-11-17" → "17/11". */
function dayMonth(isoDate) {
  const [, m, d] = isoDate.split("-");
  return `${d}/${m}`;
}
// ---- fim de lib.js ----
```

- [ ] **Step 2: Fluxo da agenda**

`n8n/code/schedule.js`:

```js
// Agenda (a cada 5 min): lembretes e fechamento do dia (spec 6.2).
async function closeDay(ctx, a) {
  const res = await api(ctx, "POST", `/internal/v1/service-days/${a.school_id}/${a.service_date}/close`);
  if (res.status === 409) return { closed: false, reason: res.body && res.body.error ? res.body.error.code : "conflict" };
  const m = ensureOk(res, "close");
  if (m.kitchen_phone && $env.WA_TEMPLATE_KITCHEN) {
    const items = m.totals.by_item.map((i) => `${i.qty}x ${i.item}`).join("; ") || "nenhum item";
    const sent = await whatsapp(ctx, m.kitchen_phone, $env.WA_TEMPLATE_KITCHEN, [dayMonth(a.service_date), m.totals.orders, items]);
    return { closed: true, orders: m.totals.orders, kitchen_notified: sent.ok };
  }
  return { closed: true, orders: m.totals.orders, kitchen_notified: false };
}

async function sendReminders(ctx, a) {
  let cursor = null;
  let sent = 0;
  let failed = 0;
  for (let page = 0; page < 50; page += 1) {
    const res = await api(ctx, "POST", `/internal/v1/schools/${a.school_id}/reminders/prepare`, { service_date: a.service_date, cursor });
    if (res.status === 409) break;
    const body = ensureOk(res, "prepare");
    const results = [];
    for (const r of body.recipients) {
      const out = await whatsapp(ctx, r.phone, $env.WA_TEMPLATE_REMINDER, [
        r.first_name,
        joinNames(r.students),
        r.cutoff_local_time,
        brl(r.wallet_balance_cents),
        r.link_url,
      ]);
      if (out.ok) {
        sent += 1;
        results.push({ guardian_id: r.guardian_id, status: "sent", wa_message_id: out.id });
      } else {
        failed += 1;
        results.push({ guardian_id: r.guardian_id, status: "failed", error: out.error });
      }
    }
    if (results.length > 0) {
      ensureOk(await api(ctx, "POST", `/internal/v1/schools/${a.school_id}/reminders/${body.batch_id}/deliveries`, { results }), "deliveries");
    }
    cursor = body.next_cursor;
    if (!cursor) break;
  }
  return { sent, failed };
}

const due = ensureOk(await api(this, "GET", "/internal/v1/schedule/due"), "schedule").due;
const out = [];
for (const a of due) {
  const base = { action: a.action, school_id: a.school_id, service_date: a.service_date };
  try {
    const result = a.action === "close_service_day" ? await closeDay(this, a) : await sendReminders(this, a);
    out.push({ json: { ...base, ok: true, ...result } });
  } catch (err) {
    out.push({ json: { ...base, ok: false, error: String((err && err.message) || err).slice(0, 200) } });
  }
}
return out.length > 0 ? out : [{ json: { idle: true } }];
```

- [ ] **Step 3: Fluxo de eventos**

`n8n/code/events.js`:

```js
// Webhook de eventos da outbox (spec 6.3). Erro → resposta 500 → o dispatcher tenta de novo.
const MAX_SKEW_MS = 5 * 60 * 1000;
const item = $input.first();
const headers = item.json.headers || {};
const raw = (await this.helpers.getBinaryDataBuffer(0, "data")).toString("utf8");
const timestamp = String(headers["x-timestamp"] || "");
const signature = String(headers["x-signature"] || "");
const expected = sign($env.APP_LANCHE_EVENTS_SECRET, "POST", $env.APP_LANCHE_EVENTS_PATH, timestamp, raw);
const skew = Math.abs(Date.now() - Date.parse(timestamp));
const a = Buffer.from(signature);
const b = Buffer.from(expected);
if (!(Number.isFinite(skew) && skew <= MAX_SKEW_MS && a.length === b.length && crypto.timingSafeEqual(a, b))) {
  throw new Error("invalid signature");
}

const event = JSON.parse(raw);
const seen = $getWorkflowStaticData("global");
seen.events = seen.events || {};
const now = Date.now();
for (const [id, at] of Object.entries(seen.events)) if (now - at > 3 * 24 * 3600 * 1000) delete seen.events[id];
if (seen.events[event.id]) return [{ json: { ok: true, duplicate: true, email: null } }];

const d = event.data;
let email = null;
async function send(to, template, params, extra) {
  const res = await whatsapp(this, to, template, params, extra);
  if (!res.ok) throw new Error(`whatsapp failed: ${res.error}`);
}

switch (event.type) {
  case "auth.otp_requested":
    if (d.channel === "email") {
      email = { to: d.to, subject: "Seu código de acesso", text: `Seu código de acesso é ${d.code}. Ele vale por 5 minutos.` };
    } else {
      await send.call(this, d.to, $env.WA_TEMPLATE_OTP, [d.code], [
        { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: d.code }] },
      ]);
    }
    break;
  case "payment.confirmed":
    await send.call(this, d.phone, $env.WA_TEMPLATE_PAYMENT_CONFIRMED, [d.first_name, joinNames(d.students), dayMonth(d.service_date), brl(d.total_cents)]);
    break;
  case "payment.late_credited":
    await send.call(this, d.phone, $env.WA_TEMPLATE_LATE_CREDIT, [d.first_name, brl(d.amount_cents), brl(d.wallet_balance_cents)]);
    break;
  default:
    // service_day.closed e tipos futuros: aceitos sem mensagem.
    break;
}
// E-mail sai no nó seguinte; não entra na deduplicação (código repetido é inofensivo).
if (!email) seen.events[event.id] = now;
return [{ json: { ok: true, type: event.type, email } }];
```

- [ ] **Step 4: Esqueletos dos fluxos e build**

`n8n/workflows/schedule.json` (o `jsCode` é preenchido pelo build):

```json
{
  "name": "App Lanche — agenda (lembretes e fechamento)",
  "nodes": [
    {
      "parameters": { "rule": { "interval": [{ "field": "minutes", "minutesInterval": 5 }] } },
      "id": "5f0c2f7e-1d1a-4b55-9a39-1a3f7c2b9e01",
      "name": "Every 5 minutes",
      "type": "n8n-nodes-base.scheduleTrigger",
      "typeVersion": 1.2,
      "position": [0, 0]
    },
    {
      "parameters": { "jsCode": "" },
      "id": "5f0c2f7e-1d1a-4b55-9a39-1a3f7c2b9e02",
      "name": "Run due actions",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [260, 0],
      "notes": "code:schedule.js"
    }
  ],
  "connections": {
    "Every 5 minutes": { "main": [[{ "node": "Run due actions", "type": "main", "index": 0 }]] }
  },
  "settings": { "executionOrder": "v1", "timezone": "America/Sao_Paulo" },
  "active": false
}
```

`n8n/workflows/events.json`:

```json
{
  "name": "App Lanche — eventos da outbox",
  "nodes": [
    {
      "parameters": { "httpMethod": "POST", "path": "app-lanche-events", "responseMode": "lastNode", "options": { "rawBody": true } },
      "id": "8b7e7a40-3c55-4c1e-8f3e-6a0d2b1c4f01",
      "name": "Events webhook",
      "type": "n8n-nodes-base.webhook",
      "typeVersion": 2,
      "position": [0, 0],
      "webhookId": "8b7e7a40-3c55-4c1e-8f3e-6a0d2b1c4f0a"
    },
    {
      "parameters": { "jsCode": "" },
      "id": "8b7e7a40-3c55-4c1e-8f3e-6a0d2b1c4f02",
      "name": "Verify and send",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [260, 0],
      "notes": "code:events.js"
    },
    {
      "parameters": { "conditions": { "boolean": [{ "value1": "={{ !!$json.email }}", "value2": true }] } },
      "id": "8b7e7a40-3c55-4c1e-8f3e-6a0d2b1c4f03",
      "name": "Needs e-mail?",
      "type": "n8n-nodes-base.if",
      "typeVersion": 1,
      "position": [520, 0]
    },
    {
      "parameters": {
        "fromEmail": "={{ $env.APP_LANCHE_EMAIL_FROM }}",
        "toEmail": "={{ $json.email.to }}",
        "subject": "={{ $json.email.subject }}",
        "emailFormat": "text",
        "text": "={{ $json.email.text }}",
        "options": {}
      },
      "id": "8b7e7a40-3c55-4c1e-8f3e-6a0d2b1c4f04",
      "name": "Send e-mail",
      "type": "n8n-nodes-base.emailSend",
      "typeVersion": 2.1,
      "position": [780, -100]
    }
  ],
  "connections": {
    "Events webhook": { "main": [[{ "node": "Verify and send", "type": "main", "index": 0 }]] },
    "Verify and send": { "main": [[{ "node": "Needs e-mail?", "type": "main", "index": 0 }]] },
    "Needs e-mail?": { "main": [[{ "node": "Send e-mail", "type": "main", "index": 0 }], []] }
  },
  "settings": { "executionOrder": "v1", "timezone": "America/Sao_Paulo" },
  "active": false
}
```

`n8n/build.mjs`:

```js
// Gera o jsCode de cada Code node marcado com "notes": "code:<arquivo>" = lib.js + "\n" + <arquivo>.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

export function codeFor(file) {
  const lib = readFileSync(join(root, "code", "lib.js"), "utf8");
  return `${lib}\n${readFileSync(join(root, "code", file), "utf8")}`;
}

export function buildWorkflow(workflow) {
  for (const node of workflow.nodes) {
    const match = /^code:(.+)$/.exec(node.notes ?? "");
    if (match) node.parameters.jsCode = codeFor(match[1]);
  }
  return workflow;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = join(root, "workflows");
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const path = join(dir, name);
    const built = buildWorkflow(JSON.parse(readFileSync(path, "utf8")));
    writeFileSync(path, `${JSON.stringify(built, null, 2)}\n`);
  }
}
```

`package.json` (raiz): `"n8n:build": "node n8n/build.mjs"`. No `eslint.config.js`, acrescente `"n8n/code/**"` aos `ignores` globais (os Code nodes usam `return`/`await` no topo e globais do n8n).

Rode `pnpm n8n:build` e confira que os dois JSON têm `jsCode` preenchido.

- [ ] **Step 5: Teste dos fluxos contra a API (falha antes do build, passa depois)**

`apps/api/test/n8n.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { resetConfigForTests } from "../src/platform/config";
import { signedEventRequest } from "../src/modules/outbox/service";
import { adminDb, createSchool, seedFamily, seedServiceDay } from "./helpers";

const ROOT = join(__dirname, "..", "..", "..", "n8n");
const require_ = createRequire(import.meta.url);
const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<unknown>;

type Workflow = { nodes: { name: string; notes?: string; parameters: { jsCode?: string } }[] };
const workflow = (file: string): Workflow => JSON.parse(readFileSync(join(ROOT, "workflows", file), "utf8"));
const code = (file: string, node: string) => workflow(file).nodes.find((n) => n.name === node)!.parameters.jsCode!;

const ENV = {
  APP_LANCHE_API_URL: "https://api.test",
  APP_LANCHE_SERVICE_TOKEN: process.env.INTERNAL_SERVICE_TOKEN,
  APP_LANCHE_HMAC_SECRET: process.env.INTERNAL_HMAC_SECRET,
  APP_LANCHE_EVENTS_SECRET: "test-n8n-hmac-secret-with-at-least-32-chars",
  APP_LANCHE_EVENTS_PATH: "/webhook/app-lanche-events",
  WHATSAPP_PHONE_NUMBER_ID: "123",
  WHATSAPP_TOKEN: "wa-token",
  WA_TEMPLATE_REMINDER: "lembrete_lanche",
  WA_TEMPLATE_KITCHEN: "resumo_cozinha",
  WA_TEMPLATE_OTP: "codigo_acesso",
  WA_TEMPLATE_PAYMENT_CONFIRMED: "pedido_confirmado",
  WA_TEMPLATE_LATE_CREDIT: "credito_atrasado",
};

type Sent = { to: string; template: string; params: string[] };

/** Executa um Code node como o n8n: `this.helpers`, `$env`, `$input`, `$getWorkflowStaticData`, `require`. */
function harness(onlySchool: string) {
  const app = buildApp();
  const whatsapp: Sent[] = [];
  const helpers = {
    async httpRequest(o: { method: string; url: string; headers: Record<string, string>; body?: string }) {
      if (o.url.startsWith("https://graph.facebook.com/")) {
        const msg = JSON.parse(o.body!);
        whatsapp.push({
          to: msg.to,
          template: msg.template.name,
          params: msg.template.components[0].parameters.map((p: { text: string }) => p.text),
        });
        return { statusCode: 200, body: JSON.stringify({ messages: [{ id: `wamid.${whatsapp.length}` }] }), headers: {} };
      }
      const path = o.url.slice(ENV.APP_LANCHE_API_URL.length);
      const res = await app.inject({ method: o.method as "GET" | "POST", url: path, headers: o.headers, ...(o.body ? { payload: o.body } : {}) });
      let body = res.body;
      // Agenda compartilhada entre arquivos de teste: o fluxo só enxerga a escola deste teste.
      if (path === "/internal/v1/schedule/due" && res.statusCode === 200) {
        body = JSON.stringify({ due: res.json().due.filter((d: { school_id: string }) => d.school_id === onlySchool) });
      }
      return { statusCode: res.statusCode, body, headers: res.headers };
    },
    async getBinaryDataBuffer(): Promise<Buffer> {
      throw new Error("set per run");
    },
  };
  async function run(jsCode: string, opts: { input?: unknown; staticData?: Record<string, unknown>; raw?: string } = {}) {
    const staticData = opts.staticData ?? {};
    const ctx = { helpers: { ...helpers, getBinaryDataBuffer: async () => Buffer.from(opts.raw ?? "") } };
    const fn = new AsyncFunction("$env", "$input", "$getWorkflowStaticData", "require", jsCode);
    return (await fn.call(ctx, ENV, { first: () => opts.input, all: () => [opts.input] }, () => staticData, require_)) as { json: Record<string, unknown> }[];
  }
  return { run, whatsapp };
}

describe("n8n workflows", () => {
  it("are built from n8n/code", async () => {
    // @ts-expect-error -- build.mjs não tem tipos
    const { buildWorkflow } = await import("../../../n8n/build.mjs");
    for (const file of ["schedule.json", "events.json"]) {
      const current = workflow(file);
      expect(buildWorkflow(structuredClone(current))).toEqual(current);
      expect(current.nodes.filter((n) => n.notes?.startsWith("code:")).every((n) => (n.parameters.jsCode ?? "").length > 0)).toBe(true);
    }
  });

  it("sends reminders once and records deliveries", async () => {
    const schoolId = await createSchool();
    const fam = await seedFamily(schoolId, ["Léo", "Bia"]);
    const day = await seedServiceDay(schoolId, { serviceDate: "2031-09-01", cutoffInMinutes: 60 });
    const h = harness(schoolId);
    const out = await h.run(code("schedule.json", "Run due actions"));
    expect(out).toEqual([{ json: expect.objectContaining({ action: "send_reminders", school_id: schoolId, ok: true, sent: 1, failed: 0 }) }]);
    expect(h.whatsapp).toHaveLength(1);
    const msg = h.whatsapp[0]!;
    expect(msg.template).toBe("lembrete_lanche");
    expect(msg.params.slice(0, 2)).toEqual(["Ana", "Bia e Léo"]);
    expect(msg.params[3]).toBe("R$ 0,00");
    expect(msg.params[4]).toMatch(/^https:\/\/app\.test\/l#/);
    const delivery = await adminDb().selectFrom("messageDeliveries").select(["status", "waMessageId"]).where("guardianId", "=", fam.guardianId).executeTakeFirstOrThrow();
    expect(delivery).toEqual({ status: "sent", waMessageId: "wamid.1" });
    const again = await h.run(code("schedule.json", "Run due actions"));
    expect(again).toEqual([{ json: { idle: true } }]);
    expect(h.whatsapp).toHaveLength(1);
    expect(day.serviceDate).toBe("2031-09-01");
  });

  it("closes the day and sends the kitchen summary", async () => {
    const schoolId = await createSchool();
    await adminDb().updateTable("schools").set({ kitchenPhone: "+5511988880000" }).where("id", "=", schoolId).execute();
    await seedServiceDay(schoolId, { serviceDate: "2031-09-02", cutoffInMinutes: -6 });
    const h = harness(schoolId);
    const out = await h.run(code("schedule.json", "Run due actions"));
    expect(out[0]!.json).toMatchObject({ action: "close_service_day", ok: true, closed: true, kitchen_notified: true });
    expect(h.whatsapp).toEqual([{ to: "5511988880000", template: "resumo_cozinha", params: ["02/09", "0", "nenhum item"] }]);
    const day = await adminDb().selectFrom("serviceDays").select("status").where("schoolId", "=", schoolId).where("serviceDate", "=", "2031-09-02").executeTakeFirstOrThrow();
    expect(day.status).toBe("closed");
  });

  describe("events", () => {
    const withN8n = async <T>(fn: () => Promise<T>): Promise<T> => {
      process.env.N8N_EVENTS_URL = "https://n8n.test/webhook/app-lanche-events";
      process.env.N8N_HMAC_SECRET = ENV.APP_LANCHE_EVENTS_SECRET;
      resetConfigForTests();
      try {
        return await fn();
      } finally {
        delete process.env.N8N_EVENTS_URL;
        delete process.env.N8N_HMAC_SECRET;
        resetConfigForTests();
      }
    };
    const envelope = (id: string, type: string, data: Record<string, unknown>) => ({
      id,
      type,
      school_id: crypto.randomUUID(),
      occurred_at: new Date().toISOString(),
      data,
    });

    it("verifies the dispatcher signature, sends the OTP and deduplicates", async () => {
      const id = crypto.randomUUID();
      const req = await withN8n(async () =>
        signedEventRequest(envelope(id, "auth.otp_requested", { channel: "whatsapp", to: "+5511999990001", first_name: "Ana", code: "123456", expires_at: new Date(Date.now() + 300_000).toISOString() })),
      );
      const h = harness(crypto.randomUUID());
      const staticData = {};
      const input = { json: { headers: req.headers } };
      const out = await h.run(code("events.json", "Verify and send"), { input, raw: req.body, staticData });
      expect(out).toEqual([{ json: { ok: true, type: "auth.otp_requested", email: null } }]);
      expect(h.whatsapp).toEqual([{ to: "5511999990001", template: "codigo_acesso", params: ["123456"] }]);
      const dup = await h.run(code("events.json", "Verify and send"), { input, raw: req.body, staticData });
      expect(dup[0]!.json).toMatchObject({ duplicate: true });
      expect(h.whatsapp).toHaveLength(1);
    });

    it("rejects a tampered body", async () => {
      const req = await withN8n(async () => signedEventRequest(envelope(crypto.randomUUID(), "service_day.closed", { service_date: "2031-09-03", orders: 1, late_credits: 0 })));
      const h = harness(crypto.randomUUID());
      await expect(
        h.run(code("events.json", "Verify and send"), { input: { json: { headers: req.headers } }, raw: req.body.replace('"orders":1', '"orders":2') }),
      ).rejects.toThrow("invalid signature");
    });

    it("hands e-mail OTPs to the e-mail node and formats payment messages", async () => {
      const h = harness(crypto.randomUUID());
      const emailReq = await withN8n(async () =>
        signedEventRequest(envelope(crypto.randomUUID(), "auth.otp_requested", { channel: "email", to: "x@escola.test", first_name: null, code: "654321", expires_at: new Date(Date.now() + 300_000).toISOString() })),
      );
      const emailOut = await h.run(code("events.json", "Verify and send"), { input: { json: { headers: emailReq.headers } }, raw: emailReq.body });
      expect(emailOut[0]!.json.email).toMatchObject({ to: "x@escola.test", subject: "Seu código de acesso" });
      expect(h.whatsapp).toHaveLength(0);
      const payReq = await withN8n(async () =>
        signedEventRequest(envelope(crypto.randomUUID(), "payment.confirmed", { guardian_id: crypto.randomUUID(), phone: "+5511999990002", first_name: "Ana", checkout_id: crypto.randomUUID(), service_date: "2031-09-04", students: ["Léo", "Bia"], total_cents: 123456 })),
      );
      await h.run(code("events.json", "Verify and send"), { input: { json: { headers: payReq.headers } }, raw: payReq.body });
      expect(h.whatsapp).toEqual([{ to: "5511999990002", template: "pedido_confirmado", params: ["Ana", "Léo e Bia", "04/09", "R$ 1.234,56"] }]);
    });
  });
});
```

Notas para o executor:
- O teste importa `n8n/build.mjs` por caminho relativo; se o `tsc` do `apps/api` reclamar do import mesmo com `@ts-expect-error`, troque por `await import(pathToFileURL(join(ROOT, "build.mjs")).href)`.
- `seedFamily` cria "Infantil 3A" por escola; `seedServiceDay` usa nomes de item únicos — não há colisão entre testes.
- Se o `getBinaryDataBuffer` do harness precisar de assinatura `(itemIndex, propertyName)`, aceite os parâmetros e ignore-os.

Run: `pnpm --filter @app-lanche/api test -- test/n8n` → PASS.

- [ ] **Step 6: Documentação do n8n**

`docs/n8n.md`:
- Importar `n8n/workflows/schedule.json` e `events.json` (Workflows → Import from File); ativar ambos. Não editar o código no editor do n8n: editar `n8n/code/*.js`, rodar `pnpm n8n:build` e reimportar.
- Variáveis do contêiner do n8n: `NODE_FUNCTION_ALLOW_BUILTIN=crypto`, `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`, `APP_LANCHE_API_URL` (URL do Cloud Run, sem barra final), `APP_LANCHE_SERVICE_TOKEN` (= `INTERNAL_SERVICE_TOKEN`), `APP_LANCHE_HMAC_SECRET` (= `INTERNAL_HMAC_SECRET`), `APP_LANCHE_EVENTS_SECRET` (= `N8N_HMAC_SECRET` da API), `APP_LANCHE_EVENTS_PATH` (= `pathname` de `N8N_EVENTS_URL`, ex. `/webhook/app-lanche-events`), `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_API_VERSION` (opcional, padrão `v21.0`), `WA_TEMPLATE_REMINDER`, `WA_TEMPLATE_KITCHEN`, `WA_TEMPLATE_OTP`, `WA_TEMPLATE_PAYMENT_CONFIRMED`, `WA_TEMPLATE_LATE_CREDIT`, `APP_LANCHE_EMAIL_FROM`; credencial SMTP no nó "Send e-mail".
- Modelos do WhatsApp (categoria e parâmetros na ordem): lembrete (utility) — `{{1}}` primeiro nome, `{{2}}` filhos, `{{3}}` horário de corte, `{{4}}` saldo, `{{5}}` link; resumo da cozinha (utility) — data, total de pedidos, itens; código (authentication) — código + botão de copiar; pedido confirmado (utility) — nome, filhos, data, total; crédito atrasado (utility) — nome, valor, saldo. Sugestão de texto de cada modelo em português.
- Na API: `N8N_EVENTS_URL=https://<n8n>/webhook/app-lanche-events` e `N8N_HMAC_SECRET`.
- Itens a confirmar na homologação (não verificados sem um n8n real): `this.helpers.httpRequest` com `json: false` envia o corpo exatamente como a string assinada; o Webhook v2 com `rawBody` entrega o corpo em `binary.data` legível por `getBinaryDataBuffer(0, "data")`; com `responseMode: "lastNode"` um erro no Code node responde 500 e o ramo falso do IF responde 200; o caminho recebido atrás do proxy da VPS bate com `APP_LANCHE_EVENTS_PATH`; os modelos aprovados aceitam o link como parâmetro de texto.

- [ ] **Step 7: Rodar tudo e commitar**

Run: `pnpm typecheck && pnpm lint && pnpm test` → PASS.

```bash
git add n8n package.json eslint.config.js apps/api/test/n8n.test.ts docs/n8n.md
git commit -m "feat(n8n): add the schedule and outbox event workflows with tested code nodes"
```

---

## Verificação final da fase

- `pnpm typecheck && pnpm lint && pnpm test` passando; `pnpm --filter @app-lanche/api build` e `pnpm --filter @app-lanche/web build` passando.
- `grep -rn "getDb()" apps/api/src/modules` só encontra chamadas a funções `SECURITY DEFINER` em `repo.ts`.
- Nenhum log novo contém telefone, e-mail, nome, link, código ou corpo de evento (`grep -n "log\.\(warn\|info\|error\)" ` nos arquivos novos).
- Spec 3, 4.1, 5.6, 6.2, 6.3 e 14 atualizadas; `docs/deploy.md` e `docs/n8n.md` escritos.
