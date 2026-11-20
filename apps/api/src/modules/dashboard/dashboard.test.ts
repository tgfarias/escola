import { sql } from "kysely";
import { uuidv7 } from "uuidv7";
import { describe, expect, it } from "vitest";
import { adminDb, createSchool, kitchenCookie, seedClosedDayWithOrders, seedFamily, seedTenant, staffCookie } from "../../../test/helpers";
import { buildApp } from "../../app";
import { withTenant } from "../../db/index";
import { applySales } from "../counter/service";

/** Data local da escola deslocada em dias (texto YYYY-MM-DD). */
async function localDate(schoolId: string, offsetDays: number): Promise<string> {
  const { rows } = await sql<{ d: string }>`
    SELECT ((now() AT TIME ZONE timezone)::date + ${offsetDays}::int)::text AS d FROM schools WHERE id = ${schoolId}`.execute(adminDb());
  return rows[0]!.d;
}

async function firstOfMonth(schoolId: string, monthsBack: number): Promise<string> {
  const { rows } = await sql<{ d: string }>`
    SELECT (date_trunc('month', (now() AT TIME ZONE timezone)::date) - make_interval(months => ${monthsBack}))::date::text AS d
    FROM schools WHERE id = ${schoolId}`.execute(adminDb());
  return rows[0]!.d;
}

async function payCheckoutOf(schoolId: string, orderId: string, amountCents: number): Promise<void> {
  const { checkoutId } = await adminDb().selectFrom("orders").select("checkoutId").where("id", "=", orderId).executeTakeFirstOrThrow();
  await adminDb()
    .insertInto("payments")
    .values({ id: uuidv7(), schoolId, checkoutId, provider: "fake", method: "pix", amountCents, status: "paid", paidAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000) })
    .execute();
}

async function sell(schoolId: string, studentId: string, menuItemId: string, qty: number): Promise<string> {
  const { deviceId } = await kitchenCookie(schoolId);
  const id = uuidv7();
  await withTenant(schoolId, (trx) =>
    applySales(trx, schoolId, { source: "kitchen", deviceId }, [{ id, studentId, items: [{ menuItemId, qty }], occurredAt: null }], "record"),
  );
  return id;
}

const get = (cookies: Record<string, string>, period?: string) =>
  buildApp().inject({ method: "GET", url: `/api/admin/v1/dashboard${period ? `?period=${period}` : ""}`, cookies });

describe("admin dashboard", () => {
  it("counts today's orders, counter sales, top items and money for the office", async () => {
    const schoolId = await createSchool();
    const today = await localDate(schoolId, 0);
    const day = await seedClosedDayWithOrders(schoolId, { serviceDate: today, studentNames: ["Léo", "Bia"] });
    await adminDb().updateTable("orders").set({ status: "delivered" }).where("id", "=", day.orderIds[0]!).execute();
    await payCheckoutOf(schoolId, day.orderIds[0]!, 1800);
    const { name: mistoName, id: mistoId } = await adminDb()
      .selectFrom("orderItems").innerJoin("menuItems", "menuItems.id", "orderItems.menuItemId")
      .select(["menuItems.name", "menuItems.id"]).where("orderItems.orderId", "=", day.orderIds[0]!).executeTakeFirstOrThrow();
    const fam = await seedFamily(schoolId, ["Caio"]);
    await sell(schoolId, fam.studentIds[0]!, mistoId, 2); // 2 x 900 = 1800, wallet -1800
    const voided = await sell(schoolId, fam.studentIds[0]!, mistoId, 1);
    // Só marca o estorno (sem lançamento novo): void_entry_id aponta para o próprio lançamento da venda por causa do CHECK.
    await adminDb()
      .updateTable("counterSales")
      .set((eb) => ({ voidedAt: new Date(), voidEntryId: eb.ref("walletEntryId") }))
      .where("id", "=", voided)
      .execute();
    const { cookies } = await staffCookie(schoolId, "secretaria");

    const res = await get(cookies);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ period: "today", from: today, to: today });
    expect(body.snacks).toEqual({ paidOrders: 2, deliveredOrders: 1, notCollectedOrders: 0, counterSales: 1, topItems: [{ name: mistoName, qty: 4 }] });
    // A carteira de Caio levou 1800 + 900; o estorno feito à mão acima só marca voided_at (não grava counter_void),
    // então o débito continua 2700, mas o lançamento estornado sai das contagens e do consumo.
    expect(body.money).toEqual({ pixReceivedCents: 1800, counterCents: 1800, creditsCents: 0, debtCents: 2700, debtors: 1 });
    expect(body.documents).toEqual({ published: 0, viewed: 0, batchesRendering: 0, batchesWithFailures: 0 });
  });

  it("resolves 7 days and the current month in the school's local calendar", async () => {
    const schoolId = await createSchool();
    const today = await localDate(schoolId, 0);
    const firstDay = await firstOfMonth(schoolId, 0);
    const { rows } = await sql<{ d: string }>`
      SELECT (date_trunc('month', (now() AT TIME ZONE timezone)::date) - interval '1 day')::date::text AS d
      FROM schools WHERE id = ${schoolId}`.execute(adminDb());
    // Um pedido por aluno; o resultado depende do dia do mês em que o teste roda, então o esperado sai das datas.
    const dates: Record<string, string> = {
      Léo: await localDate(schoolId, -6), // sempre dentro de 7d
      Bia: await localDate(schoolId, -7), // sempre fora de 7d
      Caio: firstDay, // sempre dentro do mês
      Duda: rows[0]!.d, // sempre fora do mês
    };
    // Datas iguais (ex.: dia 1 = hoje-6) viram um só dia de serviço: service_days é único por data.
    const byDate = new Map<string, string[]>();
    for (const [name, d] of Object.entries(dates)) byDate.set(d, [...(byDate.get(d) ?? []), name]);
    for (const [serviceDate, studentNames] of byDate) await seedClosedDayWithOrders(schoolId, { serviceDate, studentNames });
    const inRange = (d: string, from: string, to: string) => d >= from && d <= to;
    const { cookies } = await staffCookie(schoolId, "admin");

    const week = (await get(cookies, "7d")).json();
    expect([week.from, week.to]).toEqual([dates.Léo, today]);
    expect(inRange(dates.Bia!, week.from, week.to)).toBe(false);
    expect(week.snacks.paidOrders).toBe(Object.values(dates).filter((d) => inRange(d, week.from, week.to)).length);

    const month = (await get(cookies, "month")).json();
    expect([month.from, month.to]).toEqual([firstDay, today]);
    expect(inRange(dates.Duda!, month.from, month.to)).toBe(false);
    expect(month.snacks.paidOrders).toBe(Object.values(dates).filter((d) => inRange(d, firstDay, today)).length);
  });

  it("counts published documents and how many were opened", async () => {
    const schoolId = await createSchool();
    const ids = await seedTenant(schoolId);
    await adminDb().updateTable("documentBatches").set({ status: "published", publishedAt: new Date() }).where("id", "=", ids.documentBatchId).execute();
    await adminDb()
      .updateTable("documents")
      .set({ status: "rendered", storagePath: `schools/${schoolId}/x.pdf`, sha256: "a".repeat(64), renderedAt: new Date(), leaseUntil: null })
      .where("id", "=", ids.documentId)
      .execute();
    // seedTenant já grava uma abertura (document_views) para este documento.
    const { cookies } = await staffCookie(schoolId, "secretaria");

    const body = (await get(cookies, "today")).json();
    expect(body.documents).toEqual({ published: 1, viewed: 1, batchesRendering: 0, batchesWithFailures: 0 });
  });

  it("gives the kitchen only the snacks block", async () => {
    const schoolId = await createSchool();
    const { cookies } = await staffCookie(schoolId, "cozinha");
    const body = (await get(cookies)).json();
    expect(body.documents).toBeNull();
    expect(body.money).toBeNull();
    expect(body.snacks.paidOrders).toBe(0);
  });

  it("does not count another school's data", async () => {
    const a = await createSchool();
    const b = await createSchool();
    await seedClosedDayWithOrders(b, { serviceDate: await localDate(b, 0), studentNames: ["Léo"] });
    const { cookies } = await staffCookie(a, "admin");
    const body = (await get(cookies)).json();
    expect(body.snacks.paidOrders).toBe(0);
    expect(body.money).toMatchObject({ pixReceivedCents: 0, creditsCents: 0, debtCents: 0, debtors: 0 });
  });

  it("refuses an unknown period and anonymous visitors", async () => {
    const schoolId = await createSchool();
    const { cookies } = await staffCookie(schoolId, "admin");
    expect((await get(cookies, "year")).statusCode).toBe(400);
    expect((await get({})).statusCode).toBe(401);
  });
});
