import { CamelCasePlugin, Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { uuidv7 } from "uuidv7";
import type { DB } from "../src/db/types";

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
  return ids;
}

/** Remove o desafio de semente, para testes que contam desafios do sujeito. */
export async function dropSeedChallenges(schoolId: string): Promise<void> {
  await adminDb().deleteFrom("otpChallenges").where("schoolId", "=", schoolId).where("codeHash", "=", "seed").execute();
}
