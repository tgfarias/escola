import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { resetConfigForTests } from "../src/platform/config";
import { signedEventRequest } from "../src/modules/outbox/service";
import { adminDb, createSchool, internalRequest, seedFamily, seedServiceDay } from "./helpers";

const ROOT = join(__dirname, "..", "..", "..", "n8n");
const require_ = createRequire(import.meta.url);
const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<unknown>;

type Workflow = { nodes: { name: string; notes?: string; parameters: { jsCode?: string } }[] };
const workflow = (file: string): Workflow => JSON.parse(readFileSync(join(ROOT, "workflows", file), "utf8"));
const code = (file: string, node: string) => workflow(file).nodes.find((n) => n.name === node)!.parameters.jsCode!;

const ENV = {
  APP_LANCHE_API_URL: "https://api.test",
  APP_LANCHE_SERVICE_TOKEN: process.env.INTERNAL_SERVICE_TOKEN,
  APP_LANCHE_HMAC_SECRET: process.env.INTERNAL_HMAC_SECRET,
  APP_LANCHE_EVENTS_SECRET: "test-n8n-hmac-secret-with-at-least-32-chars",
  APP_LANCHE_EVENTS_PATH: "/webhook/app-lanche-events",
  WHATSAPP_PHONE_NUMBER_ID: "123",
  WHATSAPP_TOKEN: "wa-token",
  WA_TEMPLATE_REMINDER: "lembrete_lanche",
  WA_TEMPLATE_KITCHEN: "resumo_cozinha",
  WA_TEMPLATE_OTP: "codigo_acesso",
  WA_TEMPLATE_PAYMENT_CONFIRMED: "pedido_confirmado",
  WA_TEMPLATE_LATE_CREDIT: "credito_atrasado",
};

type Sent = { to: string; template: string; params: string[]; components: { type: string; sub_type?: string; index?: string; parameters: { text: string }[] }[] };
const FAIL_PHONE = "5511900000999";
/** Número para o qual o envio falha no transporte (exceção, sem resposta HTTP). */
const THROW_PHONE = "5511900000998";

/** Executa um Code node como o n8n: `this.helpers`, `$env`, `$input`, `$getWorkflowStaticData`, `require`. */
function harness(onlySchool: string) {
  const app = buildApp();
  const whatsapp: Sent[] = [];
  const helpers = {
    async httpRequest(o: { method: string; url: string; headers: Record<string, string>; body?: string }) {
      if (o.url.startsWith("https://graph.facebook.com/")) {
        const msg = JSON.parse(o.body!);
        whatsapp.push({
          to: msg.to,
          template: msg.template.name,
          params: msg.template.components[0].parameters.map((p: { text: string }) => p.text),
          components: msg.template.components,
        });
        if (msg.to === THROW_PHONE) throw new Error("socket hang up");
        if (msg.to === FAIL_PHONE) return { statusCode: 400, body: JSON.stringify({ error: { code: 131026 } }), headers: {} };
        return { statusCode: 200, body: JSON.stringify({ messages: [{ id: `wamid.${whatsapp.length}` }] }), headers: {} };
      }
      const path = o.url.slice(ENV.APP_LANCHE_API_URL.length);
      const res = await app.inject({ method: o.method as "GET" | "POST", url: path, headers: o.headers, ...(o.body ? { payload: o.body } : {}) });
      let body = res.body;
      // Agenda compartilhada entre arquivos de teste: o fluxo só enxerga a escola deste teste.
      if (path === "/internal/v1/schedule/due" && res.statusCode === 200) {
        body = JSON.stringify({ due: res.json().due.filter((d: { school_id: string }) => d.school_id === onlySchool) });
      }
      return { statusCode: res.statusCode, body, headers: res.headers };
    },
    async getBinaryDataBuffer(): Promise<Buffer> {
      throw new Error("set per run");
    },
  };
  async function run(jsCode: string, opts: { input?: unknown; staticData?: Record<string, unknown>; raw?: string } = {}) {
    const staticData = opts.staticData ?? {};
    const ctx = { helpers: { ...helpers, getBinaryDataBuffer: async () => Buffer.from(opts.raw ?? "") } };
    const fn = new AsyncFunction("$env", "$input", "$getWorkflowStaticData", "require", jsCode);
    return (await fn.call(ctx, ENV, { first: () => opts.input, all: () => [opts.input] }, () => staticData, require_)) as { json: Record<string, unknown> }[];
  }
  return { run, whatsapp };
}

describe("n8n workflows", () => {
  it("are built from n8n/code", async () => {
    // @ts-expect-error -- build.mjs não tem tipos
    const { buildWorkflow } = await import("../../../n8n/build.mjs");
    for (const file of ["schedule.json", "events.json"]) {
      const current = workflow(file);
      expect(buildWorkflow(structuredClone(current))).toEqual(current);
      expect(current.nodes.filter((n) => n.notes?.startsWith("code:")).every((n) => (n.parameters.jsCode ?? "").length > 0)).toBe(true);
    }
  });

  it("sends reminders once and records deliveries", async () => {
    const schoolId = await createSchool();
    const fam = await seedFamily(schoolId, ["Léo", "Bia"]);
    await seedServiceDay(schoolId, { serviceDate: "2031-09-01", cutoffInMinutes: 60 });
    const h = harness(schoolId);
    const out = await h.run(code("schedule.json", "Run due actions"));
    expect(out).toEqual([{ json: expect.objectContaining({ action: "send_reminders", school_id: schoolId, ok: true, sent: 1, failed: 0 }) }]);
    expect(h.whatsapp).toHaveLength(1);
    const msg = h.whatsapp[0]!;
    expect(msg.template).toBe("lembrete_lanche");
    expect(msg.params.slice(0, 2)).toEqual(["Ana", "Bia e Léo"]);
    expect(msg.params[3]).toBe("R$ 0,00");
    expect(msg.params[4]).toMatch(/^https:\/\/app\.test\/l#/);
    const delivery = await adminDb().selectFrom("messageDeliveries").select(["status", "waMessageId"]).where("guardianId", "=", fam.guardianId).executeTakeFirstOrThrow();
    expect(delivery).toEqual({ status: "sent", waMessageId: "wamid.1" });
    // Segunda rodada: ninguém a lembrar, o lote é concluído; terceira: fora da agenda.
    const second = await h.run(code("schedule.json", "Run due actions"));
    expect(second).toEqual([{ json: expect.objectContaining({ action: "send_reminders", ok: true, sent: 0, failed: 0 }) }]);
    const third = await h.run(code("schedule.json", "Run due actions"));
    expect(third).toEqual([{ json: { idle: true } }]);
    expect(h.whatsapp).toHaveLength(1);
  });

  it("closes the day without sending WhatsApp (the summary comes from the event)", async () => {
    const schoolId = await createSchool();
    await adminDb().updateTable("schools").set({ kitchenPhone: "+5511988880000" }).where("id", "=", schoolId).execute();
    await seedServiceDay(schoolId, { serviceDate: "2031-09-02", cutoffInMinutes: -6 });
    const h = harness(schoolId);
    const out = await h.run(code("schedule.json", "Run due actions"));
    expect(out[0]!.json).toEqual({ action: "close_service_day", school_id: schoolId, service_date: "2031-09-02", ok: true, closed: true, orders: 0 });
    expect(h.whatsapp).toEqual([]);
    const day = await adminDb().selectFrom("serviceDays").select("status").where("schoolId", "=", schoolId).where("serviceDate", "=", "2031-09-02").executeTakeFirstOrThrow();
    expect(day.status).toBe("closed");
  });

  it("records a failed delivery when WhatsApp rejects the number", async () => {
    const schoolId = await createSchool();
    const ok = await seedFamily(schoolId, ["Léo"]);
    const bad = await seedFamily(schoolId, ["Bia"]);
    await adminDb().updateTable("guardians").set({ phoneE164: `+${FAIL_PHONE}` }).where("id", "=", bad.guardianId).execute();
    await seedServiceDay(schoolId, { serviceDate: "2031-09-05", cutoffInMinutes: 60 });
    const h = harness(schoolId);
    const out = await h.run(code("schedule.json", "Run due actions"));
    expect(out).toEqual([{ json: expect.objectContaining({ action: "send_reminders", ok: true, sent: 1, failed: 1 }) }]);
    const rows = await adminDb().selectFrom("messageDeliveries").select(["guardianId", "status", "error"]).where("schoolId", "=", schoolId).execute();
    expect(rows.find((r) => r.guardianId === ok.guardianId)?.status).toBe("sent");
    expect(rows.find((r) => r.guardianId === bad.guardianId)).toMatchObject({ status: "failed", error: "invalid_number" });
    expect(rows).toHaveLength(2);
  });

  it("records a failed delivery and keeps going when the WhatsApp request throws", async () => {
    const schoolId = await createSchool();
    const ok = await seedFamily(schoolId, ["Léo"]);
    const bad = await seedFamily(schoolId, ["Bia"]);
    await adminDb().updateTable("guardians").set({ phoneE164: `+${THROW_PHONE}` }).where("id", "=", bad.guardianId).execute();
    await seedServiceDay(schoolId, { serviceDate: "2031-09-08", cutoffInMinutes: 60 });
    const h = harness(schoolId);
    const out = await h.run(code("schedule.json", "Run due actions"));
    expect(out).toEqual([{ json: expect.objectContaining({ action: "send_reminders", ok: true, sent: 1, failed: 1 }) }]);
    const rows = await adminDb().selectFrom("messageDeliveries").select(["guardianId", "status", "error"]).where("schoolId", "=", schoolId).execute();
    expect(rows.find((r) => r.guardianId === ok.guardianId)?.status).toBe("sent");
    expect(rows.find((r) => r.guardianId === bad.guardianId)).toMatchObject({ status: "failed", error: "send_failed" });
    expect(rows).toHaveLength(2);
  });

  describe("events", () => {
    const withN8n = async <T>(fn: () => Promise<T>): Promise<T> => {
      process.env.N8N_EVENTS_URL = "https://n8n.test/webhook/app-lanche-events";
      process.env.N8N_HMAC_SECRET = ENV.APP_LANCHE_EVENTS_SECRET;
      resetConfigForTests();
      try {
        return await fn();
      } finally {
        delete process.env.N8N_EVENTS_URL;
        delete process.env.N8N_HMAC_SECRET;
        resetConfigForTests();
      }
    };
    const envelope = (id: string, type: string, data: Record<string, unknown>) => ({
      id,
      type,
      school_id: crypto.randomUUID(),
      occurred_at: new Date().toISOString(),
      data,
    });

    it("verifies the dispatcher signature, sends the OTP and deduplicates", async () => {
      const id = crypto.randomUUID();
      const req = await withN8n(async () =>
        signedEventRequest(envelope(id, "auth.otp_requested", { channel: "whatsapp", to: "+5511999990001", first_name: "Ana", code: "123456", expires_at: new Date(Date.now() + 300_000).toISOString() })),
      );
      const h = harness(crypto.randomUUID());
      const staticData = {};
      const input = { json: { headers: req.headers } };
      const out = await h.run(code("events.json", "Verify and send"), { input, raw: req.body, staticData });
      expect(out).toEqual([{ json: { ok: true, type: "auth.otp_requested", email: null } }]);
      expect(h.whatsapp).toEqual([expect.objectContaining({ to: "5511999990001", template: "codigo_acesso", params: ["123456"] })]);
      expect(h.whatsapp[0]!.components[1]).toEqual({ type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "123456" }] });
      const dup = await h.run(code("events.json", "Verify and send"), { input, raw: req.body, staticData });
      expect(dup[0]!.json).toMatchObject({ duplicate: true });
      expect(h.whatsapp).toHaveLength(1);
    });

    it("sends the kitchen summary from service_day.closed and deduplicates", async () => {
      const schoolId = await createSchool();
      await adminDb().updateTable("schools").set({ kitchenPhone: "+5511988880000" }).where("id", "=", schoolId).execute();
      await seedServiceDay(schoolId, { serviceDate: "2031-09-09", cutoffInMinutes: -6 });
      const closed = await buildApp().inject(internalRequest("POST", `/internal/v1/service-days/${schoolId}/2031-09-09/close`));
      expect(closed.statusCode).toBe(200);
      const req = await withN8n(async () =>
        signedEventRequest({ ...envelope(crypto.randomUUID(), "service_day.closed", { service_date: "2031-09-09", orders: 0, late_credits: 0 }), school_id: schoolId }),
      );
      const h = harness(schoolId);
      const staticData = {};
      const input = { json: { headers: req.headers } };
      const out = await h.run(code("events.json", "Verify and send"), { input, raw: req.body, staticData });
      expect(out).toEqual([{ json: { ok: true, type: "service_day.closed", email: null } }]);
      expect(h.whatsapp).toEqual([expect.objectContaining({ to: "5511988880000", template: "resumo_cozinha", params: ["09/09", "0", "nenhum item"] })]);
      const dup = await h.run(code("events.json", "Verify and send"), { input, raw: req.body, staticData });
      expect(dup[0]!.json).toMatchObject({ duplicate: true });
      expect(h.whatsapp).toHaveLength(1);
    });

    it("rejects a tampered body", async () => {
      const req = await withN8n(async () => signedEventRequest(envelope(crypto.randomUUID(), "service_day.closed", { service_date: "2031-09-03", orders: 1, late_credits: 0 })));
      const h = harness(crypto.randomUUID());
      await expect(
        h.run(code("events.json", "Verify and send"), { input: { json: { headers: req.headers } }, raw: req.body.replace('"orders":1', '"orders":2') }),
      ).rejects.toThrow("invalid signature");
    });

    it("rejects a stale timestamp even with a valid signature", async () => {
      const req = await withN8n(async () => signedEventRequest(envelope(crypto.randomUUID(), "service_day.closed", { service_date: "2031-09-03", orders: 1, late_credits: 0 })));
      const timestamp = new Date(Date.now() - 10 * 60_000).toISOString();
      const signature = createHmac("sha256", ENV.APP_LANCHE_EVENTS_SECRET).update(`POST\n${ENV.APP_LANCHE_EVENTS_PATH}\n${timestamp}\n${req.body}`).digest("hex");
      const h = harness(crypto.randomUUID());
      await expect(
        h.run(code("events.json", "Verify and send"), { input: { json: { headers: { ...req.headers, "x-timestamp": timestamp, "x-signature": signature } } }, raw: req.body }),
      ).rejects.toThrow("invalid signature");
    });

    it("hands e-mail OTPs to the e-mail node and formats payment messages", async () => {
      const h = harness(crypto.randomUUID());
      const emailReq = await withN8n(async () =>
        signedEventRequest(envelope(crypto.randomUUID(), "auth.otp_requested", { channel: "email", to: "x@escola.test", first_name: null, code: "654321", expires_at: new Date(Date.now() + 300_000).toISOString() })),
      );
      const emailOut = await h.run(code("events.json", "Verify and send"), { input: { json: { headers: emailReq.headers } }, raw: emailReq.body });
      expect(emailOut[0]!.json.email).toMatchObject({ to: "x@escola.test", subject: "Seu código de acesso" });
      expect(h.whatsapp).toHaveLength(0);
      const payReq = await withN8n(async () =>
        signedEventRequest(envelope(crypto.randomUUID(), "payment.confirmed", { guardian_id: crypto.randomUUID(), phone: "+5511999990002", first_name: "Ana", checkout_id: crypto.randomUUID(), service_date: "2031-09-04", students: ["Léo", "Bia"], total_cents: 123456 })),
      );
      await h.run(code("events.json", "Verify and send"), { input: { json: { headers: payReq.headers } }, raw: payReq.body });
      expect(h.whatsapp).toEqual([expect.objectContaining({ to: "5511999990002", template: "pedido_confirmado", params: ["Ana", "Léo e Bia", "04/09", "R$ 1.234,56"] })]);
    });
  });
});
