import { describe, expect, it } from "vitest";
import { adminDb, createSchool } from "../../test/helpers";
import { withTenant } from "../db/index";
import { enqueueEvent } from "./outbox";

const event = {
  type: "auth.otp_requested" as const,
  data: {
    channel: "whatsapp" as const,
    to: "+5511999990001",
    firstName: "Ana",
    code: "123456",
    expiresAt: "2026-11-17T07:30:00-03:00",
  },
};

describe("enqueueEvent", () => {
  it("stores the event for the tenant", async () => {
    const schoolId = await createSchool();
    const id = await withTenant(schoolId, (trx) => enqueueEvent(trx, schoolId, event));
    const row = await adminDb()
      .selectFrom("outboxEvents")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(row.schoolId).toBe(schoolId);
    expect(row.type).toBe("auth.otp_requested");
    expect(row.data).toEqual(event.data);
    expect(row.deliveredAt).toBeNull();
  });

  it("is rolled back with the surrounding transaction", async () => {
    const schoolId = await createSchool();
    await expect(
      withTenant(schoolId, async (trx) => {
        await enqueueEvent(trx, schoolId, event);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    const rows = await adminDb()
      .selectFrom("outboxEvents")
      .select("id")
      .where("schoolId", "=", schoolId)
      .execute();
    expect(rows).toEqual([]);
  });

  it("rejects an event that does not match the contract", async () => {
    const schoolId = await createSchool();
    const bad = { ...event, data: { ...event.data, code: "12" } };
    await expect(withTenant(schoolId, (trx) => enqueueEvent(trx, schoolId, bad))).rejects.toThrow();
  });
});
