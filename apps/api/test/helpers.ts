import { CamelCasePlugin, Kysely, PostgresDialect, sql } from "kysely";
import type { InjectOptions } from "fastify";
import pg from "pg";
import { uuidv7 } from "uuidv7";
import type { DB } from "../src/db/types";
import { signInternal } from "../src/platform/hmac";
import { SESSION_COOKIE, signToken, type StaffRole } from "../src/platform/session";

let admin: Kysely<DB> | undefined;

/** Conexão de administrador: ignora RLS. Só para preparar e inspecionar dados em teste. */
export function adminDb(): Kysely<DB> {
  admin ??= new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: process.env.DATABASE_ADMIN_URL, max: 2 }),
    }),
    plugins: [new CamelCasePlugin()],
  });
  return admin;
}

export async function closeAdminDb(): Promise<void> {
  await admin?.destroy();
  admin = undefined;
}

export async function createSchool(name = "Escola Teste"): Promise<string> {
  const id = uuidv7();
  await adminDb().insertInto("schools").values({ id, name }).execute();
  return id;
}

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
  reminderBatchId: string;
  kitchenDeviceId: string;
  deliveryEventId: string;
};

/** Insere uma linha em cada tabela de tenant. Estenda quando criar tabela nova. */
export async function seedTenant(schoolId: string): Promise<SeedIds> {
  const db = adminDb();
  const ids: SeedIds = {
    classId: uuidv7(),
    studentId: uuidv7(),
    guardianId: uuidv7(),
    staffUserId: uuidv7(),
    phone: "+5511999990001",
    email: `admin-${uuidv7()}@escola.test`,
    menuItemId: uuidv7(),
    serviceDayId: uuidv7(),
    serviceDate: "2099-12-31",
    walletId: uuidv7(),
    checkoutId: uuidv7(),
    orderId: uuidv7(),
    paymentId: uuidv7(),
    reminderBatchId: uuidv7(),
    kitchenDeviceId: uuidv7(),
    deliveryEventId: uuidv7(),
  };
  await db.insertInto("classes").values({ id: ids.classId, schoolId, name: "Infantil 3A" }).execute();
  await db
    .insertInto("students")
    .values({ id: ids.studentId, schoolId, classId: ids.classId, externalCode: "A001", firstName: "Léo" })
    .execute();
  await db
    .insertInto("guardians")
    .values({ id: ids.guardianId, schoolId, phoneE164: ids.phone, firstName: "Ana" })
    .execute();
  await db
    .insertInto("guardianStudents")
    .values({ schoolId, guardianId: ids.guardianId, studentId: ids.studentId })
    .execute();
  await db
    .insertInto("staffUsers")
    .values({ id: ids.staffUserId, schoolId, email: ids.email, role: "admin" })
    .execute();
  await db
    .insertInto("auditLog")
    .values({ id: uuidv7(), schoolId, actorKind: "system", action: "seed" })
    .execute();
  await db
    .insertInto("outboxEvents")
    .values({ id: uuidv7(), schoolId, type: "seed", data: JSON.stringify({}) })
    .execute();
  await db
    .insertInto("devices")
    .values({ id: ids.kitchenDeviceId, schoolId, kind: "kitchen" })
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
    .insertInto("deliveryEvents")
    .values({
      eventId: ids.deliveryEventId,
      schoolId,
      orderId: ids.orderId,
      deviceId: ids.kitchenDeviceId,
      type: "delivered",
      occurredAt: new Date(),
    })
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
  await db
    .insertInto("reminderBatches")
    .values({ id: ids.reminderBatchId, schoolId, serviceDate: ids.serviceDate, completedAt: new Date() })
    .execute();
  await db
    .insertInto("messageDeliveries")
    .values({ id: uuidv7(), schoolId, batchId: ids.reminderBatchId, guardianId: ids.guardianId, status: "sent", waMessageId: "wamid.seed" })
    .execute();
  return ids;
}

/** Remove o desafio de semente, para testes que contam desafios do sujeito. */
export async function dropSeedChallenges(schoolId: string): Promise<void> {
  await adminDb().deleteFrom("otpChallenges").where("schoolId", "=", schoolId).where("codeHash", "=", "seed").execute();
}

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

/** Invariante do ledger (spec 13): saldo gravado = soma dos lançamentos. Sem carteira conta como verdadeiro. */
export async function walletLedgerMatches(schoolId: string, guardianId: string): Promise<boolean> {
  const { rows } = await sql<{ balance: number; total: number }>`
    SELECT w.balance_cents AS balance, coalesce(sum(e.amount_cents), 0)::bigint AS total
    FROM wallets w LEFT JOIN wallet_entries e ON e.wallet_id = w.id
    WHERE w.school_id = ${schoolId} AND w.guardian_id = ${guardianId}
    GROUP BY w.balance_cents`.execute(adminDb());
  return rows.length === 0 || rows[0]!.balance === rows[0]!.total;
}

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
