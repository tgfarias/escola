import { CamelCasePlugin, Kysely, PostgresDialect, sql } from "kysely";
import type { Shift } from "@app-lanche/contracts";
import type { InjectOptions } from "fastify";
import pg from "pg";
import { uuidv7 } from "uuidv7";
import type { DB } from "../src/db/types";
import { signInternal } from "../src/platform/hmac";
import { SESSION_COOKIE, signToken, type GuardianScope, type StaffRole } from "../src/platform/session";

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
  documentTemplateId: string;
  documentBatchId: string;
  documentId: string;
  counterSaleId: string;
  topupId: string;
  serviceDayShiftId: string;
  shiftEventId: string;
  uncollectedDecisionId: string;
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
    documentTemplateId: uuidv7(),
    documentBatchId: uuidv7(),
    documentId: uuidv7(),
    counterSaleId: uuidv7(),
    topupId: uuidv7(),
    serviceDayShiftId: uuidv7(),
    shiftEventId: uuidv7(),
    uncollectedDecisionId: uuidv7(),
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
    .values({ schoolId, guardianId: ids.guardianId, studentId: ids.studentId, financial: true })
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
    .insertInto("serviceDayShifts")
    .values({ id: ids.serviceDayShiftId, schoolId, serviceDayId: ids.serviceDayId, shift: "matutino", cutoffAt, freezeAt: new Date(cutoffAt.getTime() + 300_000) })
    .execute();
  await db
    .insertInto("serviceDayItems")
    .values({ schoolId, serviceDayId: ids.serviceDayId, menuItemId: ids.menuItemId, priceCents: 900 })
    .execute();
  await db.insertInto("wallets").values({ id: ids.walletId, schoolId, guardianId: ids.guardianId, balanceCents: 50 }).execute();
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
  // F5B: lançamento de balcão (com a entrada do ledger que ele aponta) e uma recarga terminal.
  const counterEntryId = uuidv7();
  await db
    .insertInto("walletEntries")
    .values({ id: counterEntryId, schoolId, walletId: ids.walletId, kind: "counter_charge", amountCents: -50, sourceType: "counter_sale", sourceId: ids.counterSaleId })
    .execute();
  await db
    .insertInto("counterSales")
    .values({
      id: ids.counterSaleId,
      schoolId,
      studentId: ids.studentId,
      guardianId: ids.guardianId,
      source: "kitchen",
      deviceId: ids.kitchenDeviceId,
      occurredAt: new Date(),
      totalCents: 50,
      overLimit: false,
      walletEntryId: counterEntryId,
    })
    .execute();
  await db
    .insertInto("counterSaleItems")
    .values({ schoolId, saleId: ids.counterSaleId, menuItemId: ids.menuItemId, qty: 1, unitPriceCents: 50 })
    .execute();
  await db
    .insertInto("topups")
    .values({ id: ids.topupId, schoolId, guardianId: ids.guardianId, amountCents: 2000, status: "expired", requestedBy: "guardian" })
    .execute();
  await db
    .insertInto("checkouts")
    .values({
      id: ids.checkoutId,
      schoolId,
      guardianId: ids.guardianId,
      serviceDayId: ids.serviceDayId,
      shift: "matutino",
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
    .values({ id: uuidv7(), schoolId, serviceDayId: ids.serviceDayId, shift: "matutino", content: JSON.stringify({}) })
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
  await db
    .insertInto("documentTemplates")
    .values({ id: ids.documentTemplateId, schoolId, templateGroupId: ids.documentTemplateId, version: 1, name: "Semente", category: "outro", bodyMd: "# Semente", fields: JSON.stringify([]), createdBy: ids.staffUserId })
    .execute();
  await db
    .insertInto("documentBatches")
    .values({ id: ids.documentBatchId, schoolId, templateId: ids.documentTemplateId, fieldValues: JSON.stringify({}), issuedOn: "2099-12-31", perGuardian: false, createdBy: ids.staffUserId, status: "published", publishedAt: new Date() })
    .execute();
  await db
    .insertInto("documents")
    .values({
      id: ids.documentId,
      schoolId,
      batchId: ids.documentBatchId,
      studentId: ids.studentId,
      status: "rendered",
      storagePath: `schools/${schoolId}/documents/${ids.documentBatchId}/${ids.documentId}.pdf`,
      sha256: "0".repeat(64),
      renderedAt: new Date(),
    })
    .execute();
  await db.insertInto("documentViews").values({ id: uuidv7(), schoolId, documentId: ids.documentId, guardianId: ids.guardianId }).execute();
  // F5C Parte B: evento de turno finalizado e decisão de não retirado.
  await db
    .insertInto("shiftEvents")
    .values({ eventId: ids.shiftEventId, schoolId, serviceDayShiftId: ids.serviceDayShiftId, deviceId: ids.kitchenDeviceId, type: "shift_finished", occurredAt: new Date() })
    .execute();
  await db
    .insertInto("uncollectedDecisions")
    .values({ id: ids.uncollectedDecisionId, schoolId, orderId: ids.orderId, decision: "kept", staffUserId: ids.staffUserId })
    .execute();
  return ids;
}

/** Remove o desafio de semente, para testes que contam desafios do sujeito. */
export async function dropSeedChallenges(schoolId: string): Promise<void> {
  await adminDb().deleteFrom("otpChallenges").where("schoolId", "=", schoolId).where("codeHash", "=", "seed").execute();
}

export async function guardianCookie(schoolId: string, guardianId: string, scope: GuardianScope = "order"): Promise<Record<string, string>> {
  const token = await signToken("session", { kind: "guardian", sub: guardianId, schoolId, scope }, 3600);
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

/** Cookie de tablet pareado; cria o dispositivo pareado se não for informado. */
export async function kitchenCookie(schoolId: string, deviceId?: string): Promise<{ cookies: Record<string, string>; deviceId: string }> {
  const id = deviceId ?? uuidv7();
  if (!deviceId) {
    await adminDb().insertInto("devices").values({ id, schoolId, kind: "kitchen" }).execute();
  }
  const token = await signToken("session", { kind: "kitchen", sub: id, schoolId }, 3600);
  return { cookies: { [SESSION_COOKIE]: token }, deviceId: id };
}

let phoneSeq = 0;

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
    await db.insertInto("guardianStudents").values({ schoolId, guardianId, studentId: id, financial: true }).execute();
    studentIds.push(id);
  }
  return { guardianId, studentIds };
}

/** Responsável com Léo na turma da manhã ("Infantil 3A") e Bia na da tarde ("Infantil 5C"). */
export async function seedTwoShiftFamily(schoolId: string): Promise<{ guardianId: string; leo: string; bia: string }> {
  const fam = await seedFamily(schoolId, ["Léo"], { className: "Infantil 3A", shift: "matutino" });
  const other = await seedFamily(schoolId, ["Bia"], { className: "Infantil 5C", shift: "vespertino" });
  await adminDb().insertInto("guardianStudents").values({ schoolId, guardianId: fam.guardianId, studentId: other.studentIds[0]!, financial: false }).execute();
  return { guardianId: fam.guardianId, leo: fam.studentIds[0]!, bia: other.studentIds[0]! };
}

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
  // O dia espelha o turno mais tarde exatamente (cada INSERT acima tem o seu now()).
  await sql`
    UPDATE service_days d SET cutoff_at = m.cutoff_at, freeze_at = m.freeze_at
    FROM (SELECT max(cutoff_at) AS cutoff_at, max(freeze_at) AS freeze_at FROM service_day_shifts WHERE service_day_id = ${serviceDayId}) m
    WHERE d.id = ${serviceDayId}`.execute(db);
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
  return { serviceDayId, serviceDate, items, shiftIds };
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

/**
 * Fuso `Etc/GMT±N` em que agora são `hour` horas (janela 09:00–19:00 dos avisos de débito). Nos nomes Etc/GMT o sinal
 * é invertido: Etc/GMT-3 é UTC+3.
 */
export function zoneAtLocalHour(hour: number): string {
  const diff = (((hour - new Date().getUTCHours()) % 24) + 24) % 24;
  const offset = diff >= 12 ? diff - 24 : diff; // -12..11
  if (offset === 0) return "Etc/GMT";
  return offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
}
