# F1 — Cadastros e Autenticação — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Responsável entra pelo magic link (com OTP em aparelho novo) e vê seus filhos; equipe entra por e-mail + OTP e importa alunos e responsáveis por CSV.

**Architecture:** Token opaco de 256 bits no fragmento da URL, guardado só como SHA-256. O tenant é descoberto por funções `SECURITY DEFINER` (`resolve_magic_link`, `resolve_staff_email`) e, a partir daí, tudo roda em `withTenant`. A sessão é um JWT HS256 no cookie `__session`. O OTP é entregue por evento na outbox.

**Tech Stack:** O de F0, mais `jose` (JWT), `csv-parse` (CSV) e `@testing-library/react`.

**Spec:** `docs/superpowers/specs/2026-11-16-app-lanche-design.md` (seções 4, 9, 10, 12, 13). Pré-requisito: plano `2026-11-16-f0-fundacao.md` concluído.

## Global Constraints

- Todas as restrições globais de F0 continuam valendo.
- Cookie de sessão: nome `__session`, `HttpOnly; Secure; SameSite=Lax; Path=/`.
- Sessão do responsável: 2 h. Sessão da equipe: 8 h. Token de OTP: 10 min.
- OTP: 6 dígitos, validade de 5 min, 5 tentativas, guardado como hash.
- Token do magic link: 32 bytes aleatórios em base64url; no banco só o SHA-256 em hex; na URL só no fragmento (`<APP_BASE_URL>/l#<token>`).
- Nenhuma rota `GET` consome token ou altera estado.
- `school_id` nunca vem do corpo, da query string ou de header do navegador.
- A única fonte de tempo para validade de link e OTP é o banco (`now()`).
- Consultas sem tenant: só `resolve_magic_link` e `resolve_staff_email`, chamadas em `modules/auth/repo.ts`.
- Toda tabela nova entra em `TENANT_TABLES` (`apps/api/src/db/rls.test.ts`) e em `seedTenant` (`apps/api/test/helpers.ts`).
- Após criar migração: rodar `pnpm db:migrate` e `pnpm db:types` (comandos completos em F0, Task 3, Step 2) e commitar `apps/api/src/db/types.ts`.
- Papéis da equipe: `admin`, `secretaria`, `cozinha`.
- Respostas e mensagens nunca revelam se um e-mail ou telefone existe.

## File Structure

```
db/migrations/0004_auth.sql                     devices, magic_links, otp_challenges, resolve_*
packages/contracts/src/auth.ts                  contratos de autenticação (responsável e equipe)
packages/contracts/src/registry.ts              contratos de cadastros e importação
apps/api/src/platform/session.ts                JWT, cookie, authenticate
apps/api/src/platform/audit.ts                  audit()
apps/api/src/modules/auth/tokens.ts             geração e hash de token e OTP
apps/api/src/modules/auth/repo.ts               SQL de autenticação
apps/api/src/modules/auth/magicLink.ts          createMagicLink
apps/api/src/modules/auth/otp.ts                desafio, verificação, token de OTP
apps/api/src/modules/auth/service.ts            exchange, verifyGuardianOtp, getMe, staff login
apps/api/src/modules/auth/routes.ts             rotas /api/v1/auth, /api/v1/me, /api/admin/v1/auth, /api/admin/v1/me
apps/api/src/modules/registry/csv.ts            parse do CSV e normalização de telefone
apps/api/src/modules/registry/repo.ts           SQL de cadastros
apps/api/src/modules/registry/service.ts        importStudents, listagens
apps/api/src/modules/registry/routes.ts         rotas /api/admin/v1/{import,classes,students}
apps/api/src/cli/createSchool.ts                cria escola e primeiro admin
apps/web/src/ui/messages.ts                     código de erro → texto
apps/web/src/areas/guardian/device.ts           device_secret em localStorage
apps/web/src/areas/guardian/LinkLanding.tsx     /l: troca do token e OTP
apps/web/src/areas/guardian/OrderHome.tsx       /pedido: lista os filhos
apps/web/src/areas/admin/AdminLogin.tsx         /admin/login
apps/web/src/areas/admin/AdminHome.tsx          /admin: importação CSV
```

---

### Task 1: Tabelas de autenticação e resolução de tenant

**Files:**
- Create: `db/migrations/0004_auth.sql`
- Create: `apps/api/src/modules/auth/repo.ts`
- Modify: `apps/api/src/db/types.ts` (regenerado), `apps/api/test/helpers.ts`, `apps/api/src/db/rls.test.ts`
- Test: `apps/api/src/modules/auth/resolve.test.ts`

**Interfaces:**
- Consumes: `getDb`, `adminDb`, `createSchool`, `seedTenant`.
- Produces: `resolveMagicLink(tokenHash: string): Promise<{ schoolId: string; magicLinkId: string } | undefined>`.
- Produces: `resolveStaffEmail(email: string): Promise<{ schoolId: string; staffUserId: string } | undefined>` (só equipe ativa; e-mail comparado em minúsculas).

- [ ] **Step 1: Migração**

`db/migrations/0004_auth.sql`:
```sql
CREATE TABLE devices (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  kind text NOT NULL CHECK (kind IN ('guardian', 'kitchen')),
  guardian_id uuid,
  secret_hash text,
  pairing_code_hash text,
  pairing_expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  FOREIGN KEY (school_id, guardian_id) REFERENCES guardians (school_id, id),
  CHECK ((kind = 'guardian') = (guardian_id IS NOT NULL))
);

CREATE UNIQUE INDEX devices_guardian_secret
  ON devices (school_id, guardian_id, secret_hash) WHERE kind = 'guardian';

CREATE TABLE magic_links (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  guardian_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  scope text NOT NULL CHECK (scope IN ('order', 'documents')),
  service_date date,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  FOREIGN KEY (school_id, guardian_id) REFERENCES guardians (school_id, id)
);

CREATE TABLE otp_challenges (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL REFERENCES schools (id),
  subject_kind text NOT NULL CHECK (subject_kind IN ('guardian', 'staff')),
  subject_id uuid NOT NULL,
  code_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['devices', 'magic_links', 'otp_challenges']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (school_id = app_school_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_user', t);
  END LOOP;
END $$;

-- Únicas consultas sem tenant desta fase (spec 4.4). Devolvem o mínimo para abrir o withTenant.
CREATE FUNCTION resolve_magic_link(p_token_hash text)
RETURNS TABLE (school_id uuid, magic_link_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT m.school_id, m.id FROM magic_links m WHERE m.token_hash = p_token_hash $$;

CREATE FUNCTION resolve_staff_email(p_email text)
RETURNS TABLE (school_id uuid, staff_user_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT s.school_id, s.id FROM staff_users s WHERE s.email = lower(p_email) AND s.active $$;

REVOKE ALL ON FUNCTION resolve_magic_link(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_staff_email(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_magic_link(text) TO app_user;
GRANT EXECUTE ON FUNCTION resolve_staff_email(text) TO app_user;
```

Rode `pnpm db:migrate` e `pnpm db:types`. Expected: `applied: 0004_auth.sql`; `types.ts` ganha `devices`, `magicLinks`, `otpChallenges`.

- [ ] **Step 2: Estender RLS e seed**

Em `apps/api/src/db/rls.test.ts`, `TENANT_TABLES` passa a ser:
```ts
const TENANT_TABLES = [
  "audit_log",
  "classes",
  "devices",
  "guardian_students",
  "guardians",
  "magic_links",
  "otp_challenges",
  "outbox_events",
  "staff_users",
  "students",
];
```

Em `apps/api/test/helpers.ts`, ao final de `seedTenant` (antes do `return`):
```ts
  await db
    .insertInto("devices")
    .values({ id: uuidv7(), schoolId, kind: "kitchen" })
    .execute();
  await db
    .insertInto("magicLinks")
    .values({
      id: uuidv7(),
      schoolId,
      guardianId: ids.guardianId,
      tokenHash: `seed-${uuidv7()}`,
      scope: "order",
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    .execute();
  await db
    .insertInto("otpChallenges")
    .values({
      id: uuidv7(),
      schoolId,
      subjectKind: "guardian",
      subjectId: ids.guardianId,
      codeHash: "seed",
      expiresAt: new Date(Date.now() + 300_000),
    })
    .execute();
```

- [ ] **Step 3: Escrever o teste que falha**

`apps/api/src/modules/auth/resolve.test.ts`:
```ts
import { uuidv7 } from "uuidv7";
import { describe, expect, it } from "vitest";
import { adminDb, createSchool, seedTenant } from "../../../test/helpers";
import { resolveMagicLink, resolveStaffEmail } from "./repo";

describe("tenant resolution", () => {
  it("resolves a magic link hash to its school", async () => {
    const schoolId = await createSchool();
    const seed = await seedTenant(schoolId);
    const id = uuidv7();
    const tokenHash = `hash-${id}`;
    await adminDb()
      .insertInto("magicLinks")
      .values({
        id,
        schoolId,
        guardianId: seed.guardianId,
        tokenHash,
        scope: "order",
        expiresAt: new Date(Date.now() + 60_000),
      })
      .execute();
    expect(await resolveMagicLink(tokenHash)).toEqual({ schoolId, magicLinkId: id });
  });

  it("returns undefined for an unknown hash", async () => {
    expect(await resolveMagicLink("nope")).toBeUndefined();
  });

  it("resolves an active staff e-mail case-insensitively", async () => {
    const schoolId = await createSchool();
    const seed = await seedTenant(schoolId);
    expect(await resolveStaffEmail(seed.email.toUpperCase())).toEqual({
      schoolId,
      staffUserId: seed.staffUserId,
    });
  });

  it("does not resolve inactive staff", async () => {
    const schoolId = await createSchool();
    const seed = await seedTenant(schoolId);
    await adminDb().updateTable("staffUsers").set({ active: false }).where("id", "=", seed.staffUserId).execute();
    expect(await resolveStaffEmail(seed.email)).toBeUndefined();
  });
});
```

- [ ] **Step 4: Rodar e ver falhar**

Run: `pnpm test:api -- resolve.test`
Expected: FAIL — `./repo` não existe.

- [ ] **Step 5: Implementar**

`apps/api/src/modules/auth/repo.ts`:
```ts
import { sql } from "kysely";
import { getDb } from "../../db/index";

export async function resolveMagicLink(
  tokenHash: string,
): Promise<{ schoolId: string; magicLinkId: string } | undefined> {
  const { rows } = await sql<{ schoolId: string; magicLinkId: string }>`
    SELECT school_id, magic_link_id FROM resolve_magic_link(${tokenHash})`.execute(getDb());
  return rows[0];
}

export async function resolveStaffEmail(
  email: string,
): Promise<{ schoolId: string; staffUserId: string } | undefined> {
  const { rows } = await sql<{ schoolId: string; staffUserId: string }>`
    SELECT school_id, staff_user_id FROM resolve_staff_email(${email})`.execute(getDb());
  return rows[0];
}
```

- [ ] **Step 6: Rodar e ver passar**

Run: `pnpm test:api && pnpm typecheck`
Expected: todos PASS, incluindo os três casos novos do teste de RLS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(auth): add auth tables and tenant resolution functions"
```

---

### Task 2: Sessão e guarda de autenticação

**Files:**
- Create: `apps/api/src/platform/session.ts`
- Modify: `apps/api/src/app.ts` (hook `preHandler`)
- Test: `apps/api/src/platform/session.test.ts`

**Interfaces:**
- Consumes: `config().sessionSecret`, `DomainError`, `RouteAuth`.
- Produces:
  - `SESSION_COOKIE = "__session"`, `GUARDIAN_SESSION_TTL = 7200`, `STAFF_SESSION_TTL = 28800`.
  - `type GuardianScope = "order" | "documents"`, `type StaffRole = "admin" | "secretaria" | "cozinha"`.
  - `type SessionClaims = { kind: "guardian"; sub: string; schoolId: string; scope: GuardianScope; otpAt?: number } | { kind: "staff"; sub: string; schoolId: string; role: StaffRole }`.
  - `signToken(purpose: "session" | "otp", payload: Record<string, unknown>, ttlSeconds: number): Promise<string>`.
  - `verifyToken(purpose: "session" | "otp", token: string): Promise<Record<string, unknown>>` — lança `DomainError("unauthenticated")`.
  - `issueSession(reply: FastifyReply, claims: SessionClaims, ttlSeconds: number): Promise<void>`.
  - `request.session?: SessionClaims`, preenchido pelo `preHandler` em rotas com `config.auth` objeto.
- Regras do guarda: sem cookie ou token inválido → 401 `unauthenticated`; `kind` diferente, `scope` diferente ou papel fora de `roles` → 403 `insufficient_scope`.

- [ ] **Step 1: Instalar**

Run: `pnpm --filter @app-lanche/api add jose`

- [ ] **Step 2: Escrever o teste que falha**

`apps/api/src/platform/session.test.ts`:
```ts
import { uuidv7 } from "uuidv7";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app";
import { SESSION_COOKIE, issueSession, signToken, type SessionClaims } from "./session";

const guardian: SessionClaims = { kind: "guardian", sub: uuidv7(), schoolId: uuidv7(), scope: "order" };
const staff: SessionClaims = { kind: "staff", sub: uuidv7(), schoolId: uuidv7(), role: "secretaria" };

function app() {
  const a = buildApp();
  a.get("/api/v1/g", { config: { auth: { kind: "guardian", scope: "order" } } }, async (req) => req.session);
  a.get("/api/admin/v1/s", { config: { auth: { kind: "staff", roles: ["admin"] } } }, async (req) => req.session);
  a.post("/api/v1/login", { config: { auth: "public" } }, async (_req, reply) => {
    await issueSession(reply, guardian, 7200);
    return { ok: true };
  });
  return a;
}

async function cookieFor(claims: SessionClaims, purpose: "session" | "otp" = "session", ttl = 60) {
  return { [SESSION_COOKIE]: await signToken(purpose, claims, ttl) };
}

describe("session guard", () => {
  it("rejects a request without cookie", async () => {
    const res = await app().inject({ method: "GET", url: "/api/v1/g" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthenticated");
  });

  it("exposes the claims to the handler", async () => {
    const res = await app().inject({ method: "GET", url: "/api/v1/g", cookies: await cookieFor(guardian) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject(guardian);
  });

  it("rejects an expired token", async () => {
    const res = await app().inject({
      method: "GET",
      url: "/api/v1/g",
      cookies: await cookieFor(guardian, "session", -10),
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a token issued for another purpose", async () => {
    const res = await app().inject({
      method: "GET",
      url: "/api/v1/g",
      cookies: await cookieFor(guardian, "otp"),
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects the wrong kind", async () => {
    const res = await app().inject({ method: "GET", url: "/api/v1/g", cookies: await cookieFor(staff) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("insufficient_scope");
  });

  it("rejects the wrong guardian scope", async () => {
    const res = await app().inject({
      method: "GET",
      url: "/api/v1/g",
      cookies: await cookieFor({ ...guardian, scope: "documents" }),
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects a staff role outside the allowed list", async () => {
    const res = await app().inject({ method: "GET", url: "/api/admin/v1/s", cookies: await cookieFor(staff) });
    expect(res.statusCode).toBe(403);
  });

  it("sets the cookie with the required attributes", async () => {
    const res = await app().inject({ method: "POST", url: "/api/v1/login" });
    const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE)!;
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: 7200 });
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `pnpm test:api -- session.test`
Expected: FAIL — `./session` não existe.

- [ ] **Step 4: Implementar**

`apps/api/src/platform/session.ts`:
```ts
import type { FastifyReply, FastifyRequest } from "fastify";
import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";
import type { RouteAuth } from "../app";
import { config } from "./config";
import { DomainError } from "./errors";

export const SESSION_COOKIE = "__session";
export const GUARDIAN_SESSION_TTL = 2 * 60 * 60;
export const STAFF_SESSION_TTL = 8 * 60 * 60;

const GuardianScope = z.enum(["order", "documents"]);
const StaffRole = z.enum(["admin", "secretaria", "cozinha"]);
export type GuardianScope = z.infer<typeof GuardianScope>;
export type StaffRole = z.infer<typeof StaffRole>;

const SessionClaims = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("guardian"),
    sub: z.string().uuid(),
    schoolId: z.string().uuid(),
    scope: GuardianScope,
    otpAt: z.number().optional(),
  }),
  z.object({
    kind: z.literal("staff"),
    sub: z.string().uuid(),
    schoolId: z.string().uuid(),
    role: StaffRole,
  }),
]);
export type SessionClaims = z.infer<typeof SessionClaims>;

declare module "fastify" {
  interface FastifyRequest {
    session?: SessionClaims;
  }
}

function key(): Uint8Array {
  return new TextEncoder().encode(config().sessionSecret);
}

export async function signToken(
  purpose: "session" | "otp",
  payload: Record<string, unknown>,
  ttlSeconds: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ ...payload, purpose })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(key());
}

export async function verifyToken(
  purpose: "session" | "otp",
  token: string,
): Promise<Record<string, unknown>> {
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ["HS256"] });
    if (payload.purpose !== purpose) throw new Error("wrong purpose");
    return payload;
  } catch {
    throw new DomainError("unauthenticated");
  }
}

export async function issueSession(
  reply: FastifyReply,
  claims: SessionClaims,
  ttlSeconds: number,
): Promise<void> {
  const token = await signToken("session", claims, ttlSeconds);
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: ttlSeconds,
  });
}

export async function authenticate(
  req: FastifyRequest,
  auth: Exclude<RouteAuth, string>,
): Promise<SessionClaims> {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) throw new DomainError("unauthenticated");
  const parsed = SessionClaims.safeParse(await verifyToken("session", token));
  if (!parsed.success) throw new DomainError("unauthenticated");
  const claims = parsed.data;
  if (claims.kind !== auth.kind) throw new DomainError("insufficient_scope");
  if (claims.kind === "guardian" && auth.scope && claims.scope !== auth.scope) {
    throw new DomainError("insufficient_scope");
  }
  if (claims.kind === "staff" && auth.roles && !auth.roles.includes(claims.role)) {
    throw new DomainError("insufficient_scope");
  }
  return claims;
}
```

Em `apps/api/src/app.ts`, importe `authenticate` e substitua o hook `preHandler` por:
```ts
import { authenticate } from "./platform/session";
```
```ts
  app.addHook("preHandler", async (req) => {
    const auth = req.routeOptions.config.auth;
    if (auth === "internal") verifyInternalRequest(req);
    else if (typeof auth === "object") req.session = await authenticate(req, auth);
  });
```

- [ ] **Step 5: Rodar e ver passar**

Run: `pnpm test:api && pnpm typecheck`
Expected: todos PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(auth): add session tokens and route guard"
```

---

### Task 3: Magic link e desafio OTP (serviços)

**Files:**
- Create: `apps/api/src/modules/auth/tokens.ts`, `apps/api/src/modules/auth/magicLink.ts`, `apps/api/src/modules/auth/otp.ts`
- Modify: `apps/api/src/modules/auth/repo.ts`
- Test: `apps/api/src/modules/auth/magicLink.test.ts`, `apps/api/src/modules/auth/otp.test.ts`

**Interfaces:**
- Consumes: `Trx`, `withTenant`, `enqueueEvent`, `signToken`, `verifyToken`, `config().appBaseUrl`.
- Produces (`tokens.ts`): `generateToken(): string`, `hashToken(token: string): string`, `generateOtpCode(): string`, `hashOtp(challengeId: string, code: string): string`.
- Produces (`magicLink.ts`): `createMagicLink(trx: Trx, input: { schoolId: string; guardianId: string; scope: GuardianScope; serviceDate?: string; expiresAt: Date }): Promise<{ url: string; expiresAt: Date }>`.
- Produces (`otp.ts`):
  - `createChallenge(trx: Trx, input: { schoolId: string; subjectKind: "guardian" | "staff"; subjectId: string; channel: "whatsapp" | "email"; to: string; firstName: string | null }): Promise<string>` (id do desafio; enfileira `auth.otp_requested`).
  - `type OtpResult = "ok" | "invalid" | "expired" | "too_many_attempts"`.
  - `checkCode(trx: Trx, challengeId: string, code: string): Promise<OtpResult>` — nunca lança por código errado, para que o incremento de tentativas seja commitado.
  - `assertOtpOk(result: OtpResult): void` — lança `otp_invalid`, `otp_expired` ou `otp_too_many_attempts`. Chamar **fora** da transação.
  - `type OtpTokenPayload` (união por `subjectKind`: `"guardian"` com `schoolId, challengeId, subjectId, deviceHash, scope`; `"staff"` com `schoolId, challengeId, subjectId`; `"none"` sem campos).
  - `signOtpToken(payload: OtpTokenPayload): Promise<string>`, `readOtpToken(token: string): Promise<OtpTokenPayload>` (inválido → `DomainError("otp_expired")`).
- Produces (`repo.ts`): `insertMagicLink`, `insertChallenge`, `lockChallenge`, `incrementAttempts`, `consumeChallenge` (assinaturas no Step 5).

- [ ] **Step 1: Escrever os testes que falham**

`apps/api/src/modules/auth/magicLink.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { adminDb, createSchool, seedTenant } from "../../../test/helpers";
import { withTenant } from "../../db/index";
import { createMagicLink } from "./magicLink";
import { hashToken } from "./tokens";

describe("createMagicLink", () => {
  it("returns a URL with the token in the fragment and stores only its hash", async () => {
    const schoolId = await createSchool();
    const seed = await seedTenant(schoolId);
    const expiresAt = new Date(Date.now() + 3_600_000);
    const link = await withTenant(schoolId, (trx) =>
      createMagicLink(trx, { schoolId, guardianId: seed.guardianId, scope: "order", serviceDate: "2026-11-17", expiresAt }),
    );
    expect(link.url.startsWith("https://app.test/l#")).toBe(true);
    const token = link.url.split("#")[1]!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = await adminDb()
      .selectFrom("magicLinks")
      .selectAll()
      .where("tokenHash", "=", hashToken(token))
      .executeTakeFirstOrThrow();
    expect(row.guardianId).toBe(seed.guardianId);
    expect(row.scope).toBe("order");
    const all = await adminDb().selectFrom("magicLinks").select("tokenHash").where("schoolId", "=", schoolId).execute();
    expect(all.some((r) => r.tokenHash === token)).toBe(false);
  });

  it("generates a different token each time", async () => {
    const schoolId = await createSchool();
    const seed = await seedTenant(schoolId);
    const input = { schoolId, guardianId: seed.guardianId, scope: "documents" as const, expiresAt: new Date(Date.now() + 1000) };
    const [a, b] = await withTenant(schoolId, async (trx) => [
      await createMagicLink(trx, input),
      await createMagicLink(trx, input),
    ]);
    expect(a!.url).not.toBe(b!.url);
  });
});
```

`apps/api/src/modules/auth/otp.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { adminDb, createSchool, seedTenant } from "../../../test/helpers";
import { withTenant } from "../../db/index";
import { assertOtpOk, checkCode, createChallenge, readOtpToken, signOtpToken } from "./otp";

async function setup() {
  const schoolId = await createSchool();
  const seed = await seedTenant(schoolId);
  const challengeId = await withTenant(schoolId, (trx) =>
    createChallenge(trx, {
      schoolId,
      subjectKind: "guardian",
      subjectId: seed.guardianId,
      channel: "whatsapp",
      to: seed.phone,
      firstName: "Ana",
    }),
  );
  const event = await adminDb()
    .selectFrom("outboxEvents")
    .select("data")
    .where("schoolId", "=", schoolId)
    .where("type", "=", "auth.otp_requested")
    .executeTakeFirstOrThrow();
  const code = (event.data as { code: string }).code;
  return { schoolId, challengeId, code };
}

const wrong = (code: string) => (code === "000000" ? "000001" : "000000");

describe("otp", () => {
  it("enqueues the code and stores only its hash", async () => {
    const { schoolId, challengeId, code } = await setup();
    expect(code).toMatch(/^\d{6}$/);
    const row = await adminDb()
      .selectFrom("otpChallenges")
      .selectAll()
      .where("id", "=", challengeId)
      .executeTakeFirstOrThrow();
    expect(row.schoolId).toBe(schoolId);
    expect(row.codeHash).not.toContain(code);
  });

  it("accepts the right code once", async () => {
    const { schoolId, challengeId, code } = await setup();
    expect(await withTenant(schoolId, (trx) => checkCode(trx, challengeId, code))).toBe("ok");
    expect(await withTenant(schoolId, (trx) => checkCode(trx, challengeId, code))).toBe("expired");
  });

  it("counts wrong attempts and locks after five", async () => {
    const { schoolId, challengeId, code } = await setup();
    for (let i = 0; i < 5; i++) {
      expect(await withTenant(schoolId, (trx) => checkCode(trx, challengeId, wrong(code)))).toBe("invalid");
    }
    expect(await withTenant(schoolId, (trx) => checkCode(trx, challengeId, code))).toBe("too_many_attempts");
  });

  it("rejects an expired challenge", async () => {
    const { schoolId, challengeId, code } = await setup();
    await adminDb()
      .updateTable("otpChallenges")
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where("id", "=", challengeId)
      .execute();
    expect(await withTenant(schoolId, (trx) => checkCode(trx, challengeId, code))).toBe("expired");
  });

  it("maps results to domain errors", () => {
    expect(() => assertOtpOk("ok")).not.toThrow();
    expect(() => assertOtpOk("invalid")).toThrow("otp_invalid");
    expect(() => assertOtpOk("expired")).toThrow("otp_expired");
    expect(() => assertOtpOk("too_many_attempts")).toThrow("otp_too_many_attempts");
  });

  it("round-trips the otp token and rejects garbage", async () => {
    const token = await signOtpToken({ subjectKind: "none" });
    expect(await readOtpToken(token)).toEqual({ subjectKind: "none" });
    await expect(readOtpToken("garbage")).rejects.toThrow("otp_expired");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm test:api -- magicLink.test otp.test`
Expected: FAIL — módulos não existem.

- [ ] **Step 3: Implementar `tokens.ts`**

`apps/api/src/modules/auth/tokens.ts`:
```ts
import { createHash, randomBytes, randomInt } from "node:crypto";

export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateOtpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function hashOtp(challengeId: string, code: string): string {
  return createHash("sha256").update(`${challengeId}:${code}`).digest("hex");
}
```

- [ ] **Step 4: Implementar `magicLink.ts` e `otp.ts`**

`apps/api/src/modules/auth/magicLink.ts`:
```ts
import { uuidv7 } from "uuidv7";
import type { Trx } from "../../db/index";
import { config } from "../../platform/config";
import type { GuardianScope } from "../../platform/session";
import * as repo from "./repo";
import { generateToken, hashToken } from "./tokens";

export async function createMagicLink(
  trx: Trx,
  input: { schoolId: string; guardianId: string; scope: GuardianScope; serviceDate?: string; expiresAt: Date },
): Promise<{ url: string; expiresAt: Date }> {
  const token = generateToken();
  await repo.insertMagicLink(trx, {
    id: uuidv7(),
    schoolId: input.schoolId,
    guardianId: input.guardianId,
    tokenHash: hashToken(token),
    scope: input.scope,
    serviceDate: input.serviceDate ?? null,
    expiresAt: input.expiresAt,
  });
  return { url: `${config().appBaseUrl}/l#${token}`, expiresAt: input.expiresAt };
}
```

`apps/api/src/modules/auth/otp.ts`:
```ts
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import type { Trx } from "../../db/index";
import { DomainError } from "../../platform/errors";
import { enqueueEvent } from "../../platform/outbox";
import { signToken, verifyToken } from "../../platform/session";
import * as repo from "./repo";
import { generateOtpCode, hashOtp } from "./tokens";

const MAX_ATTEMPTS = 5;
const OTP_TOKEN_TTL = 10 * 60;

export type OtpResult = "ok" | "invalid" | "expired" | "too_many_attempts";

export async function createChallenge(
  trx: Trx,
  input: {
    schoolId: string;
    subjectKind: "guardian" | "staff";
    subjectId: string;
    channel: "whatsapp" | "email";
    to: string;
    firstName: string | null;
  },
): Promise<string> {
  const id = uuidv7();
  const code = generateOtpCode();
  const expiresAt = await repo.insertChallenge(trx, {
    id,
    schoolId: input.schoolId,
    subjectKind: input.subjectKind,
    subjectId: input.subjectId,
    codeHash: hashOtp(id, code),
  });
  await enqueueEvent(trx, input.schoolId, {
    type: "auth.otp_requested",
    data: {
      channel: input.channel,
      to: input.to,
      first_name: input.firstName,
      code,
      expires_at: expiresAt.toISOString(),
    },
  });
  return id;
}

/** Não lança por código errado: o chamador precisa commitar o incremento de tentativas. */
export async function checkCode(trx: Trx, challengeId: string, code: string): Promise<OtpResult> {
  const challenge = await repo.lockChallenge(trx, challengeId);
  if (!challenge || challenge.consumedAt || challenge.expired) return "expired";
  if (challenge.attempts >= MAX_ATTEMPTS) return "too_many_attempts";
  await repo.incrementAttempts(trx, challengeId);
  if (hashOtp(challengeId, code) !== challenge.codeHash) return "invalid";
  await repo.consumeChallenge(trx, challengeId);
  return "ok";
}

export function assertOtpOk(result: OtpResult): void {
  if (result === "invalid") throw new DomainError("otp_invalid");
  if (result === "expired") throw new DomainError("otp_expired");
  if (result === "too_many_attempts") throw new DomainError("otp_too_many_attempts");
}

const OtpTokenPayload = z.discriminatedUnion("subjectKind", [
  z.object({
    subjectKind: z.literal("guardian"),
    schoolId: z.string().uuid(),
    challengeId: z.string().uuid(),
    subjectId: z.string().uuid(),
    deviceHash: z.string(),
    scope: z.enum(["order", "documents"]),
  }),
  z.object({
    subjectKind: z.literal("staff"),
    schoolId: z.string().uuid(),
    challengeId: z.string().uuid(),
    subjectId: z.string().uuid(),
  }),
  z.object({ subjectKind: z.literal("none") }),
]);
export type OtpTokenPayload = z.infer<typeof OtpTokenPayload>;

export function signOtpToken(payload: OtpTokenPayload): Promise<string> {
  return signToken("otp", payload, OTP_TOKEN_TTL);
}

export async function readOtpToken(token: string): Promise<OtpTokenPayload> {
  try {
    return OtpTokenPayload.parse(await verifyToken("otp", token));
  } catch {
    throw new DomainError("otp_expired");
  }
}
```

- [ ] **Step 5: Estender o `repo.ts`**

Acrescente a `apps/api/src/modules/auth/repo.ts` (troque a linha de import de `../../db/index` pela primeira abaixo):
```ts
import { getDb, type Trx } from "../../db/index";

export async function insertMagicLink(
  trx: Trx,
  row: {
    id: string;
    schoolId: string;
    guardianId: string;
    tokenHash: string;
    scope: "order" | "documents";
    serviceDate: string | null;
    expiresAt: Date;
  },
): Promise<void> {
  await trx.insertInto("magicLinks").values(row).execute();
}

/** Insere o desafio com validade de 5 minutos pelo relógio do banco e devolve o vencimento. */
export async function insertChallenge(
  trx: Trx,
  row: { id: string; schoolId: string; subjectKind: "guardian" | "staff"; subjectId: string; codeHash: string },
): Promise<Date> {
  const inserted = await trx
    .insertInto("otpChallenges")
    .values({ ...row, expiresAt: sql<Date>`now() + interval '5 minutes'` })
    .returning("expiresAt")
    .executeTakeFirstOrThrow();
  return inserted.expiresAt;
}

export async function lockChallenge(trx: Trx, id: string) {
  return trx
    .selectFrom("otpChallenges")
    .select(["id", "codeHash", "attempts", "consumedAt"])
    .select(sql<boolean>`${sql.ref("expiresAt")} <= now()`.as("expired"))
    .where("id", "=", id)
    .forUpdate()
    .executeTakeFirst();
}

export async function incrementAttempts(trx: Trx, id: string): Promise<void> {
  await trx
    .updateTable("otpChallenges")
    .set((eb) => ({ attempts: eb("attempts", "+", 1) }))
    .where("id", "=", id)
    .execute();
}

export async function consumeChallenge(trx: Trx, id: string): Promise<void> {
  await trx
    .updateTable("otpChallenges")
    .set({ consumedAt: sql<Date>`now()` })
    .where("id", "=", id)
    .execute();
}
```

- [ ] **Step 6: Rodar e ver passar**

Run: `pnpm test:api && pnpm typecheck`
Expected: todos PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(auth): add magic link creation and OTP challenges"
```

---

### Task 4: Rotas de autenticação do responsável

**Files:**
- Create: `packages/contracts/src/auth.ts`; Modify: `packages/contracts/src/index.ts`
- Create: `apps/api/src/modules/auth/service.ts`, `apps/api/src/modules/auth/routes.ts`
- Modify: `apps/api/src/modules/auth/repo.ts`, `apps/api/src/app.ts` (registrar `authRoutes`)
- Test: `apps/api/src/modules/auth/guardianAuth.test.ts`

**Interfaces:**
- Consumes: `resolveMagicLink`, `createChallenge`, `checkCode`, `assertOtpOk`, `signOtpToken`, `readOtpToken`, `hashToken`, `issueSession`, `GUARDIAN_SESSION_TTL`, `withTenant`.
- Produces (contracts): `ExchangeRequest { token, deviceSecret }`, `ExchangeResponse` (`{ status: "ok", scope }` | `{ status: "step_up_required", otpToken }`), `OtpVerifyRequest { otpToken, code }`, `OtpVerifyResponse { status: "ok", scope }`, `MeResponse { guardian: { id, firstName }, students: [{ id, firstName, className }] }`.
- Produces (rotas): `POST /api/v1/auth/exchange` (pública), `POST /api/v1/auth/otp/verify` (pública), `GET /api/v1/me` (responsável, qualquer escopo).
- Produces (service): `exchange`, `verifyGuardianOtp`, `getMe` (assinaturas no Step 4).
- Regra de aparelho: se o responsável não tem nenhum aparelho registrado, o primeiro é registrado sem OTP. Aparelho já registrado entra direto. Qualquer outro exige OTP e é registrado após a verificação.

- [ ] **Step 1: Contratos**

`packages/contracts/src/auth.ts`:
```ts
import { z } from "zod";

export const GuardianScope = z.enum(["order", "documents"]);
export type GuardianScope = z.infer<typeof GuardianScope>;

export const StaffRole = z.enum(["admin", "secretaria", "cozinha"]);
export type StaffRole = z.infer<typeof StaffRole>;

export const ExchangeRequest = z.object({
  token: z.string().min(20).max(200),
  deviceSecret: z.string().min(32).max(200),
});
export type ExchangeRequest = z.infer<typeof ExchangeRequest>;

export const ExchangeResponse = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), scope: GuardianScope }),
  z.object({ status: z.literal("step_up_required"), otpToken: z.string() }),
]);
export type ExchangeResponse = z.infer<typeof ExchangeResponse>;

export const OtpVerifyRequest = z.object({
  otpToken: z.string().min(1),
  code: z.string().regex(/^\d{6}$/),
});
export type OtpVerifyRequest = z.infer<typeof OtpVerifyRequest>;

export const OtpVerifyResponse = z.object({ status: z.literal("ok"), scope: GuardianScope });
export type OtpVerifyResponse = z.infer<typeof OtpVerifyResponse>;

export const MeResponse = z.object({
  guardian: z.object({ id: z.string().uuid(), firstName: z.string() }),
  students: z.array(
    z.object({ id: z.string().uuid(), firstName: z.string(), className: z.string() }),
  ),
});
export type MeResponse = z.infer<typeof MeResponse>;
```

`packages/contracts/src/index.ts`:
```ts
export * from "./auth";
export * from "./errors";
export * from "./events";
```

- [ ] **Step 2: Escrever o teste que falha**

`apps/api/src/modules/auth/guardianAuth.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { adminDb, createSchool, seedTenant } from "../../../test/helpers";
import { buildApp } from "../../app";
import { withTenant } from "../../db/index";
import { SESSION_COOKIE } from "../../platform/session";
import { createMagicLink } from "./magicLink";

const DEVICE_A = "a".repeat(43);
const DEVICE_B = "b".repeat(43);

async function setup(expiresInMs = 3_600_000) {
  const schoolId = await createSchool();
  const seed = await seedTenant(schoolId);
  const link = await withTenant(schoolId, (trx) =>
    createMagicLink(trx, {
      schoolId,
      guardianId: seed.guardianId,
      scope: "order",
      expiresAt: new Date(Date.now() + expiresInMs),
    }),
  );
  return { schoolId, seed, token: link.url.split("#")[1]! };
}

function exchange(token: string, deviceSecret: string) {
  return buildApp().inject({ method: "POST", url: "/api/v1/auth/exchange", payload: { token, deviceSecret } });
}

function verify(otpToken: string, code: string) {
  return buildApp().inject({ method: "POST", url: "/api/v1/auth/otp/verify", payload: { otpToken, code } });
}

async function lastOtpCode(schoolId: string): Promise<string> {
  const event = await adminDb()
    .selectFrom("outboxEvents")
    .select("data")
    .where("schoolId", "=", schoolId)
    .where("type", "=", "auth.otp_requested")
    .orderBy("occurredAt", "desc")
    .executeTakeFirstOrThrow();
  return (event.data as { code: string }).code;
}

function sessionCookie(res: { cookies: { name: string; value: string }[] }) {
  return res.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
}

describe("guardian authentication", () => {
  it("opens a session on the first device and lists the children", async () => {
    const { token, seed } = await setup();
    const res = await exchange(token, DEVICE_A);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", scope: "order" });
    const cookie = sessionCookie(res)!;
    const me = await buildApp().inject({ method: "GET", url: "/api/v1/me", cookies: { [SESSION_COOKIE]: cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({
      guardian: { id: seed.guardianId, firstName: "Ana" },
      students: [{ id: seed.studentId, firstName: "Léo", className: "Infantil 3A" }],
    });
  });

  it("lets the same device reuse the link", async () => {
    const { token } = await setup();
    await exchange(token, DEVICE_A);
    const again = await exchange(token, DEVICE_A);
    expect(again.json().status).toBe("ok");
  });

  it("requires OTP on a second device, then remembers it", async () => {
    const { token, schoolId } = await setup();
    await exchange(token, DEVICE_A);

    const second = await exchange(token, DEVICE_B);
    expect(second.json().status).toBe("step_up_required");
    expect(sessionCookie(second)).toBeUndefined();
    const { otpToken } = second.json();
    const code = await lastOtpCode(schoolId);

    const bad = await verify(otpToken, code === "000000" ? "000001" : "000000");
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe("otp_invalid");
    const attempts = await adminDb()
      .selectFrom("otpChallenges")
      .select("attempts")
      .where("schoolId", "=", schoolId)
      .where("codeHash", "<>", "seed")
      .executeTakeFirstOrThrow();
    expect(attempts.attempts).toBe(1);

    const good = await verify(otpToken, code);
    expect(good.statusCode).toBe(200);
    expect(good.json()).toEqual({ status: "ok", scope: "order" });
    expect(sessionCookie(good)).toBeDefined();

    const third = await exchange(token, DEVICE_B);
    expect(third.json().status).toBe("ok");
  });

  it("rejects an unknown token", async () => {
    const res = await exchange("x".repeat(43), DEVICE_A);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("invalid_token");
  });

  it("rejects an expired link", async () => {
    const { token } = await setup(-1000);
    const res = await exchange(token, DEVICE_A);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("invalid_token");
  });

  it("rejects an unreadable otp token", async () => {
    const res = await verify("garbage", "123456");
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("otp_expired");
  });

  it("requires a session for /me", async () => {
    const res = await buildApp().inject({ method: "GET", url: "/api/v1/me" });
    expect(res.statusCode).toBe(401);
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `pnpm test:api -- guardianAuth.test`
Expected: FAIL — rotas respondem 404.

- [ ] **Step 4: Implementar repo e service**

Acrescente a `apps/api/src/modules/auth/repo.ts`:
```ts
export async function getValidMagicLink(trx: Trx, id: string) {
  return trx
    .selectFrom("magicLinks")
    .select(["id", "guardianId", "scope"])
    .where("id", "=", id)
    .where(sql<boolean>`${sql.ref("expiresAt")} > now()`)
    .executeTakeFirst();
}

/** Trava o responsável para serializar o registro do primeiro aparelho. */
export async function lockGuardian(trx: Trx, guardianId: string) {
  return trx
    .selectFrom("guardians")
    .select(["id", "firstName", "phoneE164"])
    .where("id", "=", guardianId)
    .forUpdate()
    .executeTakeFirstOrThrow();
}

export async function listGuardianDeviceHashes(trx: Trx, guardianId: string): Promise<string[]> {
  const rows = await trx
    .selectFrom("devices")
    .select("secretHash")
    .where("guardianId", "=", guardianId)
    .where("kind", "=", "guardian")
    .where("revokedAt", "is", null)
    .execute();
  return rows.map((r) => r.secretHash).filter((h): h is string => h !== null);
}

export async function insertGuardianDevice(
  trx: Trx,
  row: { id: string; schoolId: string; guardianId: string; secretHash: string },
): Promise<void> {
  await trx
    .insertInto("devices")
    .values({ ...row, kind: "guardian" })
    .onConflict((oc) => oc.doNothing())
    .execute();
}

export async function getGuardianWithStudents(trx: Trx, guardianId: string) {
  const guardian = await trx
    .selectFrom("guardians")
    .select(["id", "firstName"])
    .where("id", "=", guardianId)
    .executeTakeFirst();
  if (!guardian) return undefined;
  const students = await trx
    .selectFrom("guardianStudents")
    .innerJoin("students", "students.id", "guardianStudents.studentId")
    .innerJoin("classes", "classes.id", "students.classId")
    .select(["students.id", "students.firstName", "classes.name as className"])
    .where("guardianStudents.guardianId", "=", guardianId)
    .where("students.active", "=", true)
    .orderBy("students.firstName")
    .execute();
  return { guardian, students };
}
```

`apps/api/src/modules/auth/service.ts`:
```ts
import type { MeResponse } from "@app-lanche/contracts";
import { uuidv7 } from "uuidv7";
import { withTenant } from "../../db/index";
import { DomainError } from "../../platform/errors";
import type { GuardianScope, SessionClaims } from "../../platform/session";
import { assertOtpOk, checkCode, createChallenge, readOtpToken, signOtpToken } from "./otp";
import * as repo from "./repo";
import { hashToken } from "./tokens";

export type ExchangeResult =
  | { status: "ok"; claims: SessionClaims; scope: GuardianScope }
  | { status: "step_up_required"; otpToken: string };

export async function exchange(input: { token: string; deviceSecret: string }): Promise<ExchangeResult> {
  const resolved = await repo.resolveMagicLink(hashToken(input.token));
  if (!resolved) throw new DomainError("invalid_token");
  const { schoolId } = resolved;
  const deviceHash = hashToken(input.deviceSecret);

  const outcome = await withTenant(schoolId, async (trx) => {
    const link = await repo.getValidMagicLink(trx, resolved.magicLinkId);
    if (!link) return { kind: "invalid" as const };
    const guardian = await repo.lockGuardian(trx, link.guardianId);
    const known = await repo.listGuardianDeviceHashes(trx, guardian.id);
    if (known.length === 0) {
      await repo.insertGuardianDevice(trx, { id: uuidv7(), schoolId, guardianId: guardian.id, secretHash: deviceHash });
    }
    if (known.length === 0 || known.includes(deviceHash)) {
      return { kind: "ok" as const, guardianId: guardian.id, scope: link.scope as GuardianScope };
    }
    const challengeId = await createChallenge(trx, {
      schoolId,
      subjectKind: "guardian",
      subjectId: guardian.id,
      channel: "whatsapp",
      to: guardian.phoneE164,
      firstName: guardian.firstName,
    });
    return { kind: "step_up" as const, guardianId: guardian.id, scope: link.scope as GuardianScope, challengeId };
  });

  if (outcome.kind === "invalid") throw new DomainError("invalid_token");
  if (outcome.kind === "ok") {
    return {
      status: "ok",
      scope: outcome.scope,
      claims: { kind: "guardian", sub: outcome.guardianId, schoolId, scope: outcome.scope },
    };
  }
  const otpToken = await signOtpToken({
    subjectKind: "guardian",
    schoolId,
    challengeId: outcome.challengeId,
    subjectId: outcome.guardianId,
    deviceHash,
    scope: outcome.scope,
  });
  return { status: "step_up_required", otpToken };
}

export async function verifyGuardianOtp(input: {
  otpToken: string;
  code: string;
}): Promise<{ claims: SessionClaims; scope: GuardianScope }> {
  const payload = await readOtpToken(input.otpToken);
  if (payload.subjectKind !== "guardian") throw new DomainError("otp_invalid");
  const result = await withTenant(payload.schoolId, async (trx) => {
    const checked = await checkCode(trx, payload.challengeId, input.code);
    if (checked === "ok") {
      await repo.insertGuardianDevice(trx, {
        id: uuidv7(),
        schoolId: payload.schoolId,
        guardianId: payload.subjectId,
        secretHash: payload.deviceHash,
      });
    }
    return checked;
  });
  assertOtpOk(result);
  return {
    scope: payload.scope,
    claims: {
      kind: "guardian",
      sub: payload.subjectId,
      schoolId: payload.schoolId,
      scope: payload.scope,
      otpAt: Math.floor(Date.now() / 1000),
    },
  };
}

export async function getMe(session: SessionClaims): Promise<MeResponse> {
  const found = await withTenant(session.schoolId, (trx) => repo.getGuardianWithStudents(trx, session.sub));
  if (!found) throw new DomainError("unauthenticated");
  return found;
}
```

- [ ] **Step 5: Implementar as rotas**

`apps/api/src/modules/auth/routes.ts`:
```ts
import { ExchangeRequest, OtpVerifyRequest } from "@app-lanche/contracts";
import type { FastifyInstance } from "fastify";
import { GUARDIAN_SESSION_TTL, issueSession } from "../../platform/session";
import * as service from "./service";

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/v1/auth/exchange", { config: { auth: "public" } }, async (req, reply) => {
    const result = await service.exchange(ExchangeRequest.parse(req.body));
    if (result.status === "step_up_required") return result;
    await issueSession(reply, result.claims, GUARDIAN_SESSION_TTL);
    return { status: "ok", scope: result.scope };
  });

  app.post("/api/v1/auth/otp/verify", { config: { auth: "public" } }, async (req, reply) => {
    const result = await service.verifyGuardianOtp(OtpVerifyRequest.parse(req.body));
    await issueSession(reply, result.claims, GUARDIAN_SESSION_TTL);
    return { status: "ok", scope: result.scope };
  });

  app.get("/api/v1/me", { config: { auth: { kind: "guardian" } } }, async (req) =>
    service.getMe(req.session!),
  );
}
```

Em `apps/api/src/app.ts`, importe e registre antes do `return app`:
```ts
import { authRoutes } from "./modules/auth/routes";
```
```ts
  app.register(authRoutes);
```

- [ ] **Step 6: Rodar e ver passar**

Run: `pnpm test && pnpm typecheck`
Expected: todos PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(auth): add guardian magic link exchange, OTP step-up and /me"
```

---

### Task 5: Login da equipe e criação de escola

**Files:**
- Modify: `packages/contracts/src/auth.ts`
- Modify: `apps/api/src/modules/auth/repo.ts`, `apps/api/src/modules/auth/service.ts`, `apps/api/src/modules/auth/routes.ts`
- Create: `apps/api/src/cli/createSchool.ts`; Modify: `apps/api/package.json` (script)
- Test: `apps/api/src/modules/auth/staffAuth.test.ts`

**Interfaces:**
- Consumes: `resolveStaffEmail`, `createChallenge`, `checkCode`, `assertOtpOk`, `signOtpToken`, `readOtpToken`, `issueSession`, `STAFF_SESSION_TTL`.
- Produces (contracts): `StaffOtpRequest { email }`, `StaffOtpRequestResponse { otpToken }`, `StaffOtpVerifyResponse { status: "ok", role }`, `StaffMeResponse { id, email, role, schoolName }`.
- Produces (rotas): `POST /api/admin/v1/auth/otp/request` (pública), `POST /api/admin/v1/auth/otp/verify` (pública; corpo `OtpVerifyRequest`), `GET /api/admin/v1/me` (equipe).
- Produces (CLI): `pnpm --filter @app-lanche/api cli:create-school "<nome>" <email-admin>`.
- Regra: `request` responde 200 com um `otpToken` mesmo para e-mail desconhecido (token com `subjectKind: "none"`), e não enfileira evento nesse caso.

- [ ] **Step 1: Contratos**

Acrescente a `packages/contracts/src/auth.ts`:
```ts
export const StaffOtpRequest = z.object({ email: z.string().email().max(200) });
export type StaffOtpRequest = z.infer<typeof StaffOtpRequest>;

export const StaffOtpRequestResponse = z.object({ otpToken: z.string() });
export type StaffOtpRequestResponse = z.infer<typeof StaffOtpRequestResponse>;

export const StaffOtpVerifyResponse = z.object({ status: z.literal("ok"), role: StaffRole });
export type StaffOtpVerifyResponse = z.infer<typeof StaffOtpVerifyResponse>;

export const StaffMeResponse = z.object({
  id: z.string().uuid(),
  email: z.string(),
  role: StaffRole,
  schoolName: z.string(),
});
export type StaffMeResponse = z.infer<typeof StaffMeResponse>;
```

- [ ] **Step 2: Escrever o teste que falha**

`apps/api/src/modules/auth/staffAuth.test.ts`:
```ts
import { uuidv7 } from "uuidv7";
import { describe, expect, it } from "vitest";
import { adminDb, createSchool, seedTenant } from "../../../test/helpers";
import { buildApp } from "../../app";
import { SESSION_COOKIE, signToken } from "../../platform/session";

function post(url: string, payload: unknown) {
  return buildApp().inject({ method: "POST", url, payload: payload as object });
}

async function otpEvents(schoolId: string) {
  return adminDb()
    .selectFrom("outboxEvents")
    .select("data")
    .where("schoolId", "=", schoolId)
    .where("type", "=", "auth.otp_requested")
    .execute();
}

describe("staff authentication", () => {
  it("logs in with e-mail and code", async () => {
    const schoolId = await createSchool("Escola Sol");
    const seed = await seedTenant(schoolId);

    const requested = await post("/api/admin/v1/auth/otp/request", { email: seed.email });
    expect(requested.statusCode).toBe(200);
    const { otpToken } = requested.json();
    const [event] = await otpEvents(schoolId);
    const data = event!.data as { code: string; channel: string; to: string };
    expect(data.channel).toBe("email");
    expect(data.to).toBe(seed.email);

    const verified = await post("/api/admin/v1/auth/otp/verify", { otpToken, code: data.code });
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toEqual({ status: "ok", role: "admin" });
    const cookie = verified.cookies.find((c) => c.name === SESSION_COOKIE)!;
    expect(cookie.maxAge).toBe(28_800);

    const me = await buildApp().inject({
      method: "GET",
      url: "/api/admin/v1/me",
      cookies: { [SESSION_COOKIE]: cookie.value },
    });
    expect(me.json()).toEqual({ id: seed.staffUserId, email: seed.email, role: "admin", schoolName: "Escola Sol" });
  });

  it("answers the same way for an unknown e-mail and sends nothing", async () => {
    const schoolId = await createSchool();
    await seedTenant(schoolId);
    const requested = await post("/api/admin/v1/auth/otp/request", { email: `nobody-${uuidv7()}@x.test` });
    expect(requested.statusCode).toBe(200);
    expect(typeof requested.json().otpToken).toBe("string");
    expect(await otpEvents(schoolId)).toEqual([]);

    const verified = await post("/api/admin/v1/auth/otp/verify", { otpToken: requested.json().otpToken, code: "123456" });
    expect(verified.statusCode).toBe(401);
    expect(verified.json().error.code).toBe("otp_invalid");
  });

  it("rejects a wrong code", async () => {
    const schoolId = await createSchool();
    const seed = await seedTenant(schoolId);
    const { otpToken } = (await post("/api/admin/v1/auth/otp/request", { email: seed.email })).json();
    const [event] = await otpEvents(schoolId);
    const code = (event!.data as { code: string }).code;
    const verified = await post("/api/admin/v1/auth/otp/verify", {
      otpToken,
      code: code === "000000" ? "000001" : "000000",
    });
    expect(verified.statusCode).toBe(401);
    expect(verified.json().error.code).toBe("otp_invalid");
  });

  it("does not accept a guardian session on staff routes", async () => {
    const token = await signToken(
      "session",
      { kind: "guardian", sub: uuidv7(), schoolId: uuidv7(), scope: "order" },
      60,
    );
    const res = await buildApp().inject({
      method: "GET",
      url: "/api/admin/v1/me",
      cookies: { [SESSION_COOKIE]: token },
    });
    expect(res.statusCode).toBe(403);
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `pnpm test:api -- staffAuth.test`
Expected: FAIL — rotas respondem 404.

- [ ] **Step 4: Implementar**

Acrescente a `apps/api/src/modules/auth/repo.ts`:
```ts
export async function getStaffUser(trx: Trx, id: string) {
  return trx
    .selectFrom("staffUsers")
    .innerJoin("schools", "schools.id", "staffUsers.schoolId")
    .select(["staffUsers.id", "staffUsers.email", "staffUsers.role", "schools.name as schoolName"])
    .where("staffUsers.id", "=", id)
    .where("staffUsers.active", "=", true)
    .executeTakeFirst();
}
```

Acrescente a `apps/api/src/modules/auth/service.ts` (e inclua `StaffMeResponse` e `StaffRole` nos imports de tipo):
```ts
import type { MeResponse, StaffMeResponse, StaffRole } from "@app-lanche/contracts";
```
```ts
export async function requestStaffOtp(email: string): Promise<{ otpToken: string }> {
  const resolved = await repo.resolveStaffEmail(email);
  if (!resolved) return { otpToken: await signOtpToken({ subjectKind: "none" }) };
  const challengeId = await withTenant(resolved.schoolId, (trx) =>
    createChallenge(trx, {
      schoolId: resolved.schoolId,
      subjectKind: "staff",
      subjectId: resolved.staffUserId,
      channel: "email",
      to: email.toLowerCase(),
      firstName: null,
    }),
  );
  const otpToken = await signOtpToken({
    subjectKind: "staff",
    schoolId: resolved.schoolId,
    challengeId,
    subjectId: resolved.staffUserId,
  });
  return { otpToken };
}

export async function verifyStaffOtp(input: {
  otpToken: string;
  code: string;
}): Promise<{ claims: SessionClaims; role: StaffRole }> {
  const payload = await readOtpToken(input.otpToken);
  if (payload.subjectKind !== "staff") throw new DomainError("otp_invalid");
  const outcome = await withTenant(payload.schoolId, async (trx) => {
    const checked = await checkCode(trx, payload.challengeId, input.code);
    const staff = checked === "ok" ? await repo.getStaffUser(trx, payload.subjectId) : undefined;
    return { checked, staff };
  });
  assertOtpOk(outcome.checked);
  if (!outcome.staff) throw new DomainError("otp_invalid");
  const role = outcome.staff.role as StaffRole;
  return {
    role,
    claims: { kind: "staff", sub: payload.subjectId, schoolId: payload.schoolId, role },
  };
}

export async function getStaffMe(session: SessionClaims): Promise<StaffMeResponse> {
  const staff = await withTenant(session.schoolId, (trx) => repo.getStaffUser(trx, session.sub));
  if (!staff) throw new DomainError("unauthenticated");
  return { ...staff, role: staff.role as StaffRole };
}
```

Acrescente a `authRoutes` em `apps/api/src/modules/auth/routes.ts` (e inclua `StaffOtpRequest` e `STAFF_SESSION_TTL` nos imports):
```ts
  app.post("/api/admin/v1/auth/otp/request", { config: { auth: "public" } }, async (req) =>
    service.requestStaffOtp(StaffOtpRequest.parse(req.body).email),
  );

  app.post("/api/admin/v1/auth/otp/verify", { config: { auth: "public" } }, async (req, reply) => {
    const result = await service.verifyStaffOtp(OtpVerifyRequest.parse(req.body));
    await issueSession(reply, result.claims, STAFF_SESSION_TTL);
    return { status: "ok", role: result.role };
  });

  app.get("/api/admin/v1/me", { config: { auth: { kind: "staff" } } }, async (req) =>
    service.getStaffMe(req.session!),
  );
```

- [ ] **Step 5: Rodar e ver passar**

Run: `pnpm test:api && pnpm typecheck`
Expected: todos PASS.

- [ ] **Step 6: CLI de criação de escola**

`apps/api/src/cli/createSchool.ts`:
```ts
import pg from "pg";
import { uuidv7 } from "uuidv7";

// Operação de plataforma: roda com o usuário administrador, fora da aplicação.
const [name, email] = process.argv.slice(2);
const adminUrl = process.env.DATABASE_ADMIN_URL;
if (!name || !email || !adminUrl) {
  console.error('usage: DATABASE_ADMIN_URL=... cli:create-school "<school name>" <admin email>');
  process.exit(1);
}

const client = new pg.Client({ connectionString: adminUrl });
await client.connect();
try {
  const schoolId = uuidv7();
  await client.query("BEGIN");
  await client.query("INSERT INTO schools (id, name) VALUES ($1, $2)", [schoolId, name]);
  await client.query(
    "INSERT INTO staff_users (id, school_id, email, role) VALUES ($1, $2, lower($3), 'admin')",
    [uuidv7(), schoolId, email],
  );
  await client.query("COMMIT");
  console.log(`school created: ${schoolId}`);
} catch (err) {
  await client.query("ROLLBACK");
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await client.end();
}
```

Em `apps/api/package.json`, acrescente ao bloco `scripts`:
```json
"cli:create-school": "tsx src/cli/createSchool.ts"
```

Run:
```bash
DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/app_lanche pnpm --filter @app-lanche/api cli:create-school "Escola Piloto" admin@piloto.test
```
Expected: `school created: <uuid>`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(auth): add staff OTP login and school creation CLI"
```

---

### Task 6: Importação CSV e listagens

**Files:**
- Create: `packages/contracts/src/registry.ts`; Modify: `packages/contracts/src/index.ts`
- Create: `apps/api/src/platform/audit.ts`
- Create: `apps/api/src/modules/registry/csv.ts`, `repo.ts`, `service.ts`, `routes.ts`
- Modify: `apps/api/src/app.ts` (registrar `registryRoutes`)
- Test: `apps/api/src/modules/registry/csv.test.ts`, `apps/api/src/modules/registry/import.test.ts`

**Interfaces:**
- Consumes: `withTenant`, `Trx`, `SessionClaims`, guarda de rota com `roles`.
- Produces (contracts): `ImportStudentsRequest { csv }`, `ImportStudentsResponse { applied, errors: [{ line, message }], classes, students, guardians }`, `ClassListResponse { classes: [{ id, name }] }`, `StudentListResponse { students: [{ id, externalCode, firstName, className, guardians: [{ id, firstName, phone }] }] }`.
- Produces (rotas, equipe com papel `admin` ou `secretaria`): `POST /api/admin/v1/import/students`, `GET /api/admin/v1/classes`, `GET /api/admin/v1/students`.
- Produces: `audit(trx: Trx, entry: { schoolId: string; actorKind: "guardian" | "staff" | "kitchen" | "system"; actorId: string | null; action: string; detail?: Record<string, unknown> }): Promise<void>`.
- Produces: `normalizePhoneBR(raw: string): string | null`, `parseStudentsCsv(csv: string): { rows: StudentRow[]; errors: { line: number; message: string }[] }` com `StudentRow = { line: number; externalCode: string; firstName: string; className: string; guardianFirstName: string; guardianPhone: string }`.
- Formato do CSV (cabeçalho obrigatório): `codigo_aluno,primeiro_nome,turma,responsavel_nome,responsavel_telefone`. Um aluno com dois responsáveis ocupa duas linhas com o mesmo `codigo_aluno`.
- Regra: a importação é tudo ou nada. Com qualquer erro de linha, nada é gravado e `applied` é `false`. Reimportar o mesmo arquivo não duplica nada.

- [ ] **Step 1: Instalar e escrever contratos**

Run: `pnpm --filter @app-lanche/api add csv-parse`

`packages/contracts/src/registry.ts`:
```ts
import { z } from "zod";

export const ImportStudentsRequest = z.object({ csv: z.string().min(1).max(900_000) });
export type ImportStudentsRequest = z.infer<typeof ImportStudentsRequest>;

export const ImportStudentsResponse = z.object({
  applied: z.boolean(),
  errors: z.array(z.object({ line: z.number().int(), message: z.string() })),
  classes: z.number().int(),
  students: z.number().int(),
  guardians: z.number().int(),
});
export type ImportStudentsResponse = z.infer<typeof ImportStudentsResponse>;

export const ClassListResponse = z.object({
  classes: z.array(z.object({ id: z.string().uuid(), name: z.string() })),
});
export type ClassListResponse = z.infer<typeof ClassListResponse>;

export const StudentListResponse = z.object({
  students: z.array(
    z.object({
      id: z.string().uuid(),
      externalCode: z.string(),
      firstName: z.string(),
      className: z.string(),
      guardians: z.array(z.object({ id: z.string().uuid(), firstName: z.string(), phone: z.string() })),
    }),
  ),
});
export type StudentListResponse = z.infer<typeof StudentListResponse>;
```

`packages/contracts/src/index.ts`:
```ts
export * from "./auth";
export * from "./errors";
export * from "./events";
export * from "./registry";
```

- [ ] **Step 2: Escrever o teste do CSV (falha)**

`apps/api/src/modules/registry/csv.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { normalizePhoneBR, parseStudentsCsv } from "./csv";

const HEADER = "codigo_aluno,primeiro_nome,turma,responsavel_nome,responsavel_telefone";

describe("normalizePhoneBR", () => {
  it.each([
    ["(11) 99999-0001", "+5511999990001"],
    ["11 3333-4444", "+551133334444"],
    ["5511999990001", "+5511999990001"],
    ["+55 11 99999-0001", "+5511999990001"],
    ["+1 415 555 0100", "+14155550100"],
  ])("%s -> %s", (raw, expected) => {
    expect(normalizePhoneBR(raw)).toBe(expected);
  });

  it.each(["", "123", "999990001", "abc"])("rejects %j", (raw) => {
    expect(normalizePhoneBR(raw)).toBeNull();
  });
});

describe("parseStudentsCsv", () => {
  it("parses rows and normalizes phones", () => {
    const { rows, errors } = parseStudentsCsv(`${HEADER}\nA001,Léo,Infantil 3A,Ana,(11) 99999-0001\n`);
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { line: 2, externalCode: "A001", firstName: "Léo", className: "Infantil 3A", guardianFirstName: "Ana", guardianPhone: "+5511999990001" },
    ]);
  });

  it("reports the line of each invalid row", () => {
    const { rows, errors } = parseStudentsCsv(
      `${HEADER}\nA001,Léo,Infantil 3A,Ana,123\n,Bia,Infantil 3A,Ana,11999990001\n`,
    );
    expect(rows).toEqual([]);
    expect(errors).toEqual([
      { line: 2, message: "telefone inválido" },
      { line: 3, message: "codigo_aluno vazio" },
    ]);
  });

  it("reports a missing column in the header", () => {
    const { errors } = parseStudentsCsv("codigo_aluno,primeiro_nome\nA001,Léo\n");
    expect(errors).toEqual([
      { line: 1, message: "coluna ausente: turma, responsavel_nome, responsavel_telefone" },
    ]);
  });

  it("reports a file that cannot be parsed", () => {
    const { errors } = parseStudentsCsv(`${HEADER}\n"A001,Léo`);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe("arquivo CSV inválido");
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `pnpm test:api -- csv.test`
Expected: FAIL — `./csv` não existe.

- [ ] **Step 4: Implementar o parser**

`apps/api/src/modules/registry/csv.ts`:
```ts
import { parse } from "csv-parse/sync";

const COLUMNS = ["codigo_aluno", "primeiro_nome", "turma", "responsavel_nome", "responsavel_telefone"] as const;

export type StudentRow = {
  line: number;
  externalCode: string;
  firstName: string;
  className: string;
  guardianFirstName: string;
  guardianPhone: string;
};

export type CsvError = { line: number; message: string };

/** Devolve o telefone em E.164 ou null. Sem código de país, assume Brasil. */
export function normalizePhoneBR(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (raw.trim().startsWith("+")) {
    return digits.length >= 8 && digits.length <= 15 && !digits.startsWith("0") ? `+${digits}` : null;
  }
  if (digits.length === 10 || digits.length === 11) return `+55${digits}`;
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith("55")) return `+${digits}`;
  return null;
}

export function parseStudentsCsv(csv: string): { rows: StudentRow[]; errors: CsvError[] } {
  let records: Record<string, string>[];
  try {
    records = parse(csv, { columns: true, skip_empty_lines: true, trim: true, bom: true });
  } catch {
    return { rows: [], errors: [{ line: 1, message: "arquivo CSV inválido" }] };
  }
  const header = records[0] ? Object.keys(records[0]) : [];
  const missing = COLUMNS.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    return { rows: [], errors: [{ line: 1, message: `coluna ausente: ${missing.join(", ")}` }] };
  }

  const rows: StudentRow[] = [];
  const errors: CsvError[] = [];
  records.forEach((record, index) => {
    const line = index + 2;
    const empty = COLUMNS.find((c) => !record[c]);
    if (empty) {
      errors.push({ line, message: `${empty} vazio` });
      return;
    }
    const phone = normalizePhoneBR(record.responsavel_telefone!);
    if (!phone) {
      errors.push({ line, message: "telefone inválido" });
      return;
    }
    rows.push({
      line,
      externalCode: record.codigo_aluno!,
      firstName: record.primeiro_nome!,
      className: record.turma!,
      guardianFirstName: record.responsavel_nome!,
      guardianPhone: phone,
    });
  });
  return errors.length > 0 ? { rows: [], errors } : { rows, errors };
}
```

Run: `pnpm test:api -- csv.test`
Expected: PASS.

- [ ] **Step 5: Escrever o teste da importação (falha)**

`apps/api/src/modules/registry/import.test.ts`:
```ts
import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { describe, expect, it } from "vitest";
import { adminDb, createSchool } from "../../../test/helpers";
import { buildApp } from "../../app";
import { SESSION_COOKIE, signToken, type StaffRole } from "../../platform/session";

const CSV = [
  "codigo_aluno,primeiro_nome,turma,responsavel_nome,responsavel_telefone",
  "A001,Léo,Infantil 3A,Ana,(11) 99999-0001",
  "A002,Bia,Infantil 2B,Ana,(11) 99999-0001",
  "A001,Léo,Infantil 3A,Rui,(11) 98888-0002",
].join("\n");

async function staffCookie(schoolId: string, role: StaffRole = "secretaria") {
  const id = uuidv7();
  await adminDb()
    .insertInto("staffUsers")
    .values({ id, schoolId, email: `s-${id}@escola.test`, role })
    .execute();
  return { [SESSION_COOKIE]: await signToken("session", { kind: "staff", sub: id, schoolId, role }, 60) };
}

function importCsv(cookies: Record<string, string>, csv: string) {
  return buildApp().inject({ method: "POST", url: "/api/admin/v1/import/students", cookies, payload: { csv } });
}

async function counts(schoolId: string) {
  const count = async (table: string) => {
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM ${sql.table(table)} WHERE school_id = ${schoolId}`.execute(adminDb());
    return rows[0]!.n;
  };
  return {
    classes: await count("classes"),
    students: await count("students"),
    guardians: await count("guardians"),
    links: await count("guardian_students"),
  };
}

describe("student import", () => {
  it("creates classes, students, guardians and links", async () => {
    const schoolId = await createSchool();
    const res = await importCsv(await staffCookie(schoolId), CSV);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ applied: true, errors: [], classes: 2, students: 2, guardians: 2 });
    expect(await counts(schoolId)).toEqual({ classes: 2, students: 2, guardians: 2, links: 3 });
  });

  it("is idempotent and updates changed data", async () => {
    const schoolId = await createSchool();
    const cookies = await staffCookie(schoolId);
    await importCsv(cookies, CSV);
    await importCsv(cookies, CSV.replace("A002,Bia,Infantil 2B", "A002,Beatriz,Infantil 3A"));
    expect(await counts(schoolId)).toEqual({ classes: 2, students: 2, guardians: 2, links: 3 });
    const bia = await adminDb()
      .selectFrom("students")
      .innerJoin("classes", "classes.id", "students.classId")
      .select(["students.firstName", "classes.name"])
      .where("students.schoolId", "=", schoolId)
      .where("students.externalCode", "=", "A002")
      .executeTakeFirstOrThrow();
    expect(bia).toEqual({ firstName: "Beatriz", name: "Infantil 3A" });
  });

  it("writes nothing when any line is invalid", async () => {
    const schoolId = await createSchool();
    const res = await importCsv(await staffCookie(schoolId), `${CSV}\nA003,Caio,Infantil 3A,Eva,123`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      applied: false,
      errors: [{ line: 5, message: "telefone inválido" }],
      classes: 0,
      students: 0,
      guardians: 0,
    });
    expect(await counts(schoolId)).toEqual({ classes: 0, students: 0, guardians: 0, links: 0 });
  });

  it("records the import in the audit log", async () => {
    const schoolId = await createSchool();
    await importCsv(await staffCookie(schoolId), CSV);
    const entry = await adminDb()
      .selectFrom("auditLog")
      .select(["action", "actorKind", "detail"])
      .where("schoolId", "=", schoolId)
      .executeTakeFirstOrThrow();
    expect(entry).toEqual({
      action: "students.import",
      actorKind: "staff",
      detail: { classes: 2, students: 2, guardians: 2 },
    });
  });

  it("is forbidden for the kitchen role", async () => {
    const schoolId = await createSchool();
    const res = await importCsv(await staffCookie(schoolId, "cozinha"), CSV);
    expect(res.statusCode).toBe(403);
  });

  it("lists classes and students of the staff's school only", async () => {
    const schoolId = await createSchool();
    const other = await createSchool();
    const cookies = await staffCookie(schoolId);
    await importCsv(cookies, CSV);
    await importCsv(await staffCookie(other), CSV.replace("A001,Léo", "A001,Outro"));

    const classes = await buildApp().inject({ method: "GET", url: "/api/admin/v1/classes", cookies });
    expect(classes.json().classes.map((c: { name: string }) => c.name)).toEqual(["Infantil 2B", "Infantil 3A"]);

    const students = await buildApp().inject({ method: "GET", url: "/api/admin/v1/students", cookies });
    const list = students.json().students as {
      firstName: string;
      className: string;
      guardians: { firstName: string; phone: string }[];
    }[];
    expect(list.map((s) => s.firstName)).toEqual(["Bia", "Léo"]);
    expect(list[1]!.guardians.map((g) => g.firstName).sort()).toEqual(["Ana", "Rui"]);
    expect(list[0]!.guardians).toMatchObject([{ firstName: "Ana", phone: "+5511999990001" }]);
  });
});
```

- [ ] **Step 6: Rodar e ver falhar**

Run: `pnpm test:api -- import.test`
Expected: FAIL — rotas respondem 404.

- [ ] **Step 7: Implementar**

`apps/api/src/platform/audit.ts`:
```ts
import { uuidv7 } from "uuidv7";
import type { Trx } from "../db/index";

/** Detalhe nunca contém dado pessoal: só ids e contagens. */
export async function audit(
  trx: Trx,
  entry: {
    schoolId: string;
    actorKind: "guardian" | "staff" | "kitchen" | "system";
    actorId: string | null;
    action: string;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await trx
    .insertInto("auditLog")
    .values({
      id: uuidv7(),
      schoolId: entry.schoolId,
      actorKind: entry.actorKind,
      actorId: entry.actorId,
      action: entry.action,
      detail: JSON.stringify(entry.detail ?? {}),
    })
    .execute();
}
```

`apps/api/src/modules/registry/repo.ts`:
```ts
import { uuidv7 } from "uuidv7";
import type { Trx } from "../../db/index";

export async function upsertClass(trx: Trx, schoolId: string, name: string): Promise<string> {
  const row = await trx
    .insertInto("classes")
    .values({ id: uuidv7(), schoolId, name })
    .onConflict((oc) => oc.columns(["schoolId", "name"]).doUpdateSet({ name }))
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function upsertStudent(
  trx: Trx,
  row: { schoolId: string; externalCode: string; firstName: string; classId: string },
): Promise<string> {
  const saved = await trx
    .insertInto("students")
    .values({ id: uuidv7(), ...row })
    .onConflict((oc) =>
      oc.columns(["schoolId", "externalCode"]).doUpdateSet({ firstName: row.firstName, classId: row.classId }),
    )
    .returning("id")
    .executeTakeFirstOrThrow();
  return saved.id;
}

export async function upsertGuardian(
  trx: Trx,
  row: { schoolId: string; phoneE164: string; firstName: string },
): Promise<string> {
  const saved = await trx
    .insertInto("guardians")
    .values({ id: uuidv7(), ...row })
    .onConflict((oc) => oc.columns(["schoolId", "phoneE164"]).doUpdateSet({ firstName: row.firstName }))
    .returning("id")
    .executeTakeFirstOrThrow();
  return saved.id;
}

export async function linkGuardianStudent(
  trx: Trx,
  row: { schoolId: string; guardianId: string; studentId: string },
): Promise<void> {
  await trx
    .insertInto("guardianStudents")
    .values(row)
    .onConflict((oc) => oc.doNothing())
    .execute();
}

export async function listClasses(trx: Trx) {
  return trx.selectFrom("classes").select(["id", "name"]).orderBy("name").execute();
}

export async function listStudents(trx: Trx) {
  return trx
    .selectFrom("students")
    .innerJoin("classes", "classes.id", "students.classId")
    .select(["students.id", "students.externalCode", "students.firstName", "classes.name as className"])
    .where("students.active", "=", true)
    .orderBy("students.firstName")
    .execute();
}

export async function listGuardianLinks(trx: Trx) {
  return trx
    .selectFrom("guardianStudents")
    .innerJoin("guardians", "guardians.id", "guardianStudents.guardianId")
    .select([
      "guardianStudents.studentId",
      "guardians.id",
      "guardians.firstName",
      "guardians.phoneE164 as phone",
    ])
    .orderBy("guardians.firstName")
    .execute();
}
```

`apps/api/src/modules/registry/service.ts`:
```ts
import type { ClassListResponse, ImportStudentsResponse, StudentListResponse } from "@app-lanche/contracts";
import { withTenant } from "../../db/index";
import { audit } from "../../platform/audit";
import type { SessionClaims } from "../../platform/session";
import { parseStudentsCsv } from "./csv";
import * as repo from "./repo";

export async function importStudents(session: SessionClaims, csv: string): Promise<ImportStudentsResponse> {
  const { rows, errors } = parseStudentsCsv(csv);
  if (errors.length > 0) return { applied: false, errors, classes: 0, students: 0, guardians: 0 };
  const schoolId = session.schoolId;

  return withTenant(schoolId, async (trx) => {
    const classIds = new Map<string, string>();
    const studentIds = new Map<string, string>();
    const guardianIds = new Map<string, string>();

    for (const row of rows) {
      if (!classIds.has(row.className)) {
        classIds.set(row.className, await repo.upsertClass(trx, schoolId, row.className));
      }
      if (!studentIds.has(row.externalCode)) {
        studentIds.set(
          row.externalCode,
          await repo.upsertStudent(trx, {
            schoolId,
            externalCode: row.externalCode,
            firstName: row.firstName,
            classId: classIds.get(row.className)!,
          }),
        );
      }
      if (!guardianIds.has(row.guardianPhone)) {
        guardianIds.set(
          row.guardianPhone,
          await repo.upsertGuardian(trx, {
            schoolId,
            phoneE164: row.guardianPhone,
            firstName: row.guardianFirstName,
          }),
        );
      }
      await repo.linkGuardianStudent(trx, {
        schoolId,
        guardianId: guardianIds.get(row.guardianPhone)!,
        studentId: studentIds.get(row.externalCode)!,
      });
    }

    const totals = { classes: classIds.size, students: studentIds.size, guardians: guardianIds.size };
    await audit(trx, {
      schoolId,
      actorKind: "staff",
      actorId: session.sub,
      action: "students.import",
      detail: totals,
    });
    return { applied: true, errors: [], ...totals };
  });
}

export async function listClasses(session: SessionClaims): Promise<ClassListResponse> {
  return { classes: await withTenant(session.schoolId, (trx) => repo.listClasses(trx)) };
}

export async function listStudents(session: SessionClaims): Promise<StudentListResponse> {
  return withTenant(session.schoolId, async (trx) => {
    const students = await repo.listStudents(trx);
    const links = await repo.listGuardianLinks(trx);
    return {
      students: students.map((s) => ({
        ...s,
        guardians: links
          .filter((l) => l.studentId === s.id)
          .map((l) => ({ id: l.id, firstName: l.firstName, phone: l.phone })),
      })),
    };
  });
}
```

`apps/api/src/modules/registry/routes.ts`:
```ts
import { ImportStudentsRequest } from "@app-lanche/contracts";
import type { FastifyInstance } from "fastify";
import type { RouteAuth } from "../../app";
import * as service from "./service";

const OFFICE: RouteAuth = { kind: "staff", roles: ["admin", "secretaria"] };

export async function registryRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/admin/v1/import/students", { config: { auth: OFFICE } }, async (req) =>
    service.importStudents(req.session!, ImportStudentsRequest.parse(req.body).csv),
  );

  app.get("/api/admin/v1/classes", { config: { auth: OFFICE } }, async (req) =>
    service.listClasses(req.session!),
  );

  app.get("/api/admin/v1/students", { config: { auth: OFFICE } }, async (req) =>
    service.listStudents(req.session!),
  );
}
```

Em `apps/api/src/app.ts`, importe e registre junto de `authRoutes`:
```ts
import { registryRoutes } from "./modules/registry/routes";
```
```ts
  app.register(registryRoutes);
```

- [ ] **Step 8: Rodar e ver passar**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: todos PASS.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(registry): add CSV import and class/student listings"
```

---

### Task 7: Web — entrada do responsável

**Files:**
- Create: `apps/web/src/ui/messages.ts`
- Create: `apps/web/src/areas/guardian/device.ts`, `LinkLanding.tsx`, `OrderHome.tsx`
- Modify: `apps/web/src/app/App.tsx`
- Test: `apps/web/src/areas/guardian/LinkLanding.test.tsx`

**Interfaces:**
- Consumes: `apiFetch`, `ApiError`, contratos `ExchangeResponse`, `OtpVerifyResponse`, `MeResponse`.
- Produces: `errorMessage(code: string): string`; `getDeviceSecret(): string`; componentes `LinkLanding` (rota `/l`) e `OrderHome` (rota `/pedido`); rota `/documentos` aponta para `OrderHome` até a fase F5.
- Comportamento de `/l`: lê o token do fragmento, apaga o fragmento da barra de endereço, troca o token; `ok` navega para `/pedido` (escopo `order`) ou `/documentos` (escopo `documents`); `step_up_required` mostra o formulário de código.

- [ ] **Step 1: Escrever o teste que falha**

`apps/web/src/areas/guardian/LinkLanding.test.tsx`:
```tsx
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LinkLanding } from "./LinkLanding";

type Reply = { status: number; body: unknown };

function mockApi(replies: Record<string, Reply>) {
  const fn = vi.fn(async (url: string) => {
    const reply = replies[url];
    if (!reply) throw new Error(`unexpected request to ${url}`);
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function renderAt(hash: string) {
  window.history.replaceState(null, "", `/l${hash}`);
  render(
    <MemoryRouter initialEntries={["/l"]}>
      <Routes>
        <Route path="/l" element={<LinkLanding />} />
        <Route path="/pedido" element={<p>tela de pedido</p>} />
        <Route path="/documentos" element={<p>tela de documentos</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("LinkLanding", () => {
  it("exchanges the token, clears the fragment and goes to the order screen", async () => {
    const fetchMock = mockApi({ "/api/v1/auth/exchange": { status: 200, body: { status: "ok", scope: "order" } } });
    renderAt("#tok-123456789012345678901234567890");
    await screen.findByText("tela de pedido");
    expect(window.location.hash).toBe("");
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.token).toBe("tok-123456789012345678901234567890");
    expect(body.deviceSecret.length).toBeGreaterThanOrEqual(43);
    expect(localStorage.getItem("deviceSecret")).toBe(body.deviceSecret);
  });

  it("goes to documents when the link has that scope", async () => {
    mockApi({ "/api/v1/auth/exchange": { status: 200, body: { status: "ok", scope: "documents" } } });
    renderAt("#tok-123456789012345678901234567890");
    await screen.findByText("tela de documentos");
  });

  it("asks for the code on a new device and continues after verifying", async () => {
    const fetchMock = mockApi({
      "/api/v1/auth/exchange": { status: 200, body: { status: "step_up_required", otpToken: "otp-token" } },
      "/api/v1/auth/otp/verify": { status: 200, body: { status: "ok", scope: "order" } },
    });
    renderAt("#tok-123456789012345678901234567890");
    const input = await screen.findByLabelText("Código de 6 dígitos");
    fireEvent.change(input, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    await screen.findByText("tela de pedido");
    const verifyCall = fetchMock.mock.calls.find((c) => c[0] === "/api/v1/auth/otp/verify")!;
    expect(JSON.parse((verifyCall[1] as RequestInit).body as string)).toEqual({ otpToken: "otp-token", code: "123456" });
  });

  it("shows the wrong-code message and lets the user retry", async () => {
    mockApi({
      "/api/v1/auth/exchange": { status: 200, body: { status: "step_up_required", otpToken: "otp-token" } },
      "/api/v1/auth/otp/verify": { status: 401, body: { error: { code: "otp_invalid", message: "x" } } },
    });
    renderAt("#tok-123456789012345678901234567890");
    fireEvent.change(await screen.findByLabelText("Código de 6 dígitos"), { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    await screen.findByText("Código incorreto. Confira e tente de novo.");
    expect(screen.getByLabelText("Código de 6 dígitos")).toBeTruthy();
  });

  it("explains an expired link", async () => {
    mockApi({ "/api/v1/auth/exchange": { status: 401, body: { error: { code: "invalid_token", message: "x" } } } });
    renderAt("#tok-123456789012345678901234567890");
    await screen.findByText("Este link expirou. Peça um novo pelo WhatsApp da escola.");
  });

  it("explains a missing token without calling the API", async () => {
    const fetchMock = mockApi({});
    renderAt("");
    await screen.findByText("Este link expirou. Peça um novo pelo WhatsApp da escola.");
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm --filter @app-lanche/web test`
Expected: FAIL — `./LinkLanding` não existe.

- [ ] **Step 3: Implementar**

`apps/web/src/ui/messages.ts`:
```ts
const MESSAGES: Record<string, string> = {
  invalid_token: "Este link expirou. Peça um novo pelo WhatsApp da escola.",
  otp_invalid: "Código incorreto. Confira e tente de novo.",
  otp_expired: "Este código expirou. Abra o link novamente para receber outro.",
  otp_too_many_attempts: "Muitas tentativas. Abra o link novamente para receber outro código.",
  unauthenticated: "Sua sessão expirou. Abra o link novamente.",
  insufficient_scope: "Você não tem acesso a esta área.",
  network_error: "Sem conexão. Verifique a internet e tente de novo.",
};

export function errorMessage(code: string): string {
  return MESSAGES[code] ?? "Algo deu errado. Tente de novo em instantes.";
}
```

`apps/web/src/areas/guardian/device.ts`:
```ts
const KEY = "deviceSecret";

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Identificador do aparelho. Não é cookie porque o Firebase Hosting só repassa `__session`. */
export function getDeviceSecret(): string {
  try {
    const existing = localStorage.getItem(KEY);
    if (existing) return existing;
    const created = randomSecret();
    localStorage.setItem(KEY, created);
    return created;
  } catch {
    // Armazenamento bloqueado (aba anônima): o aparelho será tratado como novo a cada acesso.
    return randomSecret();
  }
}
```

`apps/web/src/areas/guardian/LinkLanding.tsx`:
```tsx
import { ExchangeResponse, OtpVerifyResponse, type GuardianScope } from "@app-lanche/contracts";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { ApiError, apiFetch } from "../../app/api";
import { errorMessage } from "../../ui/messages";
import { getDeviceSecret } from "./device";

type State =
  | { step: "loading" }
  | { step: "otp"; otpToken: string; error?: string; busy: boolean }
  | { step: "error"; message: string };

const DESTINATION: Record<GuardianScope, string> = { order: "/pedido", documents: "/documentos" };

function codeOf(err: unknown): string {
  return err instanceof ApiError ? err.code : "internal_error";
}

export function LinkLanding() {
  const navigate = useNavigate();
  const started = useRef(false);
  const [state, setState] = useState<State>({ step: "loading" });
  const [code, setCode] = useState("");

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = window.location.hash.slice(1);
    window.history.replaceState(null, "", window.location.pathname);
    if (!token) {
      setState({ step: "error", message: errorMessage("invalid_token") });
      return;
    }
    apiFetch("/api/v1/auth/exchange", ExchangeResponse, {
      method: "POST",
      body: { token, deviceSecret: getDeviceSecret() },
    }).then(
      (res) => {
        if (res.status === "ok") navigate(DESTINATION[res.scope], { replace: true });
        else setState({ step: "otp", otpToken: res.otpToken, busy: false });
      },
      (err) => setState({ step: "error", message: errorMessage(codeOf(err)) }),
    );
  }, [navigate]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (state.step !== "otp") return;
    setState({ ...state, busy: true, error: undefined });
    try {
      const res = await apiFetch("/api/v1/auth/otp/verify", OtpVerifyResponse, {
        method: "POST",
        body: { otpToken: state.otpToken, code },
      });
      navigate(DESTINATION[res.scope], { replace: true });
    } catch (err) {
      const errorCode = codeOf(err);
      if (errorCode === "otp_invalid" || errorCode === "network_error") {
        setState({ ...state, busy: false, error: errorMessage(errorCode) });
      } else {
        setState({ step: "error", message: errorMessage(errorCode) });
      }
    }
  }

  if (state.step === "loading") return <main><p>Abrindo…</p></main>;
  if (state.step === "error") return <main><p role="alert">{state.message}</p></main>;

  return (
    <main>
      <h1>Confirme que é você</h1>
      <p>Enviamos um código para o seu WhatsApp, porque este aparelho ainda não foi usado.</p>
      <form onSubmit={submit}>
        <label htmlFor="otp">Código de 6 dígitos</label>
        <input
          id="otp"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
          required
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        {state.error && <p role="alert">{state.error}</p>}
        <button type="submit" disabled={state.busy}>Confirmar</button>
      </form>
    </main>
  );
}
```

`apps/web/src/areas/guardian/OrderHome.tsx`:
```tsx
import { MeResponse } from "@app-lanche/contracts";
import { useEffect, useState } from "react";
import { ApiError, apiFetch } from "../../app/api";
import { errorMessage } from "../../ui/messages";

export function OrderHome() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch("/api/v1/me", MeResponse).then(setMe, (err) =>
      setError(errorMessage(err instanceof ApiError ? err.code : "internal_error")),
    );
  }, []);

  if (error) return <main><p role="alert">{error}</p></main>;
  if (!me) return <main><p>Carregando…</p></main>;

  return (
    <main>
      <h1>Olá, {me.guardian.firstName}</h1>
      <ul>
        {me.students.map((s) => (
          <li key={s.id}>{s.firstName} — {s.className}</li>
        ))}
      </ul>
    </main>
  );
}
```

Em `apps/web/src/app/App.tsx`, importe os dois componentes e acrescente as rotas antes da rota `*`:
```tsx
import { LinkLanding } from "../areas/guardian/LinkLanding";
import { OrderHome } from "../areas/guardian/OrderHome";
```
```tsx
      <Route path="/l" element={<LinkLanding />} />
      <Route path="/pedido" element={<OrderHome />} />
      <Route path="/documentos" element={<OrderHome />} />
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm --filter @app-lanche/web test && pnpm typecheck && pnpm lint`
Expected: 6 testes novos PASS, mais os 4 de `api.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web): add guardian link landing with OTP step-up"
```

---

### Task 8: Web — login da equipe e importação

**Files:**
- Create: `apps/web/src/areas/admin/AdminLogin.tsx`, `apps/web/src/areas/admin/AdminHome.tsx`
- Modify: `apps/web/src/app/App.tsx`
- Test: `apps/web/src/areas/admin/admin.test.tsx`

**Interfaces:**
- Consumes: `apiFetch`, `ApiError`, `errorMessage`, contratos `StaffOtpRequestResponse`, `StaffOtpVerifyResponse`, `StaffMeResponse`, `ImportStudentsResponse`.
- Produces: `AdminLogin` (rota `/admin/login`), `AdminHome` (rota `/admin`). `AdminHome` redireciona para `/admin/login` quando `/api/admin/v1/me` responde 401 ou 403.

- [ ] **Step 1: Escrever o teste que falha**

`apps/web/src/areas/admin/admin.test.tsx`:
```tsx
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminHome } from "./AdminHome";
import { AdminLogin } from "./AdminLogin";

type Reply = { status: number; body: unknown };

function mockApi(replies: Record<string, Reply>) {
  const fn = vi.fn(async (url: string) => {
    const reply = replies[url];
    if (!reply) throw new Error(`unexpected request to ${url}`);
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin/login" element={<AdminLogin />} />
        <Route path="/admin" element={<AdminHome />} />
      </Routes>
    </MemoryRouter>,
  );
}

const ME = {
  status: 200,
  body: { id: "0193a000-0000-7000-8000-000000000001", email: "ana@escola.test", role: "secretaria", schoolName: "Escola Sol" },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("admin area", () => {
  it("logs in with e-mail and code, then shows the school", async () => {
    mockApi({
      "/api/admin/v1/auth/otp/request": { status: 200, body: { otpToken: "otp-token" } },
      "/api/admin/v1/auth/otp/verify": { status: 200, body: { status: "ok", role: "secretaria" } },
      "/api/admin/v1/me": ME,
    });
    renderAt("/admin/login");
    fireEvent.change(screen.getByLabelText("E-mail"), { target: { value: "ana@escola.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar código" }));
    fireEvent.change(await screen.findByLabelText("Código de 6 dígitos"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Entrar" }));
    await screen.findByText("Escola Sol");
  });

  it("shows the wrong-code message", async () => {
    mockApi({
      "/api/admin/v1/auth/otp/request": { status: 200, body: { otpToken: "otp-token" } },
      "/api/admin/v1/auth/otp/verify": { status: 401, body: { error: { code: "otp_invalid", message: "x" } } },
    });
    renderAt("/admin/login");
    fireEvent.change(screen.getByLabelText("E-mail"), { target: { value: "ana@escola.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar código" }));
    fireEvent.change(await screen.findByLabelText("Código de 6 dígitos"), { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Entrar" }));
    await screen.findByText("Código incorreto. Confira e tente de novo.");
  });

  it("sends anonymous visitors to the login", async () => {
    mockApi({ "/api/admin/v1/me": { status: 401, body: { error: { code: "unauthenticated", message: "x" } } } });
    renderAt("/admin");
    await screen.findByLabelText("E-mail");
  });

  it("imports a CSV and shows the totals", async () => {
    const fetchMock = mockApi({
      "/api/admin/v1/me": ME,
      "/api/admin/v1/import/students": {
        status: 200,
        body: { applied: true, errors: [], classes: 2, students: 30, guardians: 41 },
      },
    });
    renderAt("/admin");
    fireEvent.change(await screen.findByLabelText("Conteúdo do CSV"), { target: { value: "a,b\n1,2" } });
    fireEvent.click(screen.getByRole("button", { name: "Importar" }));
    await screen.findByText("Importação concluída: 2 turmas, 30 alunos, 41 responsáveis.");
    const call = fetchMock.mock.calls.find((c) => c[0] === "/api/admin/v1/import/students")!;
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({ csv: "a,b\n1,2" });
  });

  it("lists the line errors when the import is refused", async () => {
    mockApi({
      "/api/admin/v1/me": ME,
      "/api/admin/v1/import/students": {
        status: 200,
        body: { applied: false, errors: [{ line: 5, message: "telefone inválido" }], classes: 0, students: 0, guardians: 0 },
      },
    });
    renderAt("/admin");
    fireEvent.change(await screen.findByLabelText("Conteúdo do CSV"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Importar" }));
    await screen.findByText("Nada foi importado. Corrija as linhas abaixo e envie de novo.");
    await screen.findByText("Linha 5: telefone inválido");
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm --filter @app-lanche/web test`
Expected: FAIL — módulos não existem.

- [ ] **Step 3: Implementar**

`apps/web/src/areas/admin/AdminLogin.tsx`:
```tsx
import { StaffOtpRequestResponse, StaffOtpVerifyResponse } from "@app-lanche/contracts";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { ApiError, apiFetch } from "../../app/api";
import { errorMessage } from "../../ui/messages";

export function AdminLogin() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [otpToken, setOtpToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err instanceof ApiError ? err.code : "internal_error"));
    } finally {
      setBusy(false);
    }
  }

  function requestCode(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const res = await apiFetch("/api/admin/v1/auth/otp/request", StaffOtpRequestResponse, {
        method: "POST",
        body: { email },
      });
      setOtpToken(res.otpToken);
    });
  }

  function verify(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      await apiFetch("/api/admin/v1/auth/otp/verify", StaffOtpVerifyResponse, {
        method: "POST",
        body: { otpToken, code },
      });
      navigate("/admin", { replace: true });
    });
  }

  if (otpToken === null) {
    return (
      <main>
        <h1>Área da escola</h1>
        <form onSubmit={requestCode}>
          <label htmlFor="email">E-mail</label>
          <input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          {error && <p role="alert">{error}</p>}
          <button type="submit" disabled={busy}>Enviar código</button>
        </form>
      </main>
    );
  }

  return (
    <main>
      <h1>Área da escola</h1>
      <p>Se o e-mail estiver cadastrado, você receberá um código em instantes.</p>
      <form onSubmit={verify}>
        <label htmlFor="code">Código de 6 dígitos</label>
        <input
          id="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
          required
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={busy}>Entrar</button>
      </form>
    </main>
  );
}
```

`apps/web/src/areas/admin/AdminHome.tsx`:
```tsx
import { ImportStudentsResponse, StaffMeResponse } from "@app-lanche/contracts";
import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { ApiError, apiFetch } from "../../app/api";
import { errorMessage } from "../../ui/messages";

export function AdminHome() {
  const navigate = useNavigate();
  const [me, setMe] = useState<StaffMeResponse | null>(null);
  const [csv, setCsv] = useState("");
  const [result, setResult] = useState<ImportStudentsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiFetch("/api/admin/v1/me", StaffMeResponse).then(setMe, (err) => {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        navigate("/admin/login", { replace: true });
      } else {
        setError(errorMessage(err instanceof ApiError ? err.code : "internal_error"));
      }
    });
  }, [navigate]);

  async function loadFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) setCsv(await file.text());
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(
        await apiFetch("/api/admin/v1/import/students", ImportStudentsResponse, {
          method: "POST",
          body: { csv },
        }),
      );
    } catch (err) {
      setError(errorMessage(err instanceof ApiError ? err.code : "internal_error"));
    } finally {
      setBusy(false);
    }
  }

  if (!me) return <main>{error ? <p role="alert">{error}</p> : <p>Carregando…</p>}</main>;

  return (
    <main>
      <h1>{me.schoolName}</h1>
      <section>
        <h2>Importar alunos e responsáveis</h2>
        <p>
          Colunas: <code>codigo_aluno, primeiro_nome, turma, responsavel_nome, responsavel_telefone</code>.
          Um aluno com dois responsáveis ocupa duas linhas.
        </p>
        <form onSubmit={submit}>
          <label htmlFor="file">Arquivo CSV</label>
          <input id="file" type="file" accept=".csv,text/csv" onChange={loadFile} />
          <label htmlFor="csv">Conteúdo do CSV</label>
          <textarea id="csv" rows={8} required value={csv} onChange={(e) => setCsv(e.target.value)} />
          <button type="submit" disabled={busy}>Importar</button>
        </form>
        {error && <p role="alert">{error}</p>}
        {result?.applied && (
          <p role="status">
            Importação concluída: {result.classes} turmas, {result.students} alunos, {result.guardians} responsáveis.
          </p>
        )}
        {result && !result.applied && (
          <div role="alert">
            <p>Nada foi importado. Corrija as linhas abaixo e envie de novo.</p>
            <ul>
              {result.errors.map((e) => (
                <li key={`${e.line}-${e.message}`}>Linha {e.line}: {e.message}</li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </main>
  );
}
```

Em `apps/web/src/app/App.tsx`, importe os dois componentes e acrescente as rotas antes da rota `*`:
```tsx
import { AdminHome } from "../areas/admin/AdminHome";
import { AdminLogin } from "../areas/admin/AdminLogin";
```
```tsx
      <Route path="/admin/login" element={<AdminLogin />} />
      <Route path="/admin" element={<AdminHome />} />
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: todos PASS.

- [ ] **Step 5: Verificação manual de ponta a ponta**

Com `pnpm db:up` e as migrações aplicadas, em um terminal:
```bash
DATABASE_URL=postgres://app_user:app_user@localhost:5432/app_lanche \
INTERNAL_SERVICE_TOKEN=dev-service-token-with-at-least-32-chars \
INTERNAL_HMAC_SECRET=dev-hmac-secret-with-at-least-32-chars \
SESSION_SECRET=dev-session-secret-with-at-least-32-chars \
APP_BASE_URL=http://localhost:5173 pnpm dev
```
1. Abra `http://localhost:5173/admin/login` e informe o e-mail usado no `cli:create-school`.
2. Leia o código no banco (o envio real é da fase F3):
   ```bash
   docker compose exec db psql -U postgres app_lanche -c \
     "SELECT data->>'code' FROM outbox_events WHERE type = 'auth.otp_requested' ORDER BY occurred_at DESC LIMIT 1"
   ```
3. Entre, cole um CSV com as cinco colunas e importe.

Expected: a tela mostra "Importação concluída: …" com as contagens do arquivo.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(web): add staff login and CSV import screen"
```

---

## Resultado da fase

- Responsável: link → sessão; aparelho novo → OTP; `/pedido` lista os filhos.
- Equipe: e-mail + OTP → `/admin`; importação CSV idempotente e auditada.
- Isolamento entre escolas coberto por teste em todas as tabelas novas.
- O envio real de OTP e de links por WhatsApp/e-mail depende do dispatcher da outbox e dos fluxos n8n (fase F3). Até lá, o código é lido da tabela `outbox_events` em desenvolvimento.
- Edição individual de aluno, responsável e turma pela tela de admin não faz parte desta fase; a correção é feita reimportando o CSV.
