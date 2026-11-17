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
