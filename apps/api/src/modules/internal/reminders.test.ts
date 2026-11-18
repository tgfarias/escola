import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { adminDb, createSchool, internalRequest, seedFamily, seedServiceDay } from "../../../test/helpers";
import { buildApp } from "../../app";
import { hashToken } from "../auth/tokens";

const prepare = (schoolId: string, body: unknown) =>
  internalRequest("POST", `/internal/v1/schools/${schoolId}/reminders/prepare`, body);

async function confirmOrder(schoolId: string, serviceDayId: string, serviceDate: string, guardianId: string, studentId: string) {
  const checkoutId = crypto.randomUUID();
  await adminDb().insertInto("checkouts").values({ id: checkoutId, schoolId, guardianId, serviceDayId, status: "paid", totalCents: 900 }).execute();
  await adminDb().insertInto("orders").values({ id: crypto.randomUUID(), schoolId, checkoutId, studentId, serviceDate, status: "confirmed" }).execute();
}

describe("reminders", () => {
  it("prepares one recipient per guardian with a link valid until the cutoff", async () => {
    const schoolId = await createSchool();
    const fam = await seedFamily(schoolId, ["Léo", "Bia"]);
    const day = await seedServiceDay(schoolId, { serviceDate: "2031-05-05", cutoffInMinutes: 60 });
    const app = buildApp();
    const res = await app.inject(prepare(schoolId, { service_date: day.serviceDate, cursor: null }));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.next_cursor).toBeNull();
    expect(body.recipients).toHaveLength(1);
    const r = body.recipients[0];
    expect(r).toMatchObject({ guardian_id: fam.guardianId, first_name: "Ana", students: ["Bia", "Léo"], wallet_balance_cents: 0 });
    expect(r.cutoff_local_time).toMatch(/^\d{2}:\d{2}$/);
    const link = await adminDb().selectFrom("magicLinks").select(["expiresAt", "scope", "serviceDate"]).where("tokenHash", "=", hashToken(r.link_url.split("#")[1])).executeTakeFirstOrThrow();
    expect(link).toMatchObject({ scope: "order", serviceDate: day.serviceDate });
    expect(link.expiresAt.toISOString()).toBe(new Date(r.cutoff_at).toISOString());
    const batch = await adminDb().selectFrom("reminderBatches").select(["id", "completedAt"]).where("schoolId", "=", schoolId).executeTakeFirstOrThrow();
    expect(batch.id).toBe(body.batch_id);
    expect(batch.completedAt).toBeNull();
    const del = await app.inject(
      internalRequest("POST", `/internal/v1/schools/${schoolId}/reminders/${body.batch_id}/deliveries`, {
        results: [{ guardian_id: fam.guardianId, status: "sent", wa_message_id: "wamid.Z" }],
      }),
    );
    expect(del.statusCode).toBe(204);
    const again = (await app.inject(prepare(schoolId, { service_date: day.serviceDate, cursor: null }))).json();
    expect(again).toEqual({ batch_id: body.batch_id, next_cursor: null, recipients: [] });
    const done = await adminDb().selectFrom("reminderBatches").select("completedAt").where("schoolId", "=", schoolId).executeTakeFirstOrThrow();
    expect(done.completedAt).not.toBeNull();
  });

  it("redoes guardians handed out but never reported", async () => {
    const schoolId = await createSchool();
    const fam = await seedFamily(schoolId, ["Léo"]);
    const day = await seedServiceDay(schoolId, { serviceDate: "2031-05-15", cutoffInMinutes: 60 });
    const app = buildApp();
    const first = (await app.inject(prepare(schoolId, { service_date: day.serviceDate, cursor: null }))).json();
    const second = (await app.inject(prepare(schoolId, { service_date: day.serviceDate, cursor: null }))).json();
    expect(second.batch_id).toBe(first.batch_id);
    expect(second.recipients.map((r: { guardian_id: string }) => r.guardian_id)).toEqual([fam.guardianId]);
    const batch = await adminDb().selectFrom("reminderBatches").select("completedAt").where("schoolId", "=", schoolId).executeTakeFirstOrThrow();
    expect(batch.completedAt).toBeNull();
  });

  it("formats the local cutoff in the school's timezone", async () => {
    const schoolId = await createSchool();
    await seedFamily(schoolId, ["Léo"]);
    const day = await seedServiceDay(schoolId, { serviceDate: "2031-05-06", cutoffInMinutes: 60 });
    const { rows } = await sql<{ local: string }>`
      SELECT to_char(cutoff_at AT TIME ZONE 'America/Sao_Paulo', 'HH24:MI') AS local FROM service_days WHERE id = ${day.serviceDayId}`.execute(adminDb());
    const res = await buildApp().inject(prepare(schoolId, { service_date: day.serviceDate, cursor: null }));
    expect(res.json().recipients[0].cutoff_local_time).toBe(rows[0]!.local);
  });

  it("skips guardians whose children all have a confirmed order, and inactive children", async () => {
    const schoolId = await createSchool();
    const done = await seedFamily(schoolId, ["Léo"]);
    const partial = await seedFamily(schoolId, ["Bia", "Caio"]);
    const day = await seedServiceDay(schoolId, { serviceDate: "2031-05-07", cutoffInMinutes: 60 });
    await confirmOrder(schoolId, day.serviceDayId, day.serviceDate, done.guardianId, done.studentIds[0]!);
    await confirmOrder(schoolId, day.serviceDayId, day.serviceDate, partial.guardianId, partial.studentIds[0]!);
    const res = await buildApp().inject(prepare(schoolId, { service_date: day.serviceDate, cursor: null }));
    const ids = res.json().recipients.map((r: { guardian_id: string }) => r.guardian_id);
    expect(ids).toEqual([partial.guardianId]);
    await adminDb().updateTable("students").set({ active: false }).where("id", "=", partial.studentIds[1]!).execute();
    const again = await buildApp().inject(prepare(schoolId, { service_date: day.serviceDate, cursor: null }));
    expect(again.json().recipients).toEqual([]);
  });

  it("paginates by 200 with a cursor and reuses the batch", async () => {
    const schoolId = await createSchool();
    for (let i = 0; i < 201; i += 1) await seedFamily(schoolId, ["Léo"]);
    const day = await seedServiceDay(schoolId, { serviceDate: "2031-05-08", cutoffInMinutes: 60 });
    const app = buildApp();
    const first = (await app.inject(prepare(schoolId, { service_date: day.serviceDate, cursor: null }))).json();
    expect(first.recipients).toHaveLength(200);
    expect(first.next_cursor).toBe(first.recipients[199].guardian_id);
    let batch = await adminDb().selectFrom("reminderBatches").select("completedAt").where("schoolId", "=", schoolId).executeTakeFirstOrThrow();
    expect(batch.completedAt).toBeNull();
    const second = (await app.inject(prepare(schoolId, { service_date: day.serviceDate, cursor: first.next_cursor }))).json();
    expect(second.batch_id).toBe(first.batch_id);
    expect(second.recipients).toHaveLength(1);
    expect(second.next_cursor).toBeNull();
    batch = await adminDb().selectFrom("reminderBatches").select("completedAt").where("schoolId", "=", schoolId).executeTakeFirstOrThrow();
    expect(batch.completedAt).toBeNull();
    const third = (await app.inject(prepare(schoolId, { service_date: day.serviceDate, cursor: null }))).json();
    expect(third.batch_id).toBe(first.batch_id);
    expect(third.recipients).toHaveLength(200);
    batch = await adminDb().selectFrom("reminderBatches").select("completedAt").where("schoolId", "=", schoolId).executeTakeFirstOrThrow();
    expect(batch.completedAt).toBeNull();
  }, 60_000);

  it("never resends to a guardian already reported sent or failed", async () => {
    const schoolId = await createSchool();
    const sent = await seedFamily(schoolId, ["Léo"]);
    const failed = await seedFamily(schoolId, ["Bia"]);
    const day = await seedServiceDay(schoolId, { serviceDate: "2031-05-09", cutoffInMinutes: 60 });
    const app = buildApp();
    const page = (await app.inject(prepare(schoolId, { service_date: day.serviceDate, cursor: null }))).json();
    const res = await app.inject(
      internalRequest("POST", `/internal/v1/schools/${schoolId}/reminders/${page.batch_id}/deliveries`, {
        results: [
          { guardian_id: sent.guardianId, status: "sent", wa_message_id: "wamid.A" },
          { guardian_id: failed.guardianId, status: "failed", error: "invalid_number" },
        ],
      }),
    );
    expect(res.statusCode).toBe(204);
    // Um "failed" atrasado não desfaz um "sent".
    await app.inject(
      internalRequest("POST", `/internal/v1/schools/${schoolId}/reminders/${page.batch_id}/deliveries`, {
        results: [{ guardian_id: sent.guardianId, status: "failed", error: "timeout" }],
      }),
    );
    const rows = await adminDb().selectFrom("messageDeliveries").select(["guardianId", "status", "waMessageId", "error"]).where("batchId", "=", page.batch_id).orderBy("guardianId").execute();
    expect(rows).toEqual(
      [
        { guardianId: sent.guardianId, status: "sent", waMessageId: "wamid.A", error: null },
        { guardianId: failed.guardianId, status: "failed", waMessageId: null, error: "invalid_number" },
      ].sort((a, b) => a.guardianId.localeCompare(b.guardianId)),
    );
    const again = (await app.inject(prepare(schoolId, { service_date: day.serviceDate, cursor: null }))).json();
    expect(again.recipients).toEqual([]);
    expect(again.next_cursor).toBeNull();
    const batch = await adminDb().selectFrom("reminderBatches").select("completedAt").where("schoolId", "=", schoolId).executeTakeFirstOrThrow();
    expect(batch.completedAt).not.toBeNull();
  });

  it("answers 404 for a batch of another school and ignores guardians not in the batch", async () => {
    const schoolA = await createSchool();
    const schoolB = await createSchool();
    const famA = await seedFamily(schoolA, ["Léo"]);
    await seedFamily(schoolB, ["Bia"]);
    const dayA = await seedServiceDay(schoolA, { serviceDate: "2031-05-12", cutoffInMinutes: 60 });
    const app = buildApp();
    const pageA = (await app.inject(prepare(schoolA, { service_date: dayA.serviceDate, cursor: null }))).json();
    const cross = await app.inject(
      internalRequest("POST", `/internal/v1/schools/${schoolB}/reminders/${pageA.batch_id}/deliveries`, {
        results: [{ guardian_id: famA.guardianId, status: "sent", wa_message_id: "wamid.X" }],
      }),
    );
    expect(cross.statusCode).toBe(404);
    const stranger = await app.inject(
      internalRequest("POST", `/internal/v1/schools/${schoolA}/reminders/${pageA.batch_id}/deliveries`, {
        results: [{ guardian_id: crypto.randomUUID(), status: "sent", wa_message_id: "wamid.Y" }],
      }),
    );
    expect(stranger.statusCode).toBe(204);
  });

  it("answers 404 without a service day and 409 after the cutoff", async () => {
    const schoolId = await createSchool();
    await seedFamily(schoolId, ["Léo"]);
    const app = buildApp();
    const missing = await app.inject(prepare(schoolId, { service_date: "2031-05-13", cursor: null }));
    expect(missing.statusCode).toBe(404);
    const past = await seedServiceDay(schoolId, { serviceDate: "2031-05-14", cutoffInMinutes: -1 });
    const late = await app.inject(prepare(schoolId, { service_date: past.serviceDate, cursor: null }));
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe("cutoff_passed");
  });
});
