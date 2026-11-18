import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { getDb, type Trx } from "../../db/index";

export async function manifestLines(trx: Trx, serviceDayId: string) {
  return trx
    .selectFrom("orders")
    .innerJoin("checkouts", "checkouts.id", "orders.checkoutId")
    .innerJoin("students", "students.id", "orders.studentId")
    .innerJoin("classes", "classes.id", "students.classId")
    .innerJoin("orderItems", "orderItems.orderId", "orders.id")
    .innerJoin("menuItems", "menuItems.id", "orderItems.menuItemId")
    .select([
      "orders.id as orderId",
      "students.firstName",
      "classes.name as className",
      "orderItems.qty",
      "menuItems.name as itemName",
      // Restrição alimentar é dado de saúde: só com consentimento de um responsável (spec 4.5).
      sql<string | null>`CASE WHEN EXISTS (
        SELECT 1 FROM guardian_students gs
        WHERE gs.student_id = students.id AND gs.restriction_consent_at IS NOT NULL
      ) THEN students.dietary_restrictions END`.as("restrictions"),
    ])
    .where("checkouts.serviceDayId", "=", serviceDayId)
    .where("orders.status", "=", "confirmed")
    .orderBy("classes.name")
    .orderBy("students.firstName")
    .orderBy("orders.id")
    .orderBy("menuItems.name")
    .execute();
}

export async function insertManifest(trx: Trx, row: { schoolId: string; serviceDayId: string; content: string }): Promise<void> {
  await trx.insertInto("manifests").values({ id: uuidv7(), version: 1, ...row }).execute();
}

export async function readManifest(trx: Trx, serviceDayId: string) {
  return trx
    .selectFrom("manifests")
    .select(["version", sql<string>`content::text`.as("content")])
    .where("serviceDayId", "=", serviceDayId)
    .orderBy("version", "desc")
    .executeTakeFirstOrThrow();
}

export async function kitchenPhone(trx: Trx): Promise<string | null> {
  const row = await trx.selectFrom("schools").select("kitchenPhone").executeTakeFirst();
  return row?.kitchenPhone ?? null;
}

/** Agenda de todas as escolas (função SECURITY DEFINER, spec 4.4). */
export async function listDueActions() {
  const { rows } = await sql<{
    action: "send_reminders" | "close_service_day";
    schoolId: string;
    serviceDate: string;
    overdue: boolean;
  }>`SELECT action, school_id, service_date, overdue FROM list_due_actions()`.execute(getDb());
  return rows;
}
