import type { Trx } from "../../db/index";

export async function guardianActiveStudents(trx: Trx, guardianId: string, studentIds: string[]) {
  if (studentIds.length === 0) return [];
  return trx
    .selectFrom("guardianStudents")
    .innerJoin("students", "students.id", "guardianStudents.studentId")
    .select(["students.id", "students.firstName"])
    .where("guardianStudents.guardianId", "=", guardianId)
    .where("students.id", "in", studentIds)
    .where("students.active", "=", true)
    .execute();
}

export async function insertCheckout(
  trx: Trx,
  row: { id: string; schoolId: string; guardianId: string; serviceDayId: string; totalCents: number },
): Promise<void> {
  await trx.insertInto("checkouts").values(row).execute();
}

export async function insertOrder(
  trx: Trx,
  row: { id: string; schoolId: string; checkoutId: string; studentId: string; serviceDate: string },
): Promise<void> {
  await trx.insertInto("orders").values(row).execute();
}

export async function insertOrderItems(
  trx: Trx,
  rows: { id: string; schoolId: string; orderId: string; menuItemId: string; qty: number; unitPriceCents: number }[],
): Promise<void> {
  await trx.insertInto("orderItems").values(rows).execute();
}

export async function setWalletApplied(trx: Trx, checkoutId: string, walletAppliedCents: number): Promise<void> {
  await trx.updateTable("checkouts").set({ walletAppliedCents }).where("id", "=", checkoutId).execute();
}

/** `UPDATE … WHERE status IN (from)`: sem linha devolvida, outro processo já fez a transição. */
export async function transitionCheckout(trx: Trx, checkoutId: string, from: string[], to: string) {
  return trx
    .updateTable("checkouts")
    .set({ status: to })
    .where("id", "=", checkoutId)
    .where("status", "in", from)
    .returning(["guardianId", "totalCents", "walletAppliedCents"])
    .executeTakeFirst();
}

export async function transitionOrders(trx: Trx, checkoutId: string, from: string, to: string): Promise<void> {
  await trx.updateTable("orders").set({ status: to }).where("checkoutId", "=", checkoutId).where("status", "=", from).execute();
}

export async function checkoutHeaders(trx: Trx, checkoutIds: string[]) {
  if (checkoutIds.length === 0) return [];
  return trx
    .selectFrom("checkouts")
    .innerJoin("serviceDays", "serviceDays.id", "checkouts.serviceDayId")
    .select([
      "checkouts.id",
      "checkouts.guardianId",
      "checkouts.serviceDayId",
      "checkouts.status",
      "checkouts.totalCents",
      "checkouts.walletAppliedCents",
      "serviceDays.serviceDate",
      "serviceDays.cutoffAt",
    ])
    .where("checkouts.id", "in", checkoutIds)
    .orderBy("checkouts.id")
    .execute();
}

export async function guardianCheckoutIds(trx: Trx, guardianId: string, serviceDate: string): Promise<string[]> {
  const rows = await trx
    .selectFrom("checkouts")
    .innerJoin("serviceDays", "serviceDays.id", "checkouts.serviceDayId")
    .select("checkouts.id")
    .where("checkouts.guardianId", "=", guardianId)
    .where("serviceDays.serviceDate", "=", serviceDate)
    .orderBy("checkouts.id")
    .execute();
  return rows.map((r) => r.id);
}

export async function orderLines(trx: Trx, checkoutIds: string[]) {
  if (checkoutIds.length === 0) return [];
  return trx
    .selectFrom("orders")
    .innerJoin("students", "students.id", "orders.studentId")
    .innerJoin("orderItems", "orderItems.orderId", "orders.id")
    .innerJoin("menuItems", "menuItems.id", "orderItems.menuItemId")
    .select([
      "orders.id as orderId",
      "orders.checkoutId",
      "orders.studentId",
      "students.firstName",
      "orders.status",
      "orderItems.menuItemId",
      "menuItems.name",
      "orderItems.qty",
      "orderItems.unitPriceCents",
    ])
    .where("orders.checkoutId", "in", checkoutIds)
    .orderBy("orders.id")
    .orderBy("menuItems.name")
    .execute();
}

export async function guardianContact(trx: Trx, guardianId: string) {
  return trx
    .selectFrom("guardians")
    .select(["phoneE164", "firstName"])
    .where("id", "=", guardianId)
    .executeTakeFirstOrThrow();
}

export async function studentFirstNames(trx: Trx, checkoutId: string): Promise<string[]> {
  const rows = await trx
    .selectFrom("orders")
    .innerJoin("students", "students.id", "orders.studentId")
    .select("students.firstName")
    .where("orders.checkoutId", "=", checkoutId)
    .orderBy("orders.id")
    .execute();
  return rows.map((r) => r.firstName);
}
