import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { adminDb, createSchool } from "../../test/helpers";
import { withTenant } from "../db/index";
import { DomainError } from "./errors";
import { idempotencyKeyFrom, idempotent, requestHash } from "./idempotency";

const hashA = requestHash({ route: "POST /x", actorId: "a", body: { n: 1 } });

describe("idempotent", () => {
  it("runs once and replays the stored response", async () => {
    const schoolId = await createSchool();
    let calls = 0;
    const run = () =>
      withTenant(schoolId, (trx) =>
        idempotent(trx, { schoolId, key: "key-00000001", requestHash: hashA }, async () => {
          calls += 1;
          return { value: calls, nested: { snake_case: true } };
        }),
      );
    expect(await run()).toEqual({ response: { value: 1, nested: { snake_case: true } }, replayed: false });
    expect(await run()).toEqual({ response: { value: 1, nested: { snake_case: true } }, replayed: true });
    expect(calls).toBe(1);
  });

  it("rejects the same key with a different request", async () => {
    const schoolId = await createSchool();
    const input = { schoolId, key: "key-00000002", requestHash: hashA };
    await withTenant(schoolId, (trx) => idempotent(trx, input, async () => ({ ok: true })));
    const other = { ...input, requestHash: requestHash({ route: "POST /x", actorId: "a", body: { n: 2 } }) };
    await expect(withTenant(schoolId, (trx) => idempotent(trx, other, async () => ({ ok: true })))).rejects.toMatchObject({
      code: "idempotency_key_reused",
    });
  });

  it("does not keep the key when the work fails", async () => {
    const schoolId = await createSchool();
    const input = { schoolId, key: "key-00000003", requestHash: hashA };
    await expect(
      withTenant(schoolId, (trx) =>
        idempotent(trx, input, async () => {
          throw new DomainError("not_found");
        }),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    const { response } = await withTenant(schoolId, (trx) => idempotent(trx, input, async () => ({ second: true })));
    expect(response).toEqual({ second: true });
  });

  it("serializes concurrent requests with the same key", async () => {
    const schoolId = await createSchool();
    let calls = 0;
    const run = () =>
      withTenant(schoolId, (trx) =>
        idempotent(trx, { schoolId, key: "key-00000004", requestHash: hashA }, async () => {
          calls += 1;
          await sql`SELECT pg_sleep(0.3)`.execute(trx);
          return { calls };
        }),
      );
    const [a, b] = await Promise.all([run(), run()]);
    expect(calls).toBe(1);
    expect(a.response).toEqual(b.response);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
  });

  it("keys are scoped by school", async () => {
    const schoolA = await createSchool();
    const schoolB = await createSchool();
    const key = "key-00000005";
    await withTenant(schoolA, (trx) => idempotent(trx, { schoolId: schoolA, key, requestHash: hashA }, async () => ({ s: "A" })));
    const b = await withTenant(schoolB, (trx) =>
      idempotent(trx, { schoolId: schoolB, key, requestHash: hashA }, async () => ({ s: "B" })),
    );
    expect(b).toEqual({ response: { s: "B" }, replayed: false });
    const rows = await adminDb().selectFrom("idempotencyKeys").select("schoolId").where("key", "=", key).execute();
    expect(rows).toHaveLength(2);
  });
});

describe("idempotencyKeyFrom", () => {
  const req = (value?: string) => ({ headers: value === undefined ? {} : { "idempotency-key": value } }) as never;
  it("accepts a UUID", () => {
    expect(idempotencyKeyFrom(req("0193a3b0-0000-7000-8000-000000000000"))).toBe("0193a3b0-0000-7000-8000-000000000000");
  });
  it.each([undefined, "", "short", "has space in it", "x".repeat(201)])("rejects %j", (value) => {
    expect(() => idempotencyKeyFrom(req(value))).toThrow(expect.objectContaining({ code: "idempotency_key_required" }));
  });
});
