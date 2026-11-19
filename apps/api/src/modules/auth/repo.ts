import { sql } from "kysely";
import { getDb, type Trx } from "../../db/index";
import type { GuardianScope } from "../../platform/session";

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

/** Grava o link com a validade calculada pelo banco; undefined quando não há dia aberto antes do corte. */
export async function insertMagicLink(
  trx: Trx,
  row: {
    id: string;
    schoolId: string;
    guardianId: string;
    tokenHash: string;
    scope: GuardianScope;
    serviceDate: string | null;
  },
): Promise<Date | undefined> {
  const { rows } = await sql<{ expiresAt: Date }>`
    INSERT INTO magic_links (id, school_id, guardian_id, token_hash, scope, service_date, expires_at)
    SELECT ${row.id}::uuid, ${row.schoolId}::uuid, ${row.guardianId}::uuid, ${row.tokenHash}::text, ${row.scope}::text,
           ${row.serviceDate}::date, e.expires_at
    FROM (
      SELECT CASE
        WHEN ${row.scope}::text IN ('documents', 'wallet') THEN now() + interval '7 days'
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

/** Desafios criados para o sujeito na janela, contados pelo relógio do banco. */
export async function countRecentChallenges(
  trx: Trx,
  subjectKind: "guardian" | "staff",
  subjectId: string,
  windowMinutes: number,
): Promise<number> {
  const row = await trx
    .selectFrom("otpChallenges")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("subjectKind", "=", subjectKind)
    .where("subjectId", "=", subjectId)
    .where(sql<boolean>`${sql.ref("createdAt")} > now() - make_interval(mins => ${windowMinutes})`)
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

export async function lockChallenge(trx: Trx, id: string) {
  return trx
    .selectFrom("otpChallenges")
    .select(["id", "codeHash", "attempts", "consumedAt", "subjectKind", "subjectId"])
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

/** Todos os aparelhos já registrados, inclusive os revogados (que contam como "já teve aparelho"). */
export async function listGuardianDevices(
  trx: Trx,
  guardianId: string,
): Promise<{ secretHash: string; revoked: boolean }[]> {
  const rows = await trx
    .selectFrom("devices")
    .select(["secretHash", "revokedAt"])
    .where("guardianId", "=", guardianId)
    .where("kind", "=", "guardian")
    .execute();
  return rows
    .filter((r): r is typeof r & { secretHash: string } => r.secretHash !== null)
    .map((r) => ({ secretHash: r.secretHash, revoked: r.revokedAt !== null }));
}

/** Registra o aparelho; se ele existia revogado, reativa (só é chamado após OTP ou no primeiro aparelho). */
export async function insertGuardianDevice(
  trx: Trx,
  row: { id: string; schoolId: string; guardianId: string; secretHash: string },
): Promise<void> {
  await trx
    .insertInto("devices")
    .values({ ...row, kind: "guardian" })
    .onConflict((oc) =>
      oc
        .columns(["schoolId", "guardianId", "secretHash"])
        .where("kind", "=", "guardian")
        .doUpdateSet({ revokedAt: null }),
    )
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

export async function getStaffUser(trx: Trx, id: string) {
  return trx
    .selectFrom("staffUsers")
    .innerJoin("schools", "schools.id", "staffUsers.schoolId")
    .select(["staffUsers.id", "staffUsers.email", "staffUsers.role", "schools.name as schoolName"])
    .where("staffUsers.id", "=", id)
    .where("staffUsers.active", "=", true)
    .executeTakeFirst();
}

/** Papel atual de um usuário ativo da equipe; relido a cada requisição de equipe. */
export async function getActiveStaffRole(trx: Trx, id: string) {
  return trx
    .selectFrom("staffUsers")
    .select("role")
    .where("id", "=", id)
    .where("active", "=", true)
    .executeTakeFirst();
}

/** Trava o usuário da equipe para serializar a contagem de desafios emitidos. */
export async function lockStaffUser(trx: Trx, id: string) {
  return trx
    .selectFrom("staffUsers")
    .select(["id", "email"])
    .where("id", "=", id)
    .where("active", "=", true)
    .forUpdate()
    .executeTakeFirst();
}
