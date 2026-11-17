import { Writable } from "node:stream";
import { uuidv7 } from "uuidv7";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adminDb, createSchool, guardianCookie, seedFamily, seedServiceDay } from "../../../test/helpers";
import { buildApp } from "../../app";
import { resetEfiForTests, setEfiTransportForTests } from "../payments/efi/client";
import { txidFor } from "../payments/efi/efiProvider";

const SECRET = process.env.PAYMENT_WEBHOOK_SECRET_TEST!;
const REF = "EFI_TEST_CREDENTIALS";

beforeEach(() => {
  process.env[REF] = JSON.stringify({
    client_id: "Client_Id_test",
    client_secret: "Client_Secret_test",
    pix_key: "chave-pix-escola",
    certificate_p12_base64: "AA==",
  });
});

afterEach(() => {
  setEfiTransportForTests(null);
  resetEfiForTests();
});

async function pendingEfiPayment() {
  const schoolId = await createSchool();
  await adminDb()
    .updateTable("schools")
    .set({ paymentWebhookSecretRef: "PAYMENT_WEBHOOK_SECRET_TEST", paymentAccountRef: REF })
    .where("id", "=", schoolId)
    .execute();
  const family = await seedFamily(schoolId, ["Léo"]);
  const day = await seedServiceDay(schoolId);
  const res = await buildApp().inject({
    method: "POST",
    url: "/api/v1/checkouts",
    cookies: await guardianCookie(schoolId, family.guardianId),
    headers: { "idempotency-key": uuidv7() },
    payload: { serviceDate: day.serviceDate, orders: [{ studentId: family.studentIds[0]!, items: [{ menuItemId: day.items[0]!.id, qty: 1 }] }] },
  });
  const checkoutId = res.json().id as string;
  const payment = await adminDb()
    .selectFrom("payments")
    .select(["id", "amountCents", "expiresAt"])
    .where("checkoutId", "=", checkoutId)
    .executeTakeFirstOrThrow();
  const txid = txidFor(payment.id);
  await adminDb().updateTable("payments").set({ provider: "efi", providerChargeId: txid }).where("id", "=", payment.id).execute();
  const reais = `${Math.floor(payment.amountCents / 100)}.${String(payment.amountCents % 100).padStart(2, "0")}`;
  setEfiTransportForTests(async (req) => {
    if (req.path === "/oauth/token") return { status: 200, body: { access_token: "tok", expires_in: 3600 } };
    if (req.method === "GET" && req.path === `/v2/cob/${txid}`) {
      return {
        status: 200,
        body: {
          txid,
          status: "CONCLUIDA",
          valor: { original: reais },
          pix: [{ endToEndId: "E123", txid, valor: reais, horario: new Date(payment.expiresAt.getTime() - 60_000).toISOString() }],
        },
      };
    }
    throw new Error(`unexpected ${req.method} ${req.path}`);
  });
  return { schoolId, checkoutId, txid };
}

const notification = (txid: string) => ({ pix: [{ endToEndId: "E123", txid, valor: "0.01", horario: "2020-01-01T00:00:00Z" }] });

function send(app: ReturnType<typeof buildApp>, schoolId: string, body: unknown, token = SECRET) {
  return app.inject({
    method: "POST",
    url: `/webhooks/payments/efi/${schoolId}?token=${token}&ignorar=/pix`,
    headers: { "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
}

describe("efi payment webhook", () => {
  it("confirms the payment through the charge lookup, deduplicates, and never logs the token", async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const app = buildApp({ logger: { level: "info", stream } });
    const p = await pendingEfiPayment();

    const first = await send(app, p.schoolId, notification(p.txid));
    expect(first.statusCode).toBe(200);
    const status = (await adminDb().selectFrom("checkouts").select("status").where("id", "=", p.checkoutId).executeTakeFirstOrThrow()).status;
    expect(status).toBe("paid");

    expect((await send(app, p.schoolId, notification(p.txid))).statusCode).toBe(200);
    const confirmed = await adminDb().selectFrom("outboxEvents").select("id").where("schoolId", "=", p.schoolId).where("type", "=", "payment.confirmed").execute();
    expect(confirmed).toHaveLength(1);

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("")).not.toContain(SECRET);
  });

  it("rejects a wrong token with 401 and stores no event", async () => {
    const p = await pendingEfiPayment();
    const res = await send(buildApp(), p.schoolId, notification(p.txid), "wrong-token-0123456789abcdefghijklmn");
    expect(res.statusCode).toBe(401);
    const events = await adminDb().selectFrom("paymentEvents").select("id").where("schoolId", "=", p.schoolId).execute();
    expect(events).toHaveLength(0);
  });
});
