import { sql } from "kysely";
import type { Shift } from "@app-lanche/contracts";
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

function shiftQuery(trx: Trx) {
  return trx
    .selectFrom("serviceDayShifts")
    .select([
      "id",
      "serviceDayId",
      "shift",
      "cutoffAt",
      "freezeAt",
      "status",
      "closedAt",
      sql<boolean>`now() <= cutoff_at`.as("beforeCutoff"),
      sql<boolean>`now() >= freeze_at`.as("frozen"),
    ]);
}

export async function lockShift(trx: Trx, serviceDayId: string, shift: Shift, mode: "share" | "update") {
  const q = shiftQuery(trx).where("serviceDayId", "=", serviceDayId).where("shift", "=", shift);
  return (mode === "share" ? q.forShare() : q.forUpdate()).executeTakeFirst();
}

export async function listShifts(trx: Trx, serviceDayIds: string[]) {
  if (serviceDayIds.length === 0) return [];
  return shiftQuery(trx).where("serviceDayId", "in", serviceDayIds).orderBy("serviceDayId").orderBy("shift").execute();
}

/** Turnos com ao menos uma turma com aluno ativo; matutino se nenhum. */
export async function activeShifts(trx: Trx): Promise<Shift[]> {
  const rows = await trx
    .selectFrom("classes")
    .innerJoin("students", "students.classId", "classes.id")
    .select("classes.shift")
    .where("students.active", "=", true)
    .distinct()
    .orderBy("classes.shift")
    .execute();
  return rows.length > 0 ? rows.map((r) => r.shift as Shift) : ["matutino"];
}

/** Corte de cada turno na data, no fuso da escola, pelo banco; `time` null usa o padrão da escola. */
export async function computeCutoffs(trx: Trx, serviceDate: string, cutoffs: { shift: Shift; time: string | null }[]) {
  const { rows } = await sql<{ shift: Shift; cutoffAt: Date; inFuture: boolean }>`
    SELECT c.shift, c.cutoff_at, now() < c.cutoff_at AS in_future
    FROM (
      SELECT x.shift,
        ((${serviceDate}::date + coalesce(x.time, CASE x.shift WHEN 'vespertino' THEN s.cutoff_time_vespertino ELSE s.cutoff_time_matutino END))
          AT TIME ZONE s.timezone) AS cutoff_at
      FROM schools s
      CROSS JOIN unnest(${cutoffs.map((c) => c.shift)}::text[], ${cutoffs.map((c) => c.time)}::time[]) AS x(shift, time)
      WHERE s.id = app_school_id()
    ) c
    ORDER BY c.shift`.execute(trx);
  return rows;
}

/**
 * Cria ou atualiza o dia e seus turnos; o dia espelha o turno mais tarde. Linhas de turno nunca são apagadas, e um
 * turno que já não está aberto (fechado ou finalizado) mantém seus horários.
 */
export async function upsertServiceDay(
  trx: Trx,
  schoolId: string,
  serviceDate: string,
  cutoffs: { shift: Shift; cutoffAt: Date }[],
): Promise<string> {
  const latest = new Date(Math.max(...cutoffs.map((c) => c.cutoffAt.getTime())));
  const { rows } = await sql<{ id: string }>`
    INSERT INTO service_days (id, school_id, service_date, cutoff_at, freeze_at)
    VALUES (${uuidv7()}, ${schoolId}, ${serviceDate}::date, ${latest}, ${latest}::timestamptz + interval '5 minutes')
    ON CONFLICT (school_id, service_date) DO UPDATE SET cutoff_at = EXCLUDED.cutoff_at, freeze_at = EXCLUDED.freeze_at
    RETURNING id`.execute(trx);
  const dayId = rows[0]!.id;
  for (const c of cutoffs) {
    await sql`
      INSERT INTO service_day_shifts AS t (id, school_id, service_day_id, shift, cutoff_at, freeze_at)
      VALUES (${uuidv7()}, ${schoolId}, ${dayId}, ${c.shift}, ${c.cutoffAt}, ${c.cutoffAt}::timestamptz + interval '5 minutes')
      ON CONFLICT (school_id, service_day_id, shift)
        DO UPDATE SET cutoff_at = EXCLUDED.cutoff_at, freeze_at = EXCLUDED.freeze_at
        WHERE t.status = 'open'`.execute(trx);
  }
  await sql`
    UPDATE service_days d SET cutoff_at = m.cutoff_at, freeze_at = m.freeze_at
    FROM (SELECT max(cutoff_at) AS cutoff_at, max(freeze_at) AS freeze_at FROM service_day_shifts WHERE service_day_id = ${dayId}) m
    WHERE d.id = ${dayId}`.execute(trx);
  return dayId;
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
  await trx
    .updateTable("serviceDayShifts")
    .set({ status: "closed", closedAt: sql<Date>`now()` })
    .where("serviceDayId", "=", serviceDayId)
    .where("status", "=", "open")
    .execute();
  const row = await trx
    .updateTable("serviceDays")
    .set({ status: "closed", closedAt: sql<Date>`now()` })
    .where("id", "=", serviceDayId)
    .where("status", "=", "open")
    .returning("closedAt")
    .executeTakeFirst();
  return row?.closedAt ?? null;
}
