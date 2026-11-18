# F4 — KDS offline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A cozinha pareia um tablet uma vez e, a partir daí, vê o romaneio do dia e marca entregas mesmo sem internet; os eventos sincronizam sem perda nem duplicata quando a rede volta.

**Architecture:** Na API, o pareamento troca um código de uso único (gerado pela secretaria) por uma sessão `kitchen` de 30 dias no cookie `__session`, renovada a cada sincronização e aceita vencida enquanto o dispositivo estiver ativo. Rotas `/api/kds/v1/**` servem o romaneio (ou a prévia), recebem eventos de entrega idempotentes por `event_id` e devolvem as mudanças de outros tablets. Na web, a área `kds` lê e escreve só no IndexedDB (Dexie); um módulo `sync` é o único que fala com a API, no evento `online`, a cada 15 s e no retorno de foco. Um teste Playwright contra a pilha real (Postgres + API + PWA de produção com service worker) desliga a rede, marca entregas, religa e confere o banco.

**Tech Stack:** Fastify 5, Kysely, PostgreSQL 16 (RLS), zod 4, React 19, react-router 8, vite-plugin-pwa, **Dexie 4** (novo, previsto no CLAUDE.md), **@playwright/test** (novo, previsto no CLAUDE.md), Vitest.

**Spec:** `docs/superpowers/specs/2026-11-16-app-lanche-design.md` (seções 4.3, 4.4, 7, 9, 10, 13, 14)

## Global Constraints

- Todo acesso ao banco dentro de `withTenant(schoolId, …)`; `school_id` vem da sessão ou de uma função `resolve_*`. A única consulta sem tenant nova desta fase é `resolve_pairing_code(code_hash)` (já listada na spec 4.4), com `search_path = pg_catalog, public, pg_temp`, `REVOKE ALL … FROM PUBLIC`, `GRANT EXECUTE … TO app_user`, chamada com `getDb()` só em `modules/auth/repo.ts` (já liberado no ESLint).
- Toda tabela nova: `school_id uuid NOT NULL`, RLS `tenant_isolation`, `UNIQUE (school_id, <id>)`, FKs compostas; entra em `TENANT_TABLES` (ordem alfabética) e em `seedTenant`.
- Toda rota declara `config.auth`; rotas de tablet usam `{ kind: "kitchen" }`. A cada requisição `kitchen`, o dispositivo é relido do banco (`kind = 'kitchen'`, pareado, `revoked_at IS NULL`); revogar vale na hora.
- CLAUDE.md 32–36 (KDS): componentes de `areas/kds` não chamam a API, só o módulo `sync`; marcar entrega = uma transação IndexedDB que atualiza `orderState` e insere na `outbox`; evento só sai da `outbox` depois de o servidor devolver o `event_id` como aceito (ou recusado em definitivo); sem Background Sync API; `event_id` é UUID gerado no cliente e é a chave primária no servidor.
- Estado de um pedido = o do evento com maior `occurred_at`; empate resolvido pelo maior `event_id` (comparação de texto). Mesma regra no cliente e no servidor.
- Entrega só é registrada para pedido de dia `closed`: antes do fechamento o KDS mostra a prévia, com marcação desabilitada, e o servidor recusa o evento (`rejected`). Assim o romaneio congelado nunca perde um pedido marcado antes da hora.
- O servidor confirma eventos com `INSERT … ON CONFLICT (event_id) DO NOTHING`; repetir um lote não duplica nada.
- Logs só com ids. Respostas de `/api/**` com `Cache-Control: private, no-store` (já global).
- Texto de interface em português do Brasil, exatamente como o plano dá; código e commits em inglês.
- Contratos novos em `packages/contracts/src/kds.ts`; corpos de `/api` em `camelCase`; o conteúdo do romaneio reutiliza `ManifestContent` (snake_case, spec 6.2).
- Dependências novas permitidas nesta fase, e só estas: `dexie` (dependência da web) e `@playwright/test` (devDependency da raiz). Nada de `dexie-react-hooks`, `fake-indexeddb` ou outra.
- Migração aplicada nunca é editada; esta fase cria a `0008`.
- Antes de cada commit: `pnpm typecheck && pnpm lint` e os testes do pacote tocado.

## Decisões da fase (o executor não reabre)

1. **Pareamento:** a secretaria (`admin`/`secretaria`) gera um código de 8 caracteres do alfabeto `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (sem 0/O/1/I/L), válido por 10 min pelo relógio do banco; o banco guarda só o SHA-256. O tablet troca o código em `POST /api/kds/v1/pair` (rota pública, naturalmente idempotente como as de autenticação: o código é consumido por `UPDATE … WHERE pairing_code_hash = … AND pairing_expires_at > now()`). Índice único parcial em `devices (pairing_code_hash)` resolve a pendência da spec 14.
2. **Sessão `kitchen`:** claims `{ kind: "kitchen", sub: device_id, schoolId }`, TTL 30 dias, reemitida em toda resposta das rotas `/api/kds/v1/**`. Um token `kitchen` vencido há até 90 dias ainda é aceito se o dispositivo estiver ativo (spec 7.3, item 6); o dispositivo não guarda segredo próprio — a revogação em `devices` é o controle.
3. **Cookie compartilhado:** o tablet usa o mesmo `__session` (o Firebase Hosting só repassa esse); um navegador pareado como KDS não deve ser usado para login de equipe — documentado.
4. **Eventos recusados:** `POST /api/kds/v1/events` devolve `{ accepted, rejected }`. Recusado = pedido inexistente para a escola, dia ainda aberto, ou pedido em estado sem entrega (`pending`, `expired`, `expired_late`, `cancelled`). O cliente remove os dois da `outbox`; recusado nunca vai voltar a ser aceito.
5. **`orders.status`:** após gravar os eventos, o servidor aplica o estado vencedor por pedido: `confirmed → delivered` ou `delivered → confirmed`, com `UPDATE … WHERE status = '<anterior>'`. Travas: `service_days` `FOR SHARE` primeiro (dias dos pedidos do lote), depois os pedidos.
6. **Cursor de mudanças:** texto `received_at` (ISO) do último evento devolvido; o servidor devolve eventos com `received_at > since - 1 minuto` (janela que cobre transações que começaram antes e commitaram depois) e o cliente deduplica por `event_id`. Sem `since`, devolve todos os eventos do dia.
7. **Data do KDS:** `/kds` usa a data local do tablet; `/kds?date=YYYY-MM-DD` força outra (usado no e2e e para conferência).
8. **Testes da web:** jsdom não tem IndexedDB e não se adiciona `fake-indexeddb`. A lógica pura (mesclagem de estado, selo, lotes) é testada com Vitest; Dexie, sync e telas do KDS são cobertos pelo Playwright contra a pilha real.
9. **E2E:** Postgres do `docker compose` (`pnpm db:up`), banco dedicado `app_lanche_e2e` recriado no `globalSetup`; API (`tsx apps/api/src/server.ts`, porta 8080) e `vite preview` (porta 4173, proxy `/api` herdado de `server.proxy`) como `webServer` do Playwright. `APP_BASE_URL=http://localhost:4173` (o Chromium aceita cookie `Secure` em `localhost`).

---

## Mapa de arquivos

```
db/migrations/0008_kds.sql                                   (Task 1)
packages/contracts/src/kds.ts (+test), index.ts              (Task 1)
apps/api/src/db/{types.ts,rls.test.ts,schema.test.ts}        (Task 1)
apps/api/test/helpers.ts                                      seedTenant, kitchenCookie, seedClosedDayWithOrders (Tasks 1, 2, 3)
apps/api/src/platform/session.ts (+test)                      kind kitchen, carência (Task 2)
apps/api/src/app.ts                                           kitchen re-check, rotas (Tasks 2, 3)
apps/api/src/modules/auth/{repo,service}.ts                   resolve_pairing_code (Task 2)
apps/api/src/modules/kds/{routes,service,repo}.ts (+tests)    pareamento, romaneio, eventos, mudanças (Tasks 2, 3)
apps/api/src/modules/serviceDays/service.ts                   previewManifest (Task 3)
apps/web/src/areas/kds/{state,badge}.ts (+tests)              lógica pura (Task 4)
apps/web/src/areas/kds/{db,sync,useLive}.ts                   Dexie e sincronização (Task 4)
apps/web/src/areas/kds/{KdsPair,KdsBoard}.tsx                 telas (Task 5)
apps/web/src/areas/admin/KitchenDevicesAdmin.tsx (+test)      pareamento pela secretaria (Task 5)
apps/web/src/app/App.tsx, ui/messages.ts                      rotas e mensagens (Task 5)
e2e/{playwright.config.ts,global-setup.ts,kds.spec.ts}        (Task 6)
package.json, .github/workflows/ci.yml, docs/deploy.md, spec  (Task 6)
```

---

### Task 1: Esquema e contratos do KDS

**Files:**
- Create: `db/migrations/0008_kds.sql`
- Create: `packages/contracts/src/kds.ts`, `packages/contracts/src/kds.test.ts`; Modify: `packages/contracts/src/index.ts`
- Regenerate: `apps/api/src/db/types.ts`
- Modify: `apps/api/src/db/rls.test.ts`, `apps/api/src/db/schema.test.ts`, `apps/api/test/helpers.ts`

**Interfaces:**
- Produces: tabela `delivery_events (event_id PK, school_id, order_id, device_id, type 'delivered'|'undelivered', occurred_at, received_at)`; índice único parcial `devices_pairing_code`; função `resolve_pairing_code(p_code_hash text) → (school_id uuid, device_id uuid)`.
- Produces (contracts): `PairingCodeResponse`, `KitchenDevice`, `KitchenDeviceListResponse`, `KdsPairRequest`, `KdsPairResponse`, `KdsManifestResponse`, `DeliveryEventType`, `KdsEvent`, `KdsEventsRequest`, `KdsEventsResponse`, `KdsChangeEvent`, `KdsChangesResponse`.
- Produces: `SeedIds` ganha `kitchenDeviceId` (o dispositivo de cozinha que `seedTenant` já cria) e `deliveryEventId`.

- [ ] **Step 1: Contratos (teste falha)**

`packages/contracts/src/kds.ts`:

```ts
import { z } from "zod";
import { IsoDate, IsoDateTime, Uuid } from "./common";
import { ManifestContent } from "./manifest";

export const PAIRING_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const PairingCode = z.string().regex(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);

/** POST /api/admin/v1/kds/pairing-codes */
export const PairingCodeResponse = z.object({ deviceId: Uuid, code: PairingCode, expiresAt: IsoDateTime });
export type PairingCodeResponse = z.infer<typeof PairingCodeResponse>;

/** GET /api/admin/v1/kds/devices */
export const KitchenDevice = z.object({
  id: Uuid,
  createdAt: IsoDateTime,
  paired: z.boolean(),
  revokedAt: IsoDateTime.nullable(),
});
export const KitchenDeviceListResponse = z.object({ devices: z.array(KitchenDevice) });
export type KitchenDeviceListResponse = z.infer<typeof KitchenDeviceListResponse>;

/** POST /api/kds/v1/pair */
export const KdsPairRequest = z.object({ code: z.string().transform((s) => s.trim().toUpperCase()).pipe(PairingCode) }).strict();
export const KdsPairResponse = z.object({ deviceId: Uuid });
export type KdsPairResponse = z.infer<typeof KdsPairResponse>;

/** GET /api/kds/v1/manifest/:date — romaneio congelado ou prévia parcial. */
export const KdsManifestResponse = z.object({
  serviceDate: IsoDate,
  status: z.enum(["open", "closed"]),
  manifestVersion: z.number().int().positive().nullable(),
  content: ManifestContent,
});
export type KdsManifestResponse = z.infer<typeof KdsManifestResponse>;

export const DeliveryEventType = z.enum(["delivered", "undelivered"]);
export type DeliveryEventType = z.infer<typeof DeliveryEventType>;

export const KdsEvent = z.object({
  eventId: Uuid,
  orderId: Uuid,
  type: DeliveryEventType,
  occurredAt: IsoDateTime,
});
export type KdsEvent = z.infer<typeof KdsEvent>;

/** POST /api/kds/v1/events */
export const KdsEventsRequest = z.object({ events: z.array(KdsEvent).min(1).max(100) }).strict();
export type KdsEventsRequest = z.infer<typeof KdsEventsRequest>;
export const KdsEventsResponse = z.object({ accepted: z.array(Uuid), rejected: z.array(Uuid) });
export type KdsEventsResponse = z.infer<typeof KdsEventsResponse>;

/** GET /api/kds/v1/changes?date=&since= */
export const KdsChangeEvent = KdsEvent.extend({ deviceId: Uuid });
export type KdsChangeEvent = z.infer<typeof KdsChangeEvent>;
export const KdsChangesResponse = z.object({ events: z.array(KdsChangeEvent), cursor: z.string().nullable() });
export type KdsChangesResponse = z.infer<typeof KdsChangesResponse>;
```

`index.ts`: `export * from "./kds";` (ordem alfabética).

`packages/contracts/src/kds.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { KdsEventsRequest, KdsPairRequest, PAIRING_ALPHABET } from "./kds";

const E = "0193a3b0-0000-7000-8000-000000000001";

describe("kds contracts", () => {
  it("normalizes a typed pairing code", () => {
    expect(KdsPairRequest.parse({ code: " abcd2345 " })).toEqual({ code: "ABCD2345" });
  });

  it("rejects ambiguous characters in a pairing code", () => {
    for (const code of ["ABCD234O", "ABCD2341", "ABCDEFGI", "ABCDEFGL", "ABC"]) {
      expect(() => KdsPairRequest.parse({ code })).toThrow();
    }
    expect(PAIRING_ALPHABET).toHaveLength(31);
  });

  it("accepts the delivery event example from spec 7.3 and caps a batch at 100", () => {
    const ev = { eventId: E, orderId: E, type: "delivered", occurredAt: "2026-11-17T10:05:00-03:00" };
    expect(KdsEventsRequest.parse({ events: [ev] })).toEqual({ events: [ev] });
    expect(() => KdsEventsRequest.parse({ events: Array.from({ length: 101 }, () => ev) })).toThrow();
    expect(() => KdsEventsRequest.parse({ events: [] })).toThrow();
  });
});
```

- [ ] **Step 2: Testes de esquema (falham)**

`rls.test.ts`: `TENANT_TABLES` ganha `"delivery_events"` (depois de `"classes"`, antes de `"devices"`).

`schema.test.ts`:

```ts
describe("F4 schema", () => {
  it("pins resolve_pairing_code and keeps it away from PUBLIC", async () => {
    const { rows } = await sql<{ proconfig: string[]; prosecdef: boolean; publicExec: boolean }>`
      SELECT proconfig, prosecdef, has_function_privilege('public', oid, 'EXECUTE') AS public_exec
      FROM pg_proc WHERE proname = 'resolve_pairing_code'`.execute(adminDb());
    expect(rows).toEqual([{ proconfig: ["search_path=pg_catalog, public, pg_temp"], prosecdef: true, publicExec: false }]);
  });

  it("makes delivery events append-only for the application", async () => {
    const { rows } = await sql<{ update: boolean; del: boolean; ins: boolean }>`
      SELECT has_table_privilege('app_user', 'delivery_events', 'UPDATE') AS update,
             has_table_privilege('app_user', 'delivery_events', 'DELETE') AS del,
             has_table_privilege('app_user', 'delivery_events', 'INSERT') AS ins`.execute(adminDb());
    expect(rows[0]).toEqual({ update: false, del: false, ins: true });
  });

  it("keeps a pairing code unique while it is set", async () => {
    const schoolId = await createSchool();
    const insert = () =>
      adminDb().insertInto("devices").values({ id: uuidv7(), schoolId, kind: "kitchen", pairingCodeHash: "same-hash", pairingExpiresAt: new Date(Date.now() + 60_000) }).execute();
    await insert();
    await expect(insert()).rejects.toThrow(/devices_pairing_code/);
  });

  it("resolves a pairing code hash to its school and device, only while unexpired", async () => {
    const schoolId = await createSchool();
    const live = uuidv7();
    const dead = uuidv7();
    await adminDb().insertInto("devices").values([
      { id: live, schoolId, kind: "kitchen", pairingCodeHash: `live-${live}`, pairingExpiresAt: sql`now() + interval '5 minutes'` },
      { id: dead, schoolId, kind: "kitchen", pairingCodeHash: `dead-${dead}`, pairingExpiresAt: sql`now() - interval '1 second'` },
    ]).execute();
    const resolve = async (hash: string) =>
      (await sql<{ schoolId: string; deviceId: string }>`SELECT school_id, device_id FROM resolve_pairing_code(${hash})`.execute(getDb())).rows;
    expect(await resolve(`live-${live}`)).toEqual([{ schoolId, deviceId: live }]);
    expect(await resolve(`dead-${dead}`)).toEqual([]);
  });

  it("refuses a delivery event for an order of another school", async () => {
    const a = await createSchool();
    const b = await createSchool();
    const seedA = await seedTenant(a);
    const seedB = await seedTenant(b);
    await expect(
      adminDb().insertInto("deliveryEvents").values({ eventId: uuidv7(), schoolId: a, orderId: seedB.orderId, deviceId: seedA.kitchenDeviceId, type: "delivered", occurredAt: new Date() }).execute(),
    ).rejects.toThrow(/foreign key/i);
  });
});
```

Run: `pnpm --filter @app-lanche/api exec vitest run src/db` → FAIL.

- [ ] **Step 3: Migração**

`db/migrations/0008_kds.sql`:

```sql
-- F4: KDS offline — eventos de entrega e pareamento de tablet (spec 4.4, 7, 9).

-- Pendência da spec 14: código de pareamento com índice único próprio.
CREATE UNIQUE INDEX devices_pairing_code ON devices (pairing_code_hash) WHERE pairing_code_hash IS NOT NULL;

CREATE TABLE delivery_events (
  event_id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  order_id uuid NOT NULL,
  device_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('delivered', 'undelivered')),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, event_id),
  FOREIGN KEY (school_id, order_id) REFERENCES orders (school_id, id),
  FOREIGN KEY (school_id, device_id) REFERENCES devices (school_id, id)
);

CREATE INDEX delivery_events_order ON delivery_events (school_id, order_id, occurred_at DESC, event_id DESC);
CREATE INDEX delivery_events_received ON delivery_events (school_id, received_at);

ALTER TABLE delivery_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON delivery_events USING (school_id = app_school_id());
-- Append-only: o estado vem do evento mais recente; nada é corrigido no lugar.
GRANT SELECT, INSERT ON delivery_events TO app_user;

-- Consulta sem tenant prevista na spec 4.4: só códigos ainda válidos.
CREATE FUNCTION resolve_pairing_code(p_code_hash text)
RETURNS TABLE (school_id uuid, device_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT d.school_id, d.id FROM devices d
  WHERE d.pairing_code_hash = p_code_hash AND d.kind = 'kitchen' AND d.pairing_expires_at > now() AND d.revoked_at IS NULL
$$;

REVOKE ALL ON FUNCTION resolve_pairing_code(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_pairing_code(text) TO app_user;
```

- [ ] **Step 4: Semente e tipos**

Regenere os tipos (comandos no `common-context.md`). Em `helpers.ts`: `SeedIds` ganha `kitchenDeviceId` e `deliveryEventId`; o `insertInto("devices")` de cozinha que já existe passa a usar `ids.kitchenDeviceId`; depois do bloco de `orderItems`:

```ts
  await db
    .insertInto("deliveryEvents")
    .values({ eventId: ids.deliveryEventId, schoolId, orderId: ids.orderId, deviceId: ids.kitchenDeviceId, type: "delivered", occurredAt: new Date() })
    .execute();
```

(gere `kitchenDeviceId` e `deliveryEventId` com `uuidv7()` no literal de `ids`; o insert precisa vir depois de `orders` e de `devices`.)

- [ ] **Step 5: Rodar e commitar**

Run: `pnpm --filter @app-lanche/contracts test && pnpm --filter @app-lanche/api exec vitest run src/db && pnpm typecheck && pnpm lint` → PASS.

```bash
git add db/migrations/0008_kds.sql packages/contracts/src apps/api/src/db apps/api/test/helpers.ts
git commit -m "feat(db): add delivery events, pairing code index and resolve_pairing_code"
```

---

### Task 2: Pareamento e sessão de cozinha

**Files:**
- Modify: `apps/api/src/platform/session.ts`, `apps/api/src/platform/session.test.ts`
- Modify: `apps/api/src/app.ts` (re-check de dispositivo `kitchen`; registrar `kdsRoutes`)
- Modify: `apps/api/src/modules/auth/repo.ts` (`resolvePairingCode`), `apps/api/src/modules/auth/service.ts` (`loadActiveKitchenDevice`)
- Create: `apps/api/src/modules/kds/repo.ts`, `apps/api/src/modules/kds/service.ts`, `apps/api/src/modules/kds/routes.ts`, `apps/api/src/modules/kds/pairing.test.ts`
- Modify: `apps/api/test/helpers.ts` (`kitchenCookie`)

**Interfaces:**
- Consumes: contratos da Task 1; `idempotent`, `requestHash`, `idempotencyKeyFrom`; `audit`; `hashToken` (`auth/tokens.ts`).
- Produces: `SessionClaims` com `{ kind: "kitchen"; sub: string; schoolId: string }`; `KITCHEN_SESSION_TTL = 30 * 24 * 60 * 60`; `KITCHEN_GRACE_SECONDS = 90 * 24 * 60 * 60`; `generatePairingCode(): string`; `issueKitchenSession(reply, schoolId, deviceId)`; rotas `POST /api/admin/v1/kds/pairing-codes`, `GET /api/admin/v1/kds/devices`, `POST /api/admin/v1/kds/devices/:id/revoke`, `POST /api/kds/v1/pair`; helper `kitchenCookie(schoolId, deviceId?)`.

- [ ] **Step 1: Testes (falham)**

`session.test.ts` — acrescente:

```ts
  it("accepts a kitchen token up to 90 days past its expiry and nothing else past expiry", async () => {
    const schoolId = crypto.randomUUID();
    const sub = crypto.randomUUID();
    const expired = async (kind: "kitchen" | "staff", secondsAgo: number) => {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({ kind, sub, schoolId, role: "admin", purpose: "session" })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt(now - secondsAgo - 60)
        .setExpirationTime(now - secondsAgo)
        .sign(new TextEncoder().encode(process.env.SESSION_SECRET));
    };
    const req = (token: string) => ({ cookies: { [SESSION_COOKIE]: token } }) as never;
    await expect(authenticate(req(await expired("kitchen", 10 * 86400)), { kind: "kitchen" })).resolves.toMatchObject({ kind: "kitchen", sub });
    await expect(authenticate(req(await expired("kitchen", 91 * 86400)), { kind: "kitchen" })).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(authenticate(req(await expired("staff", 10)), { kind: "staff" })).rejects.toMatchObject({ code: "unauthenticated" });
  });
```

(importe `SignJWT` de `jose` e o que faltar.)

`apps/api/src/modules/kds/pairing.test.ts`:

```ts
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { adminDb, createSchool, seedTenant, staffCookie } from "../../../test/helpers";
import { buildApp } from "../../app";
import { SESSION_COOKIE } from "../../platform/session";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ORIGIN = { origin: "https://app.test" };

async function newCode(schoolId: string) {
  const { cookies } = await staffCookie(schoolId, "secretaria");
  const res = await buildApp().inject({
    method: "POST",
    url: "/api/admin/v1/kds/pairing-codes",
    cookies,
    headers: { ...ORIGIN, "idempotency-key": crypto.randomUUID() },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { deviceId: string; code: string; expiresAt: string };
}

describe("kitchen pairing", () => {
  it("creates a 10-minute code, stores only its hash, and pairs once", async () => {
    const schoolId = await createSchool();
    await seedTenant(schoolId);
    const { deviceId, code, expiresAt } = await newCode(schoolId);
    expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    const row = await adminDb().selectFrom("devices").selectAll().where("id", "=", deviceId).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ kind: "kitchen", pairingCodeHash: sha(code), revokedAt: null });
    const minutes = (new Date(expiresAt).getTime() - row.createdAt.getTime()) / 60_000;
    expect(minutes).toBeGreaterThan(9.9);
    expect(minutes).toBeLessThan(10.1);

    const app = buildApp();
    const paired = await app.inject({ method: "POST", url: "/api/kds/v1/pair", headers: ORIGIN, payload: { code: code.toLowerCase() } });
    expect(paired.statusCode).toBe(200);
    expect(paired.json()).toEqual({ deviceId });
    expect(paired.cookies.find((c) => c.name === SESSION_COOKIE)?.maxAge).toBe(30 * 24 * 60 * 60);
    const after = await adminDb().selectFrom("devices").select(["pairingCodeHash", "pairingExpiresAt"]).where("id", "=", deviceId).executeTakeFirstOrThrow();
    expect(after).toEqual({ pairingCodeHash: null, pairingExpiresAt: null });

    const again = await app.inject({ method: "POST", url: "/api/kds/v1/pair", headers: ORIGIN, payload: { code } });
    expect(again.statusCode).toBe(401);
    expect(again.json().error.code).toBe("invalid_token");
  });

  it("refuses an expired code", async () => {
    const schoolId = await createSchool();
    await seedTenant(schoolId);
    const { deviceId, code } = await newCode(schoolId);
    await adminDb().updateTable("devices").set({ pairingExpiresAt: new Date(Date.now() - 1000) }).where("id", "=", deviceId).execute();
    const res = await buildApp().inject({ method: "POST", url: "/api/kds/v1/pair", headers: ORIGIN, payload: { code } });
    expect(res.statusCode).toBe(401);
  });

  it("lists kitchen devices and revoking one cuts its session immediately", async () => {
    const schoolId = await createSchool();
    await seedTenant(schoolId);
    const { deviceId, code } = await newCode(schoolId);
    const app = buildApp();
    const paired = await app.inject({ method: "POST", url: "/api/kds/v1/pair", headers: ORIGIN, payload: { code } });
    const kitchen = { [SESSION_COOKIE]: paired.cookies.find((c) => c.name === SESSION_COOKIE)!.value };
    const ok = await app.inject({ method: "GET", url: "/api/kds/v1/manifest/2031-10-01", cookies: kitchen });
    expect(ok.statusCode).not.toBe(401);

    const { cookies } = await staffCookie(schoolId, "admin");
    const list = await app.inject({ method: "GET", url: "/api/admin/v1/kds/devices", cookies });
    expect(list.json().devices).toContainEqual(expect.objectContaining({ id: deviceId, paired: true, revokedAt: null }));
    const revoke = await app.inject({ method: "POST", url: `/api/admin/v1/kds/devices/${deviceId}/revoke`, cookies, headers: ORIGIN });
    expect(revoke.statusCode).toBe(204);
    const cut = await app.inject({ method: "GET", url: "/api/kds/v1/manifest/2031-10-01", cookies: kitchen });
    expect(cut.statusCode).toBe(401);
  });

  it("does not let a kitchen role staff user or a guardian create codes", async () => {
    const schoolId = await createSchool();
    await seedTenant(schoolId);
    const { cookies } = await staffCookie(schoolId, "cozinha");
    const res = await buildApp().inject({
      method: "POST",
      url: "/api/admin/v1/kds/pairing-codes",
      cookies,
      headers: { ...ORIGIN, "idempotency-key": crypto.randomUUID() },
    });
    expect(res.statusCode).toBe(403);
  });

  it("does not revoke a device of another school", async () => {
    const a = await createSchool();
    const b = await createSchool();
    await seedTenant(a);
    const seedB = await seedTenant(b);
    const { cookies } = await staffCookie(a, "admin");
    const res = await buildApp().inject({ method: "POST", url: `/api/admin/v1/kds/devices/${seedB.kitchenDeviceId}/revoke`, cookies, headers: ORIGIN });
    expect(res.statusCode).toBe(404);
  });
});
```

A rota do romaneio só nasce na Task 3. Neste teste, o `buildApp()` usado para conferir a sessão de cozinha ganha uma rota de teste antes do primeiro `inject`: `app.get("/api/kds/v1/ping", { config: { auth: { kind: "kitchen" } } }, async () => ({ ok: true }))`. As duas chamadas a `/api/kds/v1/manifest/2031-10-01` passam a ser `GET /api/kds/v1/ping` (esperado 200 antes da revogação e 401 depois).

Em `helpers.ts`:

```ts
/** Cookie de tablet pareado; cria o dispositivo pareado se não for informado. */
export async function kitchenCookie(schoolId: string, deviceId?: string): Promise<{ cookies: Record<string, string>; deviceId: string }> {
  const id = deviceId ?? uuidv7();
  if (!deviceId) {
    await adminDb().insertInto("devices").values({ id, schoolId, kind: "kitchen" }).execute();
  }
  const token = await signToken("session", { kind: "kitchen", sub: id, schoolId }, 3600);
  return { cookies: { [SESSION_COOKIE]: token }, deviceId: id };
}
```

- [ ] **Step 2: Sessão**

`session.ts`:
- `SessionClaims` ganha `z.object({ kind: z.literal("kitchen"), sub: z.string().uuid(), schoolId: z.string().uuid() })`.
- `export const KITCHEN_SESSION_TTL = 30 * 24 * 60 * 60;` e `export const KITCHEN_GRACE_SECONDS = 90 * 24 * 60 * 60;`
- `verifyToken(purpose, token, opts: { graceSeconds?: number } = {})` passa `clockTolerance: opts.graceSeconds ?? 0` ao `jwtVerify`.
- `authenticate`: verifica primeiro sem carência; se falhar **e** a rota pede `kind: "kitchen"`, tenta de novo com `graceSeconds: KITCHEN_GRACE_SECONDS` e só aceita se as claims forem `kind: "kitchen"`. Qualquer outro tipo nunca ganha carência.

```ts
export async function authenticate(req: FastifyRequest, auth: Exclude<RouteAuth, string>): Promise<SessionClaims> {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) throw new DomainError("unauthenticated");
  let payload: Record<string, unknown>;
  try {
    payload = await verifyToken("session", token);
  } catch (err) {
    if (auth.kind !== "kitchen") throw err;
    // Spec 7.3 (6): tablet que ficou offline além da validade continua aceito enquanto o dispositivo estiver ativo.
    payload = await verifyToken("session", token, { graceSeconds: KITCHEN_GRACE_SECONDS });
    if (payload.kind !== "kitchen") throw new DomainError("unauthenticated");
  }
  const parsed = SessionClaims.safeParse(payload);
  if (!parsed.success) throw new DomainError("unauthenticated");
  const claims = parsed.data;
  if (claims.kind !== auth.kind) throw new DomainError("insufficient_scope");
  if (claims.kind === "guardian" && auth.scope && claims.scope !== auth.scope) throw new DomainError("insufficient_scope");
  return claims;
}
```

- [ ] **Step 3: Re-check do dispositivo**

`auth/repo.ts`:

```ts
export async function resolvePairingCode(codeHash: string): Promise<{ schoolId: string; deviceId: string } | undefined> {
  const { rows } = await sql<{ schoolId: string; deviceId: string }>`
    SELECT school_id, device_id FROM resolve_pairing_code(${codeHash})`.execute(getDb());
  return rows[0];
}

export async function activeKitchenDevice(trx: Trx, deviceId: string): Promise<boolean> {
  const row = await trx
    .selectFrom("devices")
    .select("id")
    .where("id", "=", deviceId)
    .where("kind", "=", "kitchen")
    .where("revokedAt", "is", null)
    .where("pairingCodeHash", "is", null)
    .executeTakeFirst();
  return row !== undefined;
}
```

`auth/service.ts`: `export async function loadActiveKitchenDevice(schoolId: string, deviceId: string): Promise<boolean>` → `withTenant(schoolId, (trx) => repo.activeKitchenDevice(trx, deviceId))`.

`app.ts`, em `authenticateWithDatabase`: depois do `authenticate`, `if (claims.kind === "kitchen") { if (!(await loadActiveKitchenDevice(claims.schoolId, claims.sub))) throw new DomainError("unauthenticated"); return claims; }`.

- [ ] **Step 4: Módulo `kds` — pareamento e dispositivos**

`apps/api/src/modules/kds/repo.ts`:

```ts
import { sql } from "kysely";
import type { Trx } from "../../db/index";

/** Novo tablet aguardando pareamento; validade de 10 min pelo relógio do banco. */
export async function insertPendingDevice(trx: Trx, row: { id: string; schoolId: string; codeHash: string }): Promise<Date> {
  const { rows } = await sql<{ pairingExpiresAt: Date }>`
    INSERT INTO devices (id, school_id, kind, pairing_code_hash, pairing_expires_at)
    VALUES (${row.id}, ${row.schoolId}, 'kitchen', ${row.codeHash}, now() + interval '10 minutes')
    RETURNING pairing_expires_at`.execute(trx);
  return rows[0]!.pairingExpiresAt;
}

/** Consome o código: só uma troca vence. */
export async function consumePairingCode(trx: Trx, deviceId: string, codeHash: string): Promise<boolean> {
  const res = await sql`
    UPDATE devices SET pairing_code_hash = NULL, pairing_expires_at = NULL
    WHERE id = ${deviceId} AND kind = 'kitchen' AND pairing_code_hash = ${codeHash}
      AND pairing_expires_at > now() AND revoked_at IS NULL`.execute(trx);
  return Number(res.numAffectedRows ?? 0) === 1;
}

export async function listKitchenDevices(trx: Trx) {
  return trx
    .selectFrom("devices")
    .select(["id", "createdAt", "pairingCodeHash", "revokedAt"])
    .where("kind", "=", "kitchen")
    .orderBy("createdAt", "desc")
    .execute();
}

export async function revokeKitchenDevice(trx: Trx, deviceId: string): Promise<"revoked" | "already" | "missing"> {
  const res = await sql`UPDATE devices SET revoked_at = now() WHERE id = ${deviceId} AND kind = 'kitchen' AND revoked_at IS NULL`.execute(trx);
  if (Number(res.numAffectedRows ?? 0) === 1) return "revoked";
  const row = await trx.selectFrom("devices").select("id").where("id", "=", deviceId).where("kind", "=", "kitchen").executeTakeFirst();
  return row ? "already" : "missing";
}
```

`apps/api/src/modules/kds/service.ts`:

```ts
import { PAIRING_ALPHABET, type KitchenDeviceListResponse, type PairingCodeResponse } from "@app-lanche/contracts";
import { randomInt } from "node:crypto";
import { uuidv7 } from "uuidv7";
import { withTenant } from "../../db/index";
import { audit } from "../../platform/audit";
import { DomainError } from "../../platform/errors";
import { idempotent, requestHash } from "../../platform/idempotency";
import type { SessionClaims } from "../../platform/session";
import * as auth from "../auth/service";
import * as repo from "./repo";

export function generatePairingCode(): string {
  let code = "";
  for (let i = 0; i < 8; i += 1) code += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)];
  return code;
}

export async function createPairingCode(session: SessionClaims, key: string): Promise<PairingCodeResponse> {
  const hash = requestHash({ route: "POST /api/admin/v1/kds/pairing-codes", actorId: session.sub, body: {} });
  return withTenant(session.schoolId, async (trx) => {
    const { response } = await idempotent(trx, { schoolId: session.schoolId, key, requestHash: hash }, async () => {
      const deviceId = uuidv7();
      const code = generatePairingCode();
      const expiresAt = await repo.insertPendingDevice(trx, { id: deviceId, schoolId: session.schoolId, codeHash: auth.hashToken(code) });
      await audit(trx, { schoolId: session.schoolId, actorKind: "staff", actorId: session.sub, action: "kds.pairing_code_created", detail: { device_id: deviceId } });
      return { deviceId, code, expiresAt: expiresAt.toISOString() };
    });
    return response;
  });
}

/** Troca o código por uma sessão de cozinha. Código desconhecido, vencido ou já usado: invalid_token. */
export async function pair(code: string): Promise<{ schoolId: string; deviceId: string }> {
  const codeHash = auth.hashToken(code);
  const found = await auth.resolvePairingCode(codeHash);
  if (!found) throw new DomainError("invalid_token");
  const ok = await withTenant(found.schoolId, async (trx) => {
    const consumed = await repo.consumePairingCode(trx, found.deviceId, codeHash);
    if (consumed) await audit(trx, { schoolId: found.schoolId, actorKind: "kitchen", actorId: found.deviceId, action: "kds.paired" });
    return consumed;
  });
  if (!ok) throw new DomainError("invalid_token");
  return found;
}

export async function listDevices(session: SessionClaims): Promise<KitchenDeviceListResponse> {
  const rows = await withTenant(session.schoolId, (trx) => repo.listKitchenDevices(trx));
  return {
    devices: rows.map((d) => ({
      id: d.id,
      createdAt: d.createdAt.toISOString(),
      paired: d.pairingCodeHash === null,
      revokedAt: d.revokedAt ? d.revokedAt.toISOString() : null,
    })),
  };
}

export async function revokeDevice(session: SessionClaims, deviceId: string): Promise<void> {
  await withTenant(session.schoolId, async (trx) => {
    const result = await repo.revokeKitchenDevice(trx, deviceId);
    if (result === "missing") throw new DomainError("not_found");
    if (result === "revoked") {
      await audit(trx, { schoolId: session.schoolId, actorKind: "staff", actorId: session.sub, action: "kds.device_revoked", detail: { device_id: deviceId } });
    }
  });
}
```

(`auth/service.ts` reexporta `hashToken` de `./tokens` e `resolvePairingCode` de `./repo` — o módulo `kds` só usa `auth` pelo `service.ts`.)

`apps/api/src/modules/kds/routes.ts`:

```ts
import { KdsPairRequest, Uuid } from "@app-lanche/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { RouteAuth } from "../../app";
import { idempotencyKeyFrom } from "../../platform/idempotency";
import { issueSession, KITCHEN_SESSION_TTL } from "../../platform/session";
import * as service from "./service";

const OFFICE: RouteAuth = { kind: "staff", roles: ["admin", "secretaria"] };
export const KITCHEN: RouteAuth = { kind: "kitchen" };
const DeviceParams = z.object({ id: Uuid });

/** Toda resposta ao tablet renova a sessão por mais 30 dias (spec 4.3). */
export async function renewKitchen(reply: FastifyReply, schoolId: string, deviceId: string): Promise<void> {
  await issueSession(reply, { kind: "kitchen", sub: deviceId, schoolId }, KITCHEN_SESSION_TTL);
}

export async function kdsRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/admin/v1/kds/pairing-codes", { config: { auth: OFFICE } }, async (req) =>
    service.createPairingCode(req.session!, idempotencyKeyFrom(req)),
  );
  app.get("/api/admin/v1/kds/devices", { config: { auth: OFFICE } }, async (req) => service.listDevices(req.session!));
  app.post("/api/admin/v1/kds/devices/:id/revoke", { config: { auth: OFFICE } }, async (req, reply) => {
    await service.revokeDevice(req.session!, DeviceParams.parse(req.params).id);
    return reply.status(204).send();
  });

  app.post("/api/kds/v1/pair", { config: { auth: "public" } }, async (req, reply) => {
    const { schoolId, deviceId } = await service.pair(KdsPairRequest.parse(req.body).code);
    await renewKitchen(reply, schoolId, deviceId);
    return { deviceId };
  });
}
```

`app.ts`: `app.register(kdsRoutes);`.

A rota pública `pair` passa pelo `assertSameOrigin`? Não: só rotas com sessão passam. O teste envia `origin` mesmo assim, sem efeito.

- [ ] **Step 5: Rodar e commitar**

Run: `pnpm --filter @app-lanche/api exec vitest run src/platform/session.test.ts src/modules/kds && pnpm test:api && pnpm typecheck && pnpm lint` → PASS.

```bash
git add apps/api packages/contracts
git commit -m "feat(api): pair kitchen tablets with one-time codes and a renewable kitchen session"
```

---

### Task 3: Romaneio, eventos de entrega e mudanças para o tablet

**Files:**
- Modify: `apps/api/src/modules/serviceDays/service.ts` (`previewManifest`)
- Modify: `apps/api/src/modules/kds/{repo,service,routes}.ts`
- Create: `apps/api/src/modules/kds/sync.test.ts`
- Modify: `apps/api/test/helpers.ts` (`seedClosedDayWithOrders`)

**Interfaces:**
- Consumes: `closeServiceDay`, `getManifest`, `buildManifest`, `repo.manifestLines` (F2); `catalog.lockServiceDayByDate`; `KITCHEN`, `renewKitchen` (Task 2).
- Produces: `GET /api/kds/v1/manifest/:date` → `KdsManifestResponse`; `POST /api/kds/v1/events` → `KdsEventsResponse`; `GET /api/kds/v1/changes?date=&since=` → `KdsChangesResponse`; `serviceDays.kdsManifest(schoolId, date)`; helper `seedClosedDayWithOrders(schoolId, { serviceDate, students })` → `{ serviceDayId, orderIds: string[] }`.

- [ ] **Step 1: Helper de semente**

Em `helpers.ts`:

```ts
/** Dia já fechado com um pedido confirmado (1x primeiro item) por aluno; romaneio gravado como o fechamento faria. */
export async function seedClosedDayWithOrders(
  schoolId: string,
  opts: { serviceDate: string; studentNames: string[] },
): Promise<{ serviceDayId: string; orderIds: string[] }> {
  const day = await seedServiceDay(schoolId, { serviceDate: opts.serviceDate, cutoffInMinutes: -30 });
  const fam = await seedFamily(schoolId, opts.studentNames);
  const db = adminDb();
  const checkoutId = uuidv7();
  await db.insertInto("checkouts").values({ id: checkoutId, schoolId, guardianId: fam.guardianId, serviceDayId: day.serviceDayId, status: "paid", totalCents: 900 * fam.studentIds.length }).execute();
  const orderIds: string[] = [];
  for (const studentId of fam.studentIds) {
    const orderId = uuidv7();
    await db.insertInto("orders").values({ id: orderId, schoolId, checkoutId, studentId, serviceDate: opts.serviceDate, status: "confirmed" }).execute();
    await db.insertInto("orderItems").values({ id: uuidv7(), schoolId, orderId, menuItemId: day.items[0]!.id, qty: 1, unitPriceCents: 900 }).execute();
    orderIds.push(orderId);
  }
  return { serviceDayId: day.serviceDayId, orderIds };
}
```

O teste fecha o dia pelo serviço real (`closeServiceDay(schoolId, date, { log, reconcile: false })`) quando precisa do romaneio congelado; o helper só prepara pedidos confirmados com o corte já passado.

- [ ] **Step 2: Testes (falham)**

`apps/api/src/modules/kds/sync.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { adminDb, createSchool, kitchenCookie, seedClosedDayWithOrders, seedTenant } from "../../../test/helpers";
import { buildApp } from "../../app";
import { SESSION_COOKIE } from "../../platform/session";
import { closeServiceDay } from "../serviceDays/service";

const log = { warn: () => undefined, info: () => undefined, error: () => undefined } as never;
const ev = (orderId: string, type: "delivered" | "undelivered", at: string, eventId = uuidv7()) => ({ eventId, orderId, type, occurredAt: at });

async function closedDay(schoolId: string, date: string, names = ["Léo", "Bia"]) {
  const seeded = await seedClosedDayWithOrders(schoolId, { serviceDate: date, studentNames: names });
  await closeServiceDay(schoolId, date, { log, reconcile: false });
  return seeded;
}

describe("kds manifest", () => {
  it("serves a preview while open and the frozen manifest after close", async () => {
    const schoolId = await createSchool();
    await seedTenant(schoolId);
    const { cookies } = await kitchenCookie(schoolId);
    const seeded = await seedClosedDayWithOrders(schoolId, { serviceDate: "2031-11-03", studentNames: ["Léo"] });
    const app = buildApp();
    const preview = await app.inject({ method: "GET", url: "/api/kds/v1/manifest/2031-11-03", cookies });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ serviceDate: "2031-11-03", status: "open", manifestVersion: null });
    expect(preview.json().content.by_class[0].orders[0].order_id).toBe(seeded.orderIds[0]);
    await closeServiceDay(schoolId, "2031-11-03", { log, reconcile: false });
    const closed = await app.inject({ method: "GET", url: "/api/kds/v1/manifest/2031-11-03", cookies });
    expect(closed.json()).toMatchObject({ status: "closed", manifestVersion: 1 });
    expect(closed.cookies.find((c) => c.name === SESSION_COOKIE)?.maxAge).toBe(30 * 24 * 60 * 60);
  });

  it("answers 404 for a day without service", async () => {
    const schoolId = await createSchool();
    await seedTenant(schoolId);
    const { cookies } = await kitchenCookie(schoolId);
    const res = await buildApp().inject({ method: "GET", url: "/api/kds/v1/manifest/2031-11-04", cookies });
    expect(res.statusCode).toBe(404);
  });
});

describe("kds events", () => {
  it("accepts a batch once, repeats are no-ops, and the latest event wins", async () => {
    const schoolId = await createSchool();
    await seedTenant(schoolId);
    const { cookies, deviceId } = await kitchenCookie(schoolId);
    const { orderIds } = await closedDay(schoolId, "2031-11-05");
    const [a, b] = orderIds as [string, string];
    const batch = [
      ev(a, "delivered", "2031-11-05T10:00:00Z"),
      ev(b, "delivered", "2031-11-05T10:00:01Z"),
      ev(b, "undelivered", "2031-11-05T10:00:05Z"),
    ];
    const app = buildApp();
    const first = await app.inject({ method: "POST", url: "/api/kds/v1/events", cookies, payload: { events: batch } });
    expect(first.statusCode).toBe(200);
    expect(first.json().accepted.sort()).toEqual(batch.map((e) => e.eventId).sort());
    expect(first.json().rejected).toEqual([]);
    const repeat = await app.inject({ method: "POST", url: "/api/kds/v1/events", cookies, payload: { events: batch } });
    expect(repeat.json().accepted.sort()).toEqual(batch.map((e) => e.eventId).sort());
    const stored = await adminDb().selectFrom("deliveryEvents").select(["eventId", "deviceId"]).where("orderId", "in", [a, b]).execute();
    expect(stored).toHaveLength(3);
    expect(new Set(stored.map((s) => s.deviceId))).toEqual(new Set([deviceId]));
    const orders = await adminDb().selectFrom("orders").select(["id", "status"]).where("id", "in", [a, b]).execute();
    expect(Object.fromEntries(orders.map((o) => [o.id, o.status]))).toEqual({ [a]: "delivered", [b]: "confirmed" });
  });

  it("resolves an occurred_at tie by the greater event_id, and an older event does not override", async () => {
    const schoolId = await createSchool();
    await seedTenant(schoolId);
    const { cookies } = await kitchenCookie(schoolId);
    const { orderIds } = await closedDay(schoolId, "2031-11-06", ["Léo"]);
    const order = orderIds[0]!;
    const at = "2031-11-06T10:00:00Z";
    const low = "00000000-0000-7000-8000-000000000001";
    const high = "ffffffff-ffff-7fff-bfff-ffffffffffff";
    const app = buildApp();
    await app.inject({ method: "POST", url: "/api/kds/v1/events", cookies, payload: { events: [ev(order, "delivered", at, high)] } });
    await app.inject({ method: "POST", url: "/api/kds/v1/events", cookies, payload: { events: [ev(order, "undelivered", at, low)] } });
    await app.inject({ method: "POST", url: "/api/kds/v1/events", cookies, payload: { events: [ev(order, "undelivered", "2031-11-06T09:00:00Z")] } });
    const row = await adminDb().selectFrom("orders").select("status").where("id", "=", order).executeTakeFirstOrThrow();
    expect(row.status).toBe("delivered");
  });

  it("rejects events for an open day, for an unknown order and for an order of another school", async () => {
    const schoolId = await createSchool();
    const other = await createSchool();
    await seedTenant(schoolId);
    const seedOther = await seedTenant(other);
    const { cookies } = await kitchenCookie(schoolId);
    const open = await seedClosedDayWithOrders(schoolId, { serviceDate: "2031-11-07", studentNames: ["Léo"] });
    const batch = [
      ev(open.orderIds[0]!, "delivered", "2031-11-07T10:00:00Z"),
      ev(uuidv7(), "delivered", "2031-11-07T10:00:00Z"),
      ev(seedOther.orderId, "delivered", "2031-11-07T10:00:00Z"),
    ];
    const res = await buildApp().inject({ method: "POST", url: "/api/kds/v1/events", cookies, payload: { events: batch } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accepted: [], rejected: batch.map((e) => e.eventId) });
    const count = await adminDb().selectFrom("deliveryEvents").select("eventId").where("eventId", "in", batch.map((e) => e.eventId)).execute();
    expect(count).toHaveLength(0);
  });

  it("serves changes from other tablets since a cursor", async () => {
    const schoolId = await createSchool();
    await seedTenant(schoolId);
    const t1 = await kitchenCookie(schoolId);
    const t2 = await kitchenCookie(schoolId);
    const { orderIds } = await closedDay(schoolId, "2031-11-10");
    const app = buildApp();
    const e1 = ev(orderIds[0]!, "delivered", "2031-11-10T10:00:00Z");
    await app.inject({ method: "POST", url: "/api/kds/v1/events", cookies: t1.cookies, payload: { events: [e1] } });
    const all = await app.inject({ method: "GET", url: "/api/kds/v1/changes?date=2031-11-10", cookies: t2.cookies });
    expect(all.statusCode).toBe(200);
    expect(all.json().events).toEqual([{ ...e1, occurredAt: new Date(e1.occurredAt).toISOString(), deviceId: t1.deviceId }]);
    const cursor = all.json().cursor as string;
    expect(cursor).toBeTruthy();
    const e2 = ev(orderIds[1]!, "delivered", "2031-11-10T10:01:00Z");
    await app.inject({ method: "POST", url: "/api/kds/v1/events", cookies: t1.cookies, payload: { events: [e2] } });
    const since = await app.inject({ method: "GET", url: `/api/kds/v1/changes?date=2031-11-10&since=${encodeURIComponent(cursor)}`, cookies: t2.cookies });
    const ids = since.json().events.map((e: { eventId: string }) => e.eventId);
    expect(ids).toContain(e2.eventId);
    // A janela de 1 min pode repetir e1; o cliente deduplica por event_id.
    expect(ids.every((id: string) => id === e1.eventId || id === e2.eventId)).toBe(true);
  });

  it("does not show events of another school", async () => {
    const a = await createSchool();
    const b = await createSchool();
    await seedTenant(a);
    await seedTenant(b);
    const ka = await kitchenCookie(a);
    const kb = await kitchenCookie(b);
    const { orderIds } = await closedDay(a, "2031-11-11", ["Léo"]);
    const app = buildApp();
    await app.inject({ method: "POST", url: "/api/kds/v1/events", cookies: ka.cookies, payload: { events: [ev(orderIds[0]!, "delivered", "2031-11-11T10:00:00Z")] } });
    const res = await app.inject({ method: "GET", url: "/api/kds/v1/changes?date=2031-11-11", cookies: kb.cookies });
    expect(res.json().events).toEqual([]);
  });
});
```

Run → FAIL.

- [ ] **Step 3: Prévia/romaneio**

`serviceDays/service.ts`:

```ts
/** KDS: romaneio congelado ou, com o dia aberto, a prévia dos pedidos já confirmados. */
export async function kdsManifest(schoolId: string, serviceDate: string): Promise<KdsManifestResponse> {
  return withTenant(schoolId, async (trx) => {
    const day = await catalog.lockServiceDayByDate(trx, serviceDate, "share");
    if (!day) throw new DomainError("not_found");
    if (day.status === "closed") {
      const manifest = await repo.readManifest(trx, day.id);
      return { serviceDate, status: "closed", manifestVersion: manifest.version, content: JSON.parse(manifest.content) as ManifestContent };
    }
    const content = buildManifest(await repo.manifestLines(trx, day.id), await orders.countLateCredited(trx, day.id));
    return { serviceDate, status: "open", manifestVersion: null, content };
  });
}
```

- [ ] **Step 4: Eventos e mudanças**

`kds/repo.ts` (acrescente):

```ts
/** Pedidos do lote que aceitam entrega: existem, dia fechado, estado confirmado ou entregue. Trava os dias antes (FOR SHARE). */
export async function deliverableOrders(trx: Trx, orderIds: string[]): Promise<Set<string>> {
  if (orderIds.length === 0) return new Set();
  await sql`
    SELECT d.id FROM service_days d
    WHERE d.id IN (SELECT c.service_day_id FROM orders o JOIN checkouts c ON c.id = o.checkout_id WHERE o.id = ANY(${orderIds}::uuid[]))
    ORDER BY d.id FOR SHARE`.execute(trx);
  const { rows } = await sql<{ id: string }>`
    SELECT o.id FROM orders o
    JOIN checkouts c ON c.id = o.checkout_id
    JOIN service_days d ON d.id = c.service_day_id
    WHERE o.id = ANY(${orderIds}::uuid[]) AND d.status = 'closed' AND o.status IN ('confirmed', 'delivered')
    ORDER BY o.id FOR UPDATE OF o`.execute(trx);
  return new Set(rows.map((r) => r.id));
}

export async function insertEvents(
  trx: Trx,
  schoolId: string,
  deviceId: string,
  events: { eventId: string; orderId: string; type: string; occurredAt: string }[],
): Promise<void> {
  if (events.length === 0) return;
  await trx
    .insertInto("deliveryEvents")
    .values(events.map((e) => ({ eventId: e.eventId, schoolId, orderId: e.orderId, deviceId, type: e.type, occurredAt: new Date(e.occurredAt) })))
    .onConflict((oc) => oc.column("eventId").doNothing())
    .execute();
}

/** event_ids do lote que existem nesta escola (inseridos agora ou antes). */
export async function existingEventIds(trx: Trx, eventIds: string[]): Promise<Set<string>> {
  if (eventIds.length === 0) return new Set();
  const rows = await trx.selectFrom("deliveryEvents").select("eventId").where("eventId", "in", eventIds).execute();
  return new Set(rows.map((r) => r.eventId));
}

/** Aplica o evento vencedor (maior occurred_at, empate pelo maior event_id) a cada pedido. */
export async function applyLatestState(trx: Trx, orderIds: string[]): Promise<void> {
  if (orderIds.length === 0) return;
  await sql`
    WITH latest AS (
      SELECT DISTINCT ON (order_id) order_id, type
      FROM delivery_events
      WHERE order_id = ANY(${orderIds}::uuid[])
      ORDER BY order_id, occurred_at DESC, event_id::text DESC
    )
    UPDATE orders o SET status = CASE WHEN l.type = 'delivered' THEN 'delivered' ELSE 'confirmed' END
    FROM latest l
    WHERE o.id = l.order_id
      AND ((l.type = 'delivered' AND o.status = 'confirmed') OR (l.type = 'undelivered' AND o.status = 'delivered'))`.execute(trx);
}

export async function changesSince(trx: Trx, serviceDate: string, since: string | null) {
  const { rows } = await sql<{ eventId: string; orderId: string; type: "delivered" | "undelivered"; occurredAt: Date; deviceId: string; receivedAt: string }>`
    SELECT e.event_id, e.order_id, e.type, e.occurred_at, e.device_id, e.received_at::text AS received_at
    FROM delivery_events e JOIN orders o ON o.id = e.order_id
    WHERE o.service_date = ${serviceDate}::date
      AND (${since}::timestamptz IS NULL OR e.received_at > ${since}::timestamptz - interval '1 minute')
    ORDER BY e.received_at, e.event_id
    LIMIT 1000`.execute(trx);
  return rows;
}
```

O `ORDER BY … event_id::text DESC` deixa explícita a comparação de texto, igual à do cliente.

`kds/service.ts` (acrescente):

```ts
export async function recordEvents(schoolId: string, deviceId: string, body: KdsEventsRequest): Promise<KdsEventsResponse> {
  return withTenant(schoolId, async (trx) => {
    const orderIds = [...new Set(body.events.map((e) => e.orderId))];
    const deliverable = await repo.deliverableOrders(trx, orderIds);
    const ok = body.events.filter((e) => deliverable.has(e.orderId));
    await repo.insertEvents(trx, schoolId, deviceId, ok);
    const present = await repo.existingEventIds(trx, ok.map((e) => e.eventId));
    await repo.applyLatestState(trx, [...new Set(ok.map((e) => e.orderId))]);
    return {
      accepted: body.events.filter((e) => present.has(e.eventId)).map((e) => e.eventId),
      rejected: body.events.filter((e) => !present.has(e.eventId)).map((e) => e.eventId),
    };
  });
}

export async function changes(schoolId: string, serviceDate: string, since: string | null): Promise<KdsChangesResponse> {
  const rows = await withTenant(schoolId, (trx) => repo.changesSince(trx, serviceDate, since));
  return {
    events: rows.map((r) => ({ eventId: r.eventId, orderId: r.orderId, type: r.type, occurredAt: r.occurredAt.toISOString(), deviceId: r.deviceId })),
    cursor: rows.length > 0 ? rows[rows.length - 1]!.receivedAt : since,
  };
}
```

Um evento de pedido entregável cujo `event_id` já exista em **outra** escola (colisão de UUID) não aparece em `present` e sai como `rejected` — comportamento aceito.

`kds/routes.ts` (acrescente):

```ts
const DateParams = z.object({ date: IsoDate });
const ChangesQuery = z.object({ date: IsoDate, since: z.string().min(1).max(64).optional() });

  app.get("/api/kds/v1/manifest/:date", { config: { auth: KITCHEN } }, async (req, reply) => {
    const s = req.session!;
    const res = await serviceDays.kdsManifest(s.schoolId, DateParams.parse(req.params).date);
    await renewKitchen(reply, s.schoolId, s.sub);
    return res;
  });

  app.post("/api/kds/v1/events", { config: { auth: KITCHEN } }, async (req, reply) => {
    const s = req.session!;
    const res = await service.recordEvents(s.schoolId, s.sub, KdsEventsRequest.parse(req.body));
    await renewKitchen(reply, s.schoolId, s.sub);
    return res;
  });

  app.get("/api/kds/v1/changes", { config: { auth: KITCHEN } }, async (req, reply) => {
    const s = req.session!;
    const q = ChangesQuery.parse(req.query);
    const res = await service.changes(s.schoolId, q.date, q.since ?? null);
    await renewKitchen(reply, s.schoolId, s.sub);
    return res;
  });
```

Se `since` não for um `timestamptz` válido o Postgres lança erro de cast: valide no zod com `.refine((v) => !Number.isNaN(Date.parse(v)))` para responder 400.

`POST /api/kds/v1/events` é naturalmente idempotente por `event_id` (CLAUDE.md regra 11, exceção) — não usa `Idempotency-Key`.

- [ ] **Step 5: Spec**

Spec 7.3, item 4: troque a frase do `POST` por "`POST /api/kds/v1/events` com até 100 eventos; o servidor insere com `ON CONFLICT (event_id) DO NOTHING` e devolve `accepted` (gravados agora ou antes) e `rejected` (pedido inexistente, dia ainda aberto ou pedido sem entrega); o cliente remove os dois. Entrega só é aceita depois do fechamento." e o `GET` por "`GET /api/kds/v1/changes?date=<data>&since=<cursor>` traz eventos de outros tablets; o cursor é o `received_at` do último evento e o servidor repete o último minuto (o cliente deduplica por `event_id`).". Na seção 10, a linha do KDS ganha `POST /api/admin/v1/kds/pairing-codes` (admin) implícito em `/api/admin/v1/**` — sem mudança; acrescente ao item 6 de 7.3: "(token `kitchen` vencido há até 90 dias)". Na seção 14, retire "índice único próprio para códigos de pareamento da cozinha (F4)".

- [ ] **Step 6: Rodar e commitar**

Run: `pnpm --filter @app-lanche/api exec vitest run src/modules/kds && pnpm test:api && pnpm typecheck && pnpm lint` → PASS.

```bash
git add apps/api docs/superpowers/specs/2026-11-16-app-lanche-design.md
git commit -m "feat(api): serve the KDS manifest, accept delivery events and stream changes"
```

---

### Task 4: Armazenamento local e sincronização do KDS (web)

**Files:**
- Modify: `apps/web/package.json` (`dexie`)
- Create: `apps/web/src/areas/kds/state.ts`, `apps/web/src/areas/kds/state.test.ts`
- Create: `apps/web/src/areas/kds/badge.ts`, `apps/web/src/areas/kds/badge.test.ts`
- Create: `apps/web/src/areas/kds/db.ts`, `apps/web/src/areas/kds/sync.ts`, `apps/web/src/areas/kds/useLive.ts`

**Interfaces:**
- Consumes: contratos `KdsManifestResponse`, `KdsEventsResponse`, `KdsChangesResponse`, `KdsPairResponse`; `apiFetch`, `ApiError` (`app/api.ts`).
- Produces: `type OrderState = { orderId: string; serviceDate: string; state: "pending" | "delivered"; occurredAt: string; eventId: string }`; `isNewer(a: { occurredAt: string; eventId: string }, b): boolean`; `mergeEvent(current: OrderState | undefined, ev): OrderState | undefined` (devolve o novo estado ou `undefined` se o atual vence); `chunk<T>(items: T[], size: number): T[][]`; `badgeText(pending: number, lastSyncAt: string | null, now: Date): { text: string; stale: boolean }`; Dexie `kdsDb` com stores `manifest`, `orderState`, `outbox`, `meta`; `markOrder(orderId, serviceDate, delivered: boolean): Promise<void>`; `sync.pair(code)`, `sync.syncNow(serviceDate)`, `sync.start(serviceDate): () => void`, `sync.unpair(): Promise<boolean>`; `useLive<T>(query: () => Promise<T>, deps: unknown[]): T | undefined`.

- [ ] **Step 1: Lógica pura (testes falham)**

`state.ts`:

```ts
export type DeliveryState = "pending" | "delivered";
export type OrderState = { orderId: string; serviceDate: string; state: DeliveryState; occurredAt: string; eventId: string };
export type DeliveryEvent = { eventId: string; orderId: string; type: "delivered" | "undelivered"; occurredAt: string };

/** Spec 7.3 (5): vence o maior occurred_at; empate pelo maior event_id (texto). Igual ao servidor. */
export function isNewer(a: { occurredAt: string; eventId: string }, b: { occurredAt: string; eventId: string }): boolean {
  const ta = Date.parse(a.occurredAt);
  const tb = Date.parse(b.occurredAt);
  if (ta !== tb) return ta > tb;
  return a.eventId > b.eventId;
}

/** Novo estado do pedido após o evento, ou undefined se o estado atual já é mais recente. */
export function mergeEvent(current: OrderState | undefined, ev: DeliveryEvent, serviceDate: string): OrderState | undefined {
  if (current && !isNewer(ev, current)) return undefined;
  return {
    orderId: ev.orderId,
    serviceDate,
    state: ev.type === "delivered" ? "delivered" : "pending",
    occurredAt: ev.occurredAt,
    eventId: ev.eventId,
  };
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
```

`state.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { chunk, isNewer, mergeEvent } from "./state";

const at = (s: string) => `2031-11-05T10:00:${s}.000Z`;

describe("kds state", () => {
  it("prefers the later occurredAt", () => {
    expect(isNewer({ occurredAt: at("05"), eventId: "a" }, { occurredAt: at("04"), eventId: "z" })).toBe(true);
    expect(isNewer({ occurredAt: at("04"), eventId: "z" }, { occurredAt: at("05"), eventId: "a" })).toBe(false);
  });

  it("breaks a tie by the greater eventId", () => {
    expect(isNewer({ occurredAt: at("05"), eventId: "b" }, { occurredAt: at("05"), eventId: "a" })).toBe(true);
    expect(isNewer({ occurredAt: at("05"), eventId: "a" }, { occurredAt: at("05"), eventId: "a" })).toBe(false);
  });

  it("compares instants, not strings with different offsets", () => {
    expect(isNewer({ occurredAt: "2031-11-05T07:00:06-03:00", eventId: "a" }, { occurredAt: at("05"), eventId: "z" })).toBe(true);
  });

  it("merges only newer events", () => {
    const cur = mergeEvent(undefined, { eventId: "b", orderId: "o", type: "delivered", occurredAt: at("05") }, "2031-11-05")!;
    expect(cur.state).toBe("delivered");
    expect(mergeEvent(cur, { eventId: "a", orderId: "o", type: "undelivered", occurredAt: at("05") }, "2031-11-05")).toBeUndefined();
    expect(mergeEvent(cur, { eventId: "c", orderId: "o", type: "undelivered", occurredAt: at("05") }, "2031-11-05")?.state).toBe("pending");
  });

  it("chunks batches of 100", () => {
    expect(chunk(Array.from({ length: 250 }, (_, i) => i), 100).map((c) => c.length)).toEqual([100, 100, 50]);
    expect(chunk([], 100)).toEqual([]);
  });
});
```

`badge.ts`:

```ts
const STALE_MS = 2 * 60 * 1000;

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Spec 7.4: "N pendentes · última sincronização HH:MM"; vermelho após 2 min sem sincronizar. */
export function badgeText(pending: number, lastSyncAt: string | null, now: Date): { text: string; stale: boolean } {
  const count = pending === 1 ? "1 pendente" : `${pending} pendentes`;
  if (!lastSyncAt) return { text: `${count} · nunca sincronizado`, stale: true };
  return {
    text: `${count} · última sincronização ${hhmm(lastSyncAt)}`,
    stale: now.getTime() - Date.parse(lastSyncAt) > STALE_MS,
  };
}
```

`badge.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { badgeText } from "./badge";

describe("sync badge", () => {
  const last = new Date(2031, 10, 5, 10, 7).toISOString();
  it("shows pending count and last sync time", () => {
    expect(badgeText(3, last, new Date(2031, 10, 5, 10, 8))).toEqual({ text: "3 pendentes · última sincronização 10:07", stale: false });
    expect(badgeText(1, last, new Date(2031, 10, 5, 10, 8)).text).toBe("1 pendente · última sincronização 10:07");
  });
  it("turns stale after 2 minutes without sync", () => {
    expect(badgeText(0, last, new Date(2031, 10, 5, 10, 9, 1)).stale).toBe(true);
  });
  it("is stale when never synced", () => {
    expect(badgeText(0, null, new Date())).toEqual({ text: "0 pendentes · nunca sincronizado", stale: true });
  });
});
```

Run: `pnpm --filter @app-lanche/web exec vitest run src/areas/kds` → FAIL; implemente; PASS.

- [ ] **Step 2: Dexie**

`pnpm --filter @app-lanche/web add dexie@^4.4.7`.

`db.ts`:

```ts
import Dexie, { type EntityTable } from "dexie";
import type { KdsManifestResponse } from "@app-lanche/contracts";
import { mergeEvent, type DeliveryEvent, type OrderState } from "./state";

export type ManifestRow = KdsManifestResponse & { fetchedAt: string };
export type OutboxRow = DeliveryEvent & { serviceDate: string };
export type MetaRow = { key: string; value: string };

class KdsDb extends Dexie {
  manifest!: EntityTable<ManifestRow, "serviceDate">;
  orderState!: EntityTable<OrderState, "orderId">;
  outbox!: EntityTable<OutboxRow, "eventId">;
  meta!: EntityTable<MetaRow, "key">;

  constructor() {
    super("app-lanche-kds");
    this.version(1).stores({
      manifest: "serviceDate",
      orderState: "orderId, serviceDate",
      outbox: "eventId, occurredAt, serviceDate",
      meta: "key",
    });
  }
}

export const kdsDb = new KdsDb();

export async function getMeta(key: string): Promise<string | null> {
  return (await kdsDb.meta.get(key))?.value ?? null;
}

export async function setMeta(key: string, value: string): Promise<void> {
  await kdsDb.meta.put({ key, value });
}

/** CLAUDE.md 33: uma transação atualiza orderState e insere na outbox. */
export async function markOrder(orderId: string, serviceDate: string, delivered: boolean): Promise<void> {
  const ev: DeliveryEvent = {
    eventId: crypto.randomUUID(),
    orderId,
    type: delivered ? "delivered" : "undelivered",
    occurredAt: new Date().toISOString(),
  };
  await kdsDb.transaction("rw", kdsDb.orderState, kdsDb.outbox, async () => {
    const next = mergeEvent(await kdsDb.orderState.get(orderId), ev, serviceDate);
    if (next) await kdsDb.orderState.put(next);
    await kdsDb.outbox.add({ ...ev, serviceDate });
  });
}

/** Eventos vindos do servidor (outros tablets): só alteram o estado se forem mais recentes. */
export async function applyRemoteEvents(serviceDate: string, events: DeliveryEvent[]): Promise<void> {
  await kdsDb.transaction("rw", kdsDb.orderState, async () => {
    for (const ev of events) {
      const next = mergeEvent(await kdsDb.orderState.get(ev.orderId), ev, serviceDate);
      if (next) await kdsDb.orderState.put(next);
    }
  });
}
```

`crypto.randomUUID()` gera UUID v4; a regra "UUID v7 gerado na aplicação" vale para ids do servidor — o `event_id` do cliente é aleatório (spec 7.3). Registre isso no relatório se o revisor perguntar.

- [ ] **Step 3: Sincronização**

`sync.ts` — único módulo do KDS que chama a API (CLAUDE.md 32):

```ts
import { KdsChangesResponse, KdsEventsResponse, KdsManifestResponse, KdsPairResponse } from "@app-lanche/contracts";
import { ApiError, apiFetch } from "../../app/api";
import { applyRemoteEvents, getMeta, kdsDb, setMeta } from "./db";
import { chunk } from "./state";

const INTERVAL_MS = 15_000;

export async function pair(code: string): Promise<string> {
  const res = await apiFetch("/api/kds/v1/pair", KdsPairResponse, { method: "POST", body: { code } });
  await setMeta("deviceId", res.deviceId);
  await navigator.storage?.persist?.().catch(() => false);
  return res.deviceId;
}

export async function isPaired(): Promise<boolean> {
  return (await getMeta("deviceId")) !== null;
}

/** Desparear só com a outbox vazia (spec 7.4). Devolve false se recusado. */
export async function unpair(): Promise<boolean> {
  if ((await kdsDb.outbox.count()) > 0) return false;
  await kdsDb.transaction("rw", kdsDb.manifest, kdsDb.orderState, kdsDb.meta, async () => {
    await kdsDb.manifest.clear();
    await kdsDb.orderState.clear();
    await kdsDb.meta.clear();
  });
  return true;
}

async function pushOutbox(): Promise<void> {
  const pending = await kdsDb.outbox.orderBy("occurredAt").toArray();
  for (const batch of chunk(pending, 100)) {
    const res = await apiFetch("/api/kds/v1/events", KdsEventsResponse, {
      method: "POST",
      body: { events: batch.map(({ eventId, orderId, type, occurredAt }) => ({ eventId, orderId, type, occurredAt })) },
    });
    // CLAUDE.md 34: só sai da outbox o que o servidor confirmou (aceito ou recusado em definitivo).
    await kdsDb.outbox.bulkDelete([...res.accepted, ...res.rejected]);
  }
}

async function pullManifest(serviceDate: string): Promise<void> {
  const current = await kdsDb.manifest.get(serviceDate);
  if (current?.status === "closed") return; // imutável depois de fechado
  const res = await apiFetch(`/api/kds/v1/manifest/${serviceDate}`, KdsManifestResponse);
  await kdsDb.manifest.put({ ...res, fetchedAt: new Date().toISOString() });
}

async function pullChanges(serviceDate: string): Promise<void> {
  const key = `cursor:${serviceDate}`;
  const since = await getMeta(key);
  const url = `/api/kds/v1/changes?date=${serviceDate}${since ? `&since=${encodeURIComponent(since)}` : ""}`;
  const res = await apiFetch(url, KdsChangesResponse);
  await applyRemoteEvents(serviceDate, res.events);
  if (res.cursor) await setMeta(key, res.cursor);
}

let running: Promise<void> | null = null;

/** Uma rodada: envia a outbox, atualiza o romaneio e puxa mudanças. Nunca roda duas ao mesmo tempo. */
export function syncNow(serviceDate: string): Promise<void> {
  running ??= (async () => {
    try {
      await pushOutbox();
      await pullManifest(serviceDate);
      await pullChanges(serviceDate);
      await setMeta("lastSyncAt", new Date().toISOString());
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) await setMeta("authLost", "1");
      // Sem rede ou erro do servidor: a outbox fica como está e a próxima rodada tenta de novo.
    } finally {
      running = null;
    }
  })();
  return running;
}

/** Spec 7.3 (4): evento online, a cada 15 s e no retorno de foco. Sem Background Sync API. */
export function start(serviceDate: string): () => void {
  const run = () => void syncNow(serviceDate);
  const onVisible = () => {
    if (document.visibilityState === "visible") run();
  };
  window.addEventListener("online", run);
  document.addEventListener("visibilitychange", onVisible);
  const timer = window.setInterval(run, INTERVAL_MS);
  run();
  return () => {
    window.removeEventListener("online", run);
    document.removeEventListener("visibilitychange", onVisible);
    window.clearInterval(timer);
  };
}
```

`useLive.ts`:

```ts
import { liveQuery } from "dexie";
import { useEffect, useState } from "react";

/** Assina uma consulta Dexie e re-renderiza a cada mudança (sem dexie-react-hooks). */
export function useLive<T>(query: () => Promise<T>, deps: unknown[]): T | undefined {
  const [value, setValue] = useState<T>();
  useEffect(() => {
    const sub = liveQuery(query).subscribe({ next: setValue, error: () => undefined });
    return () => sub.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return value;
}
```

(remova o comentário `eslint-disable` se a regra `react-hooks` não estiver configurada no projeto.)

- [ ] **Step 4: Rodar e commitar**

Run: `pnpm --filter @app-lanche/web exec vitest run src/areas/kds && pnpm typecheck && pnpm lint && pnpm --filter @app-lanche/web build` → PASS.

```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat(web): add the KDS local store, state merge and sync loop"
```

---

### Task 5: Telas do KDS e pareamento pela secretaria

**Files:**
- Create: `apps/web/src/areas/kds/KdsPair.tsx`, `apps/web/src/areas/kds/KdsBoard.tsx`, `apps/web/src/areas/kds/KdsApp.tsx`
- Create: `apps/web/src/areas/admin/KitchenDevicesAdmin.tsx`, `apps/web/src/areas/admin/kitchenDevices.test.tsx`
- Modify: `apps/web/src/areas/admin/AdminHome.tsx` (incluir `KitchenDevicesAdmin`), `apps/web/src/app/App.tsx` (rota `/kds`, lazy), `apps/web/src/ui/messages.ts`

**Interfaces:**
- Consumes: Task 4 (`kdsDb`, `markOrder`, `useLive`, `badgeText`, `sync.*`); contratos `PairingCodeResponse`, `KitchenDeviceListResponse`.
- Produces: rota `/kds` (lazy) e `/kds?date=YYYY-MM-DD`; textos com `data-testid` usados pelo e2e: `kds-pair-code` (input), `kds-pair-submit`, `kds-badge`, `kds-waiting` (aviso de prévia), `kds-order-<orderId>` (botão do pedido, com `aria-pressed` = entregue), `kds-unpair`.

- [ ] **Step 1: Teste da tela de pareamento da secretaria (falha)**

`kitchenDevices.test.tsx` (padrão `mockApi` de `catalogAdmin.test.tsx`):

```tsx
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KitchenDevicesAdmin } from "./KitchenDevicesAdmin";

type Reply = { status: number; body: unknown };
function mockApi(replies: Record<string, Reply>) {
  const fn = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url, init) => {
    const reply = replies[`${init?.method ?? "GET"} ${url}`];
    if (!reply) throw new Error(`unexpected request ${init?.method ?? "GET"} ${url}`);
    return new Response(reply.status === 204 ? null : JSON.stringify(reply.body), { status: reply.status });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const DEV = "0193a3b0-0000-7000-8000-0000000000d1";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("KitchenDevicesAdmin", () => {
  it("generates a pairing code and shows it with its validity", async () => {
    const fn = mockApi({
      "GET /api/admin/v1/kds/devices": { status: 200, body: { devices: [] } },
      "POST /api/admin/v1/kds/pairing-codes": { status: 200, body: { deviceId: DEV, code: "ABCD2345", expiresAt: "2031-11-05T13:10:00.000Z" } },
    });
    render(<KitchenDevicesAdmin />);
    fireEvent.click(await screen.findByRole("button", { name: "Gerar código de pareamento" }));
    expect(await screen.findByText("ABCD2345")).toBeTruthy();
    expect(screen.getByText(/Digite este código no tablet da cozinha/)).toBeTruthy();
    const post = fn.mock.calls.find((c) => c[1]?.method === "POST")!;
    expect((post[1]!.headers as Record<string, string>)["idempotency-key"]).toBeTruthy();
  });

  it("lists devices and revokes one after confirmation", async () => {
    vi.stubGlobal("confirm", () => true);
    const fn = mockApi({
      "GET /api/admin/v1/kds/devices": { status: 200, body: { devices: [{ id: DEV, createdAt: "2031-11-01T10:00:00.000Z", paired: true, revokedAt: null }] } },
      [`POST /api/admin/v1/kds/devices/${DEV}/revoke`]: { status: 204, body: null },
    });
    render(<KitchenDevicesAdmin />);
    fireEvent.click(await screen.findByRole("button", { name: "Revogar" }));
    await waitFor(() => expect(fn.mock.calls.some((c) => c[0] === `/api/admin/v1/kds/devices/${DEV}/revoke`)).toBe(true));
  });
});
```

Se `apiFetch` falhar com corpo vazio em 204, trate o 204 em `apiFetch` (`if (res.status === 204) return undefined as T`) e use um schema `z.undefined()` na chamada — registre no relatório.

- [ ] **Step 2: Componente da secretaria**

`KitchenDevicesAdmin.tsx`:

```tsx
import { KitchenDeviceListResponse, PairingCodeResponse } from "@app-lanche/contracts";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import { ApiError, apiFetch } from "../../app/api";
import { staffErrorMessage } from "../../ui/messages";

export function KitchenDevicesAdmin() {
  const [devices, setDevices] = useState<KitchenDeviceListResponse["devices"]>([]);
  const [code, setCode] = useState<PairingCodeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDevices((await apiFetch("/api/admin/v1/kds/devices", KitchenDeviceListResponse)).devices);
    } catch (err) {
      setError(staffErrorMessage(err instanceof ApiError ? err.code : "internal_error"));
    }
  }, []);

  useEffect(() => void load(), [load]);

  async function generate() {
    setError(null);
    try {
      setCode(await apiFetch("/api/admin/v1/kds/pairing-codes", PairingCodeResponse, { method: "POST", idempotencyKey: crypto.randomUUID() }));
      await load();
    } catch (err) {
      setError(staffErrorMessage(err instanceof ApiError ? err.code : "internal_error"));
    }
  }

  async function revoke(id: string) {
    if (!window.confirm("Revogar este tablet? Ele deixa de sincronizar na hora.")) return;
    try {
      await apiFetch(`/api/admin/v1/kds/devices/${id}/revoke`, z.undefined(), { method: "POST" });
      await load();
    } catch (err) {
      setError(staffErrorMessage(err instanceof ApiError ? err.code : "internal_error"));
    }
  }

  return (
    <section>
      <h2>Tablets da cozinha</h2>
      <button type="button" onClick={() => void generate()}>Gerar código de pareamento</button>
      {code && (
        <p>
          <strong>{code.code}</strong> — Digite este código no tablet da cozinha, em /kds. Vale até{" "}
          {new Date(code.expiresAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <ul>
        {devices.map((d) => (
          <li key={d.id}>
            Tablet de {new Date(d.createdAt).toLocaleDateString("pt-BR")} —{" "}
            {d.revokedAt ? "revogado" : d.paired ? "pareado" : "aguardando pareamento"}
            {!d.revokedAt && (
              <button type="button" onClick={() => void revoke(d.id)}>Revogar</button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
```

Inclua `<KitchenDevicesAdmin />` em `AdminHome` para papéis `admin` e `secretaria` (mesma condição usada para `MenuAdmin`).

- [ ] **Step 3: Telas do tablet**

`KdsPair.tsx`:

```tsx
import { useState, type FormEvent } from "react";
import { ApiError } from "../../app/api";
import * as sync from "./sync";

export function KdsPair({ onPaired }: { onPaired: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await sync.pair(code);
      onPaired();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 0
          ? "Sem conexão. O pareamento precisa de internet."
          : "Código inválido ou vencido. Peça um novo código à secretaria.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Parear tablet da cozinha</h1>
      <form onSubmit={submit}>
        <label>
          Código de pareamento
          <input data-testid="kds-pair-code" value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="characters" maxLength={8} />
        </label>
        <button data-testid="kds-pair-submit" type="submit" disabled={busy || code.trim().length !== 8}>Parear</button>
      </form>
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
```

`KdsBoard.tsx`:

```tsx
import { useEffect, useState } from "react";
import { badgeText } from "./badge";
import { kdsDb, markOrder } from "./db";
import * as sync from "./sync";
import { useLive } from "./useLive";

export function KdsBoard({ serviceDate, onUnpaired }: { serviceDate: string; onUnpaired: () => void }) {
  const manifest = useLive(() => kdsDb.manifest.get(serviceDate), [serviceDate]);
  const states = useLive(() => kdsDb.orderState.where("serviceDate").equals(serviceDate).toArray(), [serviceDate]);
  const pending = useLive(() => kdsDb.outbox.count(), []);
  const lastSyncAt = useLive(async () => (await kdsDb.meta.get("lastSyncAt"))?.value ?? null, []);
  const [now, setNow] = useState(() => new Date());
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => sync.start(serviceDate), [serviceDate]);
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 10_000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => {
    // Spec 7.4: tela acesa enquanto o KDS está aberto.
    let lock: { release: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } };
    nav.wakeLock?.request("screen").then((l) => (lock = l), () => undefined);
    return () => void lock?.release();
  }, []);

  const delivered = new Set((states ?? []).filter((s) => s.state === "delivered").map((s) => s.orderId));
  const badge = badgeText(pending ?? 0, lastSyncAt ?? null, now);
  const closed = manifest?.status === "closed";

  async function unpair() {
    if (!(await sync.unpair())) {
      setMessage("Há entregas ainda não sincronizadas. Conecte o tablet à internet e aguarde antes de desparear.");
      return;
    }
    onUnpaired();
  }

  return (
    <main>
      <header>
        <h1>Cozinha — {serviceDate.split("-").reverse().join("/")}</h1>
        <p data-testid="kds-badge" style={{ color: badge.stale ? "#b91c1c" : undefined }}>{badge.text}</p>
      </header>
      {!manifest && <p>Carregando o romaneio… Conecte o tablet à internet na primeira vez.</p>}
      {manifest && !closed && (
        <p data-testid="kds-waiting">Prévia parcial — aguardando fechamento. As entregas podem ser marcadas depois do fechamento.</p>
      )}
      {manifest && (
        <p>
          {manifest.content.totals.orders} pedidos ·{" "}
          {manifest.content.totals.by_item.map((i) => `${i.qty}x ${i.item}`).join(" · ")}
        </p>
      )}
      {manifest?.content.by_class.map((c) => (
        <section key={c.class}>
          <h2>{c.class}</h2>
          <ul>
            {c.orders.map((o) => {
              const isDelivered = delivered.has(o.order_id);
              return (
                <li key={o.order_id}>
                  <button
                    type="button"
                    data-testid={`kds-order-${o.order_id}`}
                    aria-pressed={isDelivered}
                    disabled={!closed}
                    onClick={() => void markOrder(o.order_id, serviceDate, !isDelivered)}
                  >
                    {isDelivered ? "✓ " : ""}
                    {o.student} — {o.items.join(", ")}
                    {o.restrictions ? ` (restrição: ${o.restrictions})` : ""}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      <footer>
        <button data-testid="kds-unpair" type="button" onClick={() => void unpair()}>Desparear este tablet</button>
        {message && <p role="alert">{message}</p>}
      </footer>
    </main>
  );
}
```

`KdsApp.tsx`:

```tsx
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { KdsBoard } from "./KdsBoard";
import { KdsPair } from "./KdsPair";
import * as sync from "./sync";

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function KdsApp() {
  const [params] = useSearchParams();
  const serviceDate = /^\d{4}-\d{2}-\d{2}$/.test(params.get("date") ?? "") ? params.get("date")! : today();
  const [paired, setPaired] = useState<boolean | null>(null);
  useEffect(() => void sync.isPaired().then(setPaired), []);
  if (paired === null) return null;
  if (!paired) return <KdsPair onPaired={() => setPaired(true)} />;
  return <KdsBoard serviceDate={serviceDate} onUnpaired={() => setPaired(false)} />;
}
```

`App.tsx`: `const KdsApp = lazy(() => import("../areas/kds/KdsApp"));` e `<Route path="/kds" element={<Suspense fallback={null}><KdsApp /></Suspense>} />`. O chunk lazy entra no precache do service worker (o vite-plugin-pwa inclui todos os assets gerados por padrão — confira `dist/sw.js` depois do build).

- [ ] **Step 4: Rodar e commitar**

Run: `pnpm --filter @app-lanche/web test && pnpm typecheck && pnpm lint && pnpm --filter @app-lanche/web build` → PASS; confira que `dist/sw.js` lista o chunk do `KdsApp`.

```bash
git add apps/web
git commit -m "feat(web): add the kitchen tablet screens and pairing in the admin area"
```

---

### Task 6: E2E offline com Playwright, CI e documentação

**Files:**
- Modify: `package.json` (raiz: `@playwright/test`, script `test:e2e`)
- Create: `e2e/playwright.config.ts`, `e2e/global-setup.ts`, `e2e/kds.spec.ts`, `e2e/tsconfig.json`
- Modify: `.github/workflows/ci.yml`, `eslint.config.js` (se preciso), `docs/deploy.md`, spec 13

**Interfaces:**
- Consumes: tudo das Tasks 1–5; `migrate` de `db/migrate.ts`.
- Produces: `pnpm test:e2e`.

- [ ] **Step 1: Instalar e configurar**

`pnpm add -Dw @playwright/test@^1.65.1`; `pnpm exec playwright install chromium` (se o navegador da versão instalada já estiver em `~/.cache/ms-playwright`, nada é baixado). Script na raiz: `"test:e2e": "playwright test -c e2e/playwright.config.ts"`.

`e2e/playwright.config.ts`:

```ts
import { defineConfig, devices } from "@playwright/test";

const DB = "postgres://app_user:app_user@localhost:5432/app_lanche_e2e";

export default defineConfig({
  testDir: ".",
  timeout: 60_000,
  workers: 1,
  globalSetup: "./global-setup.ts",
  use: { baseURL: "http://localhost:4173", timezoneId: "America/Sao_Paulo", ...devices["Desktop Chrome"] },
  webServer: [
    {
      command: "pnpm --filter @app-lanche/api exec tsx src/server.ts",
      url: "http://localhost:8080/healthz",
      reuseExistingServer: false,
      env: {
        DATABASE_URL: DB,
        INTERNAL_SERVICE_TOKEN: "e2e-service-token-with-at-least-32-chars",
        INTERNAL_HMAC_SECRET: "e2e-hmac-secret-with-at-least-32-chars!!",
        SESSION_SECRET: "e2e-session-secret-with-at-least-32-chars",
        JOBS_TOKEN: "e2e-jobs-token-with-at-least-32-chars!!!",
        APP_BASE_URL: "http://localhost:4173",
        PAYMENT_PROVIDER: "fake",
        ENABLE_FAKE_PAYMENTS: "true",
        PORT: "8080",
      },
    },
    {
      command: "pnpm --filter @app-lanche/web build && pnpm --filter @app-lanche/web exec vite preview --port 4173 --strictPort",
      url: "http://localhost:4173",
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
```

`e2e/global-setup.ts` (o Postgres do compose precisa estar no ar: `pnpm db:up`):

```ts
import { createHash } from "node:crypto";
import pg from "pg";
import { migrate } from "../db/migrate";

const ADMIN = "postgres://postgres:postgres@localhost:5432";
export const PAIRING_CODE = "KDSE2E23";
export const SCHOOL_ID = "0193a3b0-0000-7000-8000-00000000e2e1";

export default async function globalSetup(): Promise<void> {
  const root = new pg.Client({ connectionString: `${ADMIN}/postgres` });
  await root.connect();
  await root.query("DROP DATABASE IF EXISTS app_lanche_e2e WITH (FORCE)");
  await root.query("CREATE DATABASE app_lanche_e2e");
  await root.end();
  await migrate({ adminUrl: `${ADMIN}/app_lanche_e2e`, appPassword: "app_user" });

  const db = new pg.Client({ connectionString: `${ADMIN}/app_lanche_e2e` });
  await db.connect();
  try {
    await db.query(`INSERT INTO schools (id, name) VALUES ($1, 'Escola E2E')`, [SCHOOL_ID]);
    // Dia de hoje (fuso da escola), já depois do corte e ainda aberto, com 3 pedidos confirmados: o KDS mostra a prévia;
    // o teste fecha o dia pela rota interna (como o n8n), e o romaneio é gravado pelo serviço real.
    const { rows: [day] } = await db.query<{ id: string; date: string }>(`
      INSERT INTO service_days (id, school_id, service_date, cutoff_at, freeze_at)
      VALUES (gen_random_uuid(), $1, (now() AT TIME ZONE 'America/Sao_Paulo')::date, now() - interval '30 minutes', now() - interval '25 minutes')
      RETURNING id, service_date::text AS date`, [SCHOOL_ID]);
    const { rows: [cls] } = await db.query<{ id: string }>(`INSERT INTO classes (id, school_id, name) VALUES (gen_random_uuid(), $1, 'Infantil 3A') RETURNING id`, [SCHOOL_ID]);
    const { rows: [guardian] } = await db.query<{ id: string }>(`INSERT INTO guardians (id, school_id, phone_e164, first_name) VALUES (gen_random_uuid(), $1, '+5511999990099', 'Ana') RETURNING id`, [SCHOOL_ID]);
    const { rows: [item] } = await db.query<{ id: string }>(`INSERT INTO menu_items (id, school_id, name, price_cents) VALUES (gen_random_uuid(), $1, 'Misto quente', 900) RETURNING id`, [SCHOOL_ID]);
    await db.query(`INSERT INTO service_day_items (school_id, service_day_id, menu_item_id, price_cents) VALUES ($1, $2, $3, 900)`, [SCHOOL_ID, day!.id, item!.id]);
    const { rows: [checkout] } = await db.query<{ id: string }>(
      `INSERT INTO checkouts (id, school_id, guardian_id, service_day_id, status, total_cents) VALUES (gen_random_uuid(), $1, $2, $3, 'paid', 2700) RETURNING id`,
      [SCHOOL_ID, guardian!.id, day!.id],
    );
    for (const [i, name] of ["Léo", "Bia", "Caio"].entries()) {
      const { rows: [student] } = await db.query<{ id: string }>(
        `INSERT INTO students (id, school_id, class_id, external_code, first_name) VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING id`,
        [SCHOOL_ID, cls!.id, `E2E-${i}`, name],
      );
      await db.query(`INSERT INTO guardian_students (school_id, guardian_id, student_id) VALUES ($1, $2, $3)`, [SCHOOL_ID, guardian!.id, student!.id]);
      const { rows: [order] } = await db.query<{ id: string }>(
        `INSERT INTO orders (id, school_id, checkout_id, student_id, service_date, status) VALUES (gen_random_uuid(), $1, $2, $3, $4::date, 'confirmed') RETURNING id`,
        [SCHOOL_ID, checkout!.id, student!.id, day!.date],
      );
      await db.query(`INSERT INTO order_items (id, school_id, order_id, menu_item_id, qty, unit_price_cents) VALUES (gen_random_uuid(), $1, $2, $3, 1, 900)`, [SCHOOL_ID, order!.id, item!.id]);
    }
    await db.query(
      `INSERT INTO devices (id, school_id, kind, pairing_code_hash, pairing_expires_at) VALUES (gen_random_uuid(), $1, 'kitchen', $2, now() + interval '30 minutes')`,
      [SCHOOL_ID, createHash("sha256").update(PAIRING_CODE).digest("hex")],
    );
  } finally {
    await db.end();
  }
}
```

O teste fecha o dia pela rota interna `POST /internal/v1/service-days/:school/:date/close`, assinada com os segredos do `webServer` (fórmula da spec 6.1, função local no spec).

`e2e/tsconfig.json`
- Modify: `.github/workflows/ci.yml`, `eslint.config.js` (se preciso), `docs/deploy.md`, spec 13

**Interfaces:**
- Consumes: tudo das Tasks 1–5; `migrate` de `db/migrate.ts`.
- Produces: `pnpm test:e2e`.

- [ ] **Step 1: Instalar e configurar**

`pnpm add -Dw @playwright/test@^1.65.1`; `pnpm exec playwright install chromium` (se o navegador da versão instalada já estiver em `~/.cache/ms-playwright`, nada é baixado). Script na raiz: `"test:e2e": "playwright test -c e2e/playwright.config.ts"`.

`e2e/playwright.config.ts`:

```ts
import { defineConfig, devices } from "@playwright/test";

const DB = "postgres://app_user:app_user@localhost:5432/app_lanche_e2e";

export default defineConfig({
  testDir: ".",
  timeout: 60_000,
  workers: 1,
  globalSetup: "./global-setup.ts",
  use: { baseURL: "http://localhost:4173", timezoneId: "America/Sao_Paulo", ...devices["Desktop Chrome"] },
  webServer: [
    {
      command: "pnpm --filter @app-lanche/api exec tsx src/server.ts",
      url: "http://localhost:8080/healthz",
      reuseExistingServer: false,
      env: {
        DATABASE_URL: DB,
        INTERNAL_SERVICE_TOKEN: "e2e-service-token-with-at-least-32-chars",
        INTERNAL_HMAC_SECRET: "e2e-hmac-secret-with-at-least-32-chars!!",
        SESSION_SECRET: "e2e-session-secret-with-at-least-32-chars",
        JOBS_TOKEN: "e2e-jobs-token-with-at-least-32-chars!!!",
        APP_BASE_URL: "http://localhost:4173",
        PAYMENT_PROVIDER: "fake",
        ENABLE_FAKE_PAYMENTS: "true",
        PORT: "8080",
      },
    },
    {
      command: "pnpm --filter @app-lanche/web build && pnpm --filter @app-lanche/web exec vite preview --port 4173 --strictPort",
      url: "http://localhost:4173",
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
```

`e2e/global-setup.ts` (o Postgres do compose precisa estar no ar: `pnpm db:up`):

```ts
import { createHash } from "node:crypto";
import pg from "pg";
import { migrate } from "../db/migrate";

const ADMIN = "postgres://postgres:postgres@localhost:5432";
export const PAIRING_CODE = "KDSE2E23";
export const SCHOOL_ID = "0193a3b0-0000-7000-8000-00000000e2e1";

export default async function globalSetup(): Promise<void> {
  const root = new pg.Client({ connectionString: `${ADMIN}/postgres` });
  await root.connect();
  await root.query("DROP DATABASE IF EXISTS app_lanche_e2e WITH (FORCE)");
  await root.query("CREATE DATABASE app_lanche_e2e");
  await root.end();
  await migrate({ adminUrl: `${ADMIN}/app_lanche_e2e`, appPassword: "app_user" });

  const db = new pg.Client({ connectionString: `${ADMIN}/app_lanche_e2e` });
  await db.connect();
  try {
    await db.query(`INSERT INTO schools (id, name) VALUES ($1, 'Escola E2E')`, [SCHOOL_ID]);
    // Dia de hoje (fuso da escola), já depois do corte e ainda aberto, com 3 pedidos confirmados: o KDS mostra a prévia;
    // o teste fecha o dia pela rota interna (como o n8n), e o romaneio é gravado pelo serviço real.
    const { rows: [day] } = await db.query<{ id: string; date: string }>(`
      INSERT INTO service_days (id, school_id, service_date, cutoff_at, freeze_at)
      VALUES (gen_random_uuid(), $1, (now() AT TIME ZONE 'America/Sao_Paulo')::date, now() - interval '30 minutes', now() - interval '25 minutes')
      RETURNING id, service_date::text AS date`, [SCHOOL_ID]);
    const { rows: [cls] } = await db.query<{ id: string }>(`INSERT INTO classes (id, school_id, name) VALUES (gen_random_uuid(), $1, 'Infantil 3A') RETURNING id`, [SCHOOL_ID]);
    const { rows: [guardian] } = await db.query<{ id: string }>(`INSERT INTO guardians (id, school_id, phone_e164, first_name) VALUES (gen_random_uuid(), $1, '+5511999990099', 'Ana') RETURNING id`, [SCHOOL_ID]);
    const { rows: [item] } = await db.query<{ id: string }>(`INSERT INTO menu_items (id, school_id, name, price_cents) VALUES (gen_random_uuid(), $1, 'Misto quente', 900) RETURNING id`, [SCHOOL_ID]);
    await db.query(`INSERT INTO service_day_items (school_id, service_day_id, menu_item_id, price_cents) VALUES ($1, $2, $3, 900)`, [SCHOOL_ID, day!.id, item!.id]);
    const { rows: [checkout] } = await db.query<{ id: string }>(
      `INSERT INTO checkouts (id, school_id, guardian_id, service_day_id, status, total_cents) VALUES (gen_random_uuid(), $1, $2, $3, 'paid', 2700) RETURNING id`,
      [SCHOOL_ID, guardian!.id, day!.id],
    );
    for (const [i, name] of ["Léo", "Bia", "Caio"].entries()) {
      const { rows: [student] } = await db.query<{ id: string }>(
        `INSERT INTO students (id, school_id, class_id, external_code, first_name) VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING id`,
        [SCHOOL_ID, cls!.id, `E2E-${i}`, name],
      );
      await db.query(`INSERT INTO guardian_students (school_id, guardian_id, student_id) VALUES ($1, $2, $3)`, [SCHOOL_ID, guardian!.id, student!.id]);
      const { rows: [order] } = await db.query<{ id: string }>(
        `INSERT INTO orders (id, school_id, checkout_id, student_id, service_date, status) VALUES (gen_random_uuid(), $1, $2, $3, $4::date, 'confirmed') RETURNING id`,
        [SCHOOL_ID, checkout!.id, student!.id, day!.date],
      );
      await db.query(`INSERT INTO order_items (id, school_id, order_id, menu_item_id, qty, unit_price_cents) VALUES (gen_random_uuid(), $1, $2, $3, 1, 900)`, [SCHOOL_ID, order!.id, item!.id]);
    }
    await db.query(
      `INSERT INTO devices (id, school_id, kind, pairing_code_hash, pairing_expires_at) VALUES (gen_random_uuid(), $1, 'kitchen', $2, now() + interval '30 minutes')`,
      [SCHOOL_ID, createHash("sha256").update(PAIRING_CODE).digest("hex")],
    );
  } finally {
    await db.end();
  }
}
```

O fechamento do dia é feito no teste pela rota de equipe? Não há sessão de equipe no e2e; em vez disso o teste chama a API de fechamento como o n8n faria — simplifique: o `global-setup` deixa o dia **aberto** (para o teste ver a prévia) e o teste fecha o dia por SQL equivalente? Não: o romaneio precisa ser gravado pelo serviço real. Use a rota interna `POST /internal/v1/service-days/:school/:date/close` assinada com `INTERNAL_SERVICE_TOKEN`/`INTERNAL_HMAC_SECRET` do `webServer` (helper `signInternal` copiado como função local no spec, mesma fórmula da spec 6.1). Remova o comentário provisório do `global-setup` acima ao implementar.

`e2e/tsconfig.json`: `{ "extends": "../tsconfig.base.json", "compilerOptions": { "noEmit": true, "types": ["node"] }, "include": ["./**/*.ts", "../db/migrate.ts"] }` e inclua `e2e` no `pnpm typecheck` (script `"typecheck": "pnpm -r typecheck && tsc -p e2e/tsconfig.json"` na raiz).

- [ ] **Step 2: Cenário offline (spec 13)**

`e2e/kds.spec.ts`:

```ts
import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { PAIRING_CODE, SCHOOL_ID } from "./global-setup";

const DB = "postgres://postgres:postgres@localhost:5432/app_lanche_e2e";

async function query<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: DB });
  await c.connect();
  try {
    return (await c.query<T>(sql, params)).rows;
  } finally {
    await c.end();
  }
}

async function closeDay(date: string): Promise<void> {
  const path = `/internal/v1/service-days/${SCHOOL_ID}/${date}/close`;
  const timestamp = new Date().toISOString();
  const signature = createHmac("sha256", "e2e-hmac-secret-with-at-least-32-chars!!").update(`POST\n${path}\n${timestamp}\n`).digest("hex");
  const res = await fetch(`http://localhost:8080${path}`, {
    method: "POST",
    headers: { authorization: "Bearer e2e-service-token-with-at-least-32-chars", "x-timestamp": timestamp, "x-signature": signature },
  });
  expect(res.status).toBe(200);
}

test("marks deliveries offline and syncs them without loss or duplicates", async ({ page, context }) => {
  const [{ date }] = await query<{ date: string }>(`SELECT service_date::text AS date FROM service_days WHERE school_id = $1`, [SCHOOL_ID]);
  const orders = await query<{ id: string }>(`SELECT id FROM orders WHERE school_id = $1 ORDER BY id`, [SCHOOL_ID]);

  // 1. Pareia online e vê a prévia com marcação desabilitada.
  await page.goto(`/kds?date=${date}`);
  await page.getByTestId("kds-pair-code").fill(PAIRING_CODE.toLowerCase());
  await page.getByTestId("kds-pair-submit").click();
  await expect(page.getByTestId("kds-waiting")).toBeVisible();
  await expect(page.getByTestId(`kds-order-${orders[0]!.id}`)).toBeDisabled();

  // 2. Fecha o dia; a próxima sincronização baixa o romaneio congelado.
  await closeDay(date!);
  await page.reload();
  await expect(page.getByTestId("kds-waiting")).toBeHidden({ timeout: 20_000 });
  await expect(page.getByTestId("kds-badge")).toContainText("0 pendentes");

  // 3. Sem rede: marca, desmarca e remarca; recarrega a página offline (service worker + IndexedDB).
  await context.setOffline(true);
  await page.getByTestId(`kds-order-${orders[0]!.id}`).click();
  await page.getByTestId(`kds-order-${orders[1]!.id}`).click();
  await page.getByTestId(`kds-order-${orders[1]!.id}`).click();
  await page.getByTestId(`kds-order-${orders[2]!.id}`).click();
  await expect(page.getByTestId("kds-badge")).toContainText("4 pendentes");
  await page.reload();
  await expect(page.getByTestId(`kds-order-${orders[0]!.id}`)).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId(`kds-order-${orders[1]!.id}`)).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("kds-badge")).toContainText("4 pendentes");

  // 4. Desparear é recusado com outbox pendente.
  await page.getByTestId("kds-unpair").click();
  await expect(page.getByRole("alert")).toContainText("não sincronizadas");

  // 5. Rede de volta: a outbox esvazia e o servidor tem exatamente os 4 eventos.
  await context.setOffline(false);
  await expect(page.getByTestId("kds-badge")).toContainText("0 pendentes", { timeout: 30_000 });
  const events = await query<{ n: string }>(`SELECT count(*) AS n FROM delivery_events WHERE school_id = $1`, [SCHOOL_ID]);
  expect(Number(events[0]!.n)).toBe(4);
  const status = await query<{ id: string; status: string }>(`SELECT id, status FROM orders WHERE school_id = $1`, [SCHOOL_ID]);
  expect(Object.fromEntries(status.map((s) => [s.id, s.status]))).toEqual({
    [orders[0]!.id]: "delivered",
    [orders[1]!.id]: "confirmed",
    [orders[2]!.id]: "delivered",
  });

  // 6. Uma segunda rodada não duplica nada.
  await page.reload();
  await expect(page.getByTestId("kds-badge")).toContainText("0 pendentes");
  const again = await query<{ n: string }>(`SELECT count(*) AS n FROM delivery_events WHERE school_id = $1`, [SCHOOL_ID]);
  expect(Number(again[0]!.n)).toBe(4);
});

test("a second tablet sees deliveries made on the first", async ({ browser }) => {
  // Pareia um segundo contexto com um novo código inserido aqui e confere aria-pressed dos pedidos já entregues.
  const second = "KDSE2E45";
  const { createHash } = await import("node:crypto");
  await query(
    `INSERT INTO devices (id, school_id, kind, pairing_code_hash, pairing_expires_at) VALUES (gen_random_uuid(), $1, 'kitchen', $2, now() + interval '30 minutes')`,
    [SCHOOL_ID, createHash("sha256").update(second).digest("hex")],
  );
  const [{ date }] = await query<{ date: string }>(`SELECT service_date::text AS date FROM service_days WHERE school_id = $1`, [SCHOOL_ID]);
  const delivered = await query<{ id: string }>(`SELECT id FROM orders WHERE school_id = $1 AND status = 'delivered' ORDER BY id`, [SCHOOL_ID]);
  const context = await browser.newContext({ timezoneId: "America/Sao_Paulo" });
  const page = await context.newPage();
  await page.goto(`/kds?date=${date}`);
  await page.getByTestId("kds-pair-code").fill(second);
  await page.getByTestId("kds-pair-submit").click();
  for (const o of delivered) {
    await expect(page.getByTestId(`kds-order-${o.id}`)).toHaveAttribute("aria-pressed", "true", { timeout: 20_000 });
  }
  await context.close();
});
```

O segundo teste depende do primeiro (mesmo banco, `workers: 1`, ordem do arquivo): marque o arquivo com `test.describe.configure({ mode: "serial" })` no topo.

O `page.reload()` offline só funciona se o service worker já controla a página: depois do primeiro `goto`, espere `await page.evaluate(() => navigator.serviceWorker.ready)` antes de desligar a rede.

Run: `pnpm db:up && pnpm test:e2e` → PASS (2 testes).

- [ ] **Step 3: CI e documentação**

`.github/workflows/ci.yml`: novo job `e2e` (depois de `check`): checkout, pnpm, node 22, `pnpm install --frozen-lockfile`, `docker compose up -d db`, espera o Postgres (`until docker compose exec -T db pg_isready -U postgres; do sleep 1; done`), `pnpm exec playwright install --with-deps chromium`, `pnpm test:e2e`, e em falha `actions/upload-artifact@v4` com `playwright-report`/`test-results`.

`docs/deploy.md`, seção "KDS (cozinha)": pareamento pela área admin ("Tablets da cozinha" → "Gerar código de pareamento" → abrir `/kds` no tablet e digitar o código em até 10 min); o tablet deve ser dedicado (o cookie `__session` é compartilhado: não usar o mesmo navegador para login de equipe); instalar como PWA; manter a página aberta (Wake Lock); revogar pela mesma tela em caso de perda.

Spec 13: "KDS: Playwright com rede desligada (`pnpm test:e2e`, Postgres do compose, PWA de produção com service worker) — marcar entregas offline, recarregar offline, religar, verificar sincronização sem perda nem duplicata e a visão de um segundo tablet."

- [ ] **Step 4: Rodar tudo e commitar**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:e2e` → PASS.

```bash
git add package.json pnpm-lock.yaml e2e .github/workflows/ci.yml docs/deploy.md docs/superpowers/specs/2026-11-16-app-lanche-design.md eslint.config.js
git commit -m "test(e2e): cover offline delivery marking and sync on the KDS with Playwright"
```

---

## Verificação final da fase

- `pnpm typecheck && pnpm lint && pnpm test && pnpm test:e2e` passando; builds da API e da web passando.
- `grep -rn "apiFetch\|fetch(" apps/web/src/areas/kds` só encontra `sync.ts`.
- Spec 7.3, 13 e 14 atualizadas; `docs/deploy.md` com a seção do KDS.
