import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { adminDb, createSchool, seedTenant } from "../../../test/helpers";
import { withTenant } from "../../db/index";
import { config, resetConfigForTests } from "../../platform/config";
import { signInternal } from "../../platform/hmac";
import { enqueueEvent } from "../../platform/outbox";
import { dispatchOutbox, dispatchSchool } from "./service";

const SECRET = "test-n8n-hmac-secret-with-at-least-32-chars";
const log = { warn: () => undefined, info: () => undefined, error: () => undefined } as never;

type Received = { headers: IncomingMessage["headers"]; body: string; path: string };
let server: Server;
let received: Received[] = [];
let status = 200;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body, path: req.url ?? "" });
      res.statusCode = status;
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  process.env.N8N_EVENTS_URL = `http://127.0.0.1:${port}/webhook/app-lanche-events?x=1`;
  process.env.N8N_HMAC_SECRET = SECRET;
  resetConfigForTests();
});

afterAll(async () => {
  delete process.env.N8N_EVENTS_URL;
  delete process.env.N8N_HMAC_SECRET;
  resetConfigForTests();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  received = [];
  status = 200;
});

const forSchool = (schoolId: string) => received.map((r) => JSON.parse(r.body)).filter((e) => e.school_id === schoolId);

async function otp(schoolId: string, expiresAt = new Date(Date.now() + 300_000)) {
  return withTenant(schoolId, (trx) =>
    enqueueEvent(trx, schoolId, {
      type: "auth.otp_requested",
      data: { channel: "whatsapp", to: "+5511999990001", first_name: "Ana", code: "123456", expires_at: expiresAt.toISOString() },
    }),
  );
}

const row = (id: string) =>
  adminDb()
    .selectFrom("outboxEvents")
    .select(["attempts", "deliveredAt", "failedAt", sql<string>`data::text`.as("data"), sql<boolean>`next_attempt_at > now() + interval '30 seconds'`.as("backedOff")])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();

describe("outbox dispatcher", () => {
  it("posts a signed envelope and scrubs the OTP after delivery", async () => {
    const schoolId = await createSchool();
    await seedTenant(schoolId);
    const id = await otp(schoolId);
    const counts = await dispatchSchool(schoolId, log);
    expect(counts.delivered).toBeGreaterThanOrEqual(1);
    const sent = received.find((r) => JSON.parse(r.body).id === id)!;
    expect(sent.path).toBe("/webhook/app-lanche-events?x=1");
    const envelope = JSON.parse(sent.body);
    expect(envelope).toMatchObject({ id, type: "auth.otp_requested", school_id: schoolId, data: { code: "123456" } });
    const expected = signInternal(SECRET, {
      method: "POST",
      path: "/webhook/app-lanche-events?x=1",
      timestamp: String(sent.headers["x-timestamp"]),
      body: sent.body,
    });
    expect(sent.headers["x-signature"]).toBe(expected);
    const after = await row(id);
    expect(after.deliveredAt).not.toBeNull();
    expect(after.attempts).toBe(1);
    expect(JSON.parse(after.data)).toEqual({});
  });

  it("keeps other events' data after delivery and does not resend a delivered event", async () => {
    const schoolId = await createSchool();
    await seedTenant(schoolId);
    const id = await withTenant(schoolId, (trx) =>
      enqueueEvent(trx, schoolId, { type: "service_day.closed", data: { service_date: "2031-06-02", orders: 3, late_credits: 0 } }),
    );
    await dispatchSchool(schoolId, log);
    await dispatchSchool(schoolId, log);
    expect(forSchool(schoolId).filter((e) => e.id === id)).toHaveLength(1);
    expect(JSON.parse((await row(id)).data)).toEqual({ service_date: "2031-06-02", orders: 3, late_credits: 0 });
  });

  it("backs off after a failed attempt and keeps the event pending", async () => {
    const schoolId = await createSchool();
    await seedTenant(schoolId);
    const id = await otp(schoolId);
    status = 503;
    const counts = await dispatchSchool(schoolId, log);
    expect(counts.failed).toBeGreaterThanOrEqual(1);
    const after = await row(id);
    expect(after).toMatchObject({ attempts: 1, deliveredAt: null, failedAt: null, backedOff: true });
    expect(JSON.parse(after.data)).toMatchObject({ code: "123456" });
  });

  it("abandons an expired OTP without sending it and scrubs it", async () => {
    const schoolId = await createSchool();
    await seedTenant(schoolId);
    const id = await otp(schoolId, new Date(Date.now() - 1000));
    const counts = await dispatchSchool(schoolId, log);
    expect(counts.abandoned).toBeGreaterThanOrEqual(1);
    expect(forSchool(schoolId).some((e) => e.id === id)).toBe(false);
    const after = await row(id);
    expect(after.failedAt).not.toBeNull();
    expect(JSON.parse(after.data)).toEqual({});
  });

  it("abandons an event older than 24 hours", async () => {
    const schoolId = await createSchool();
    await seedTenant(schoolId);
    const id = uuidv7();
    await adminDb()
      .insertInto("outboxEvents")
      .values({ id, schoolId, type: "service_day.closed", data: "{}", occurredAt: sql`now() - interval '25 hours'` })
      .execute();
    await dispatchSchool(schoolId, log);
    expect(forSchool(schoolId).some((e) => e.id === id)).toBe(false);
    expect((await row(id)).failedAt).not.toBeNull();
  });

  it("does not send the same event twice when two dispatchers race", async () => {
    const schoolId = await createSchool();
    await seedTenant(schoolId);
    const ids: string[] = [];
    for (let i = 0; i < 20; i += 1) ids.push(await otp(schoolId));
    await Promise.all([dispatchSchool(schoolId, log), dispatchSchool(schoolId, log), dispatchSchool(schoolId, log)]);
    const sentIds = forSchool(schoolId).map((e) => e.id).filter((id) => ids.includes(id));
    expect(sentIds.sort()).toEqual([...ids].sort());
  });

  it("dispatches only the listed schools when asked", async () => {
    const a = await createSchool();
    const b = await createSchool();
    await seedTenant(a);
    await seedTenant(b);
    const idA = await otp(a);
    const idB = await otp(b);
    const result = await dispatchOutbox({ log, schoolIds: [a] });
    expect(result.schools).toBe(1);
    expect(forSchool(a).some((e) => e.id === idA)).toBe(true);
    expect(forSchool(b).some((e) => e.id === idB)).toBe(false);
  });

  it("does nothing without an n8n URL", async () => {
    const schoolId = await createSchool();
    await seedTenant(schoolId);
    const id = await otp(schoolId);
    const saved = process.env.N8N_EVENTS_URL;
    const savedSecret = process.env.N8N_HMAC_SECRET;
    delete process.env.N8N_EVENTS_URL;
    delete process.env.N8N_HMAC_SECRET;
    resetConfigForTests();
    try {
      expect(config().n8nEventsUrl).toBeNull();
      expect(await dispatchSchool(schoolId, log)).toEqual({ delivered: 0, failed: 0, abandoned: 0 });
      expect((await row(id)).attempts).toBe(0);
    } finally {
      process.env.N8N_EVENTS_URL = saved;
      process.env.N8N_HMAC_SECRET = savedSecret;
      resetConfigForTests();
    }
  });
});
