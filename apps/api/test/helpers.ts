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
  return ids;
}
