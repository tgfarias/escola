import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEfiForTests, setEfiTransportForTests, type EfiTransport } from "./client";
import { efiProvider, splitConfigIdFor, txidFor } from "./efiProvider";
import { bpsToPercent, centsToReais, reaisToCents } from "./money";

const REF = "EFI_TEST_CREDENTIALS";
const SECRET = "efi-webhook-secret-0123456789abcdefghij";
const PAYMENT_ID = "0193a3b0-0000-7000-8000-000000000001";
const SCHOOL_ID = "0193a3b0-0000-7000-8000-0000000000aa";
const TXID = "0193a3b0000070008000000000000001";

type Call = { method: string; path: string; headers: Record<string, string>; body?: unknown };
let calls: Call[];
let routes: Record<string, (call: Call) => { status: number; body: unknown }>;

beforeEach(() => {
  process.env[REF] = JSON.stringify({
    client_id: "Client_Id_test",
    client_secret: "Client_Secret_test",
    pix_key: "chave-pix-escola",
    certificate_p12_base64: "AA==",
  });
  calls = [];
  routes = {
    "POST /oauth/token": () => ({ status: 200, body: { access_token: "tok-1", token_type: "Bearer", expires_in: 3600 } }),
  };
  const transport: EfiTransport = async (req) => {
    const call = { method: req.method, path: req.path, headers: req.headers, body: req.body ? JSON.parse(req.body) : undefined };
    calls.push(call);
    const handler = routes[`${req.method} ${req.path}`];
    if (!handler) throw new Error(`unexpected ${req.method} ${req.path}`);
    return handler(call);
  };
  setEfiTransportForTests(transport);
});

afterEach(() => {
  setEfiTransportForTests(null);
  resetEfiForTests();
});

const activeCob = { txid: TXID, status: "ATIVA", valor: { original: "13.50" }, pixCopiaECola: "000201EFI" };
const paidCob = {
  txid: TXID,
  status: "CONCLUIDA",
  valor: { original: "13.50" },
  pix: [{ endToEndId: "E123", txid: TXID, valor: "13.50", horario: "2030-03-04T10:00:00.000Z" }],
};

const chargeRequest = (platformFeeBps = 0) => ({
  paymentId: PAYMENT_ID,
  schoolId: SCHOOL_ID,
  amountCents: 1350,
  expiresAt: new Date(Date.now() + 3_600_000),
  description: "Lanche escolar",
  accountRef: REF,
  platformFeeBps,
});

describe("efi money helpers", () => {
  it("converts with integer arithmetic", () => {
    expect(centsToReais(1350)).toBe("13.50");
    expect(centsToReais(5)).toBe("0.05");
    expect(reaisToCents("13.50")).toBe(1350);
    expect(reaisToCents("0.01")).toBe(1);
    expect(() => reaisToCents("13.5")).toThrow();
    expect(() => reaisToCents("1,00")).toThrow();
    expect(bpsToPercent(1000)).toBe("10.00");
    expect(bpsToPercent(9000)).toBe("90.00");
    expect(bpsToPercent(250)).toBe("2.50");
  });

  it("derives txid and split config ids", () => {
    expect(txidFor(PAYMENT_ID)).toBe(TXID);
    expect(splitConfigIdFor(SCHOOL_ID)).toBe("sp0193a3b00000700080000000000000aa");
  });
});

describe("efi createCharge", () => {
  it("authenticates once and creates the charge with our txid", async () => {
    routes[`PUT /v2/cob/${TXID}`] = () => ({ status: 201, body: activeCob });
    const charge = await efiProvider.createCharge(chargeRequest());
    expect(charge).toEqual({ chargeId: TXID, status: "pending", amountCents: 1350, paidAt: null, pixCopyPaste: "000201EFI", pixQrPngBase64: null });
    await efiProvider.createCharge(chargeRequest());
    expect(calls.filter((c) => c.path === "/oauth/token")).toHaveLength(1);
    const oauth = calls.find((c) => c.path === "/oauth/token")!;
    expect(oauth.headers.authorization).toBe(`Basic ${Buffer.from("Client_Id_test:Client_Secret_test").toString("base64")}`);
    expect(oauth.body).toEqual({ grant_type: "client_credentials" });
    const cob = calls.find((c) => c.method === "PUT")!;
    expect(cob.headers.authorization).toBe("Bearer tok-1");
    expect(cob.body).toMatchObject({ valor: { original: "13.50" }, chave: "chave-pix-escola", solicitacaoPagador: "Lanche escolar" });
    expect((cob.body as { calendario: { expiracao: number } }).calendario.expiracao).toBeGreaterThan(3500);
  });

  it("reuses an existing charge on 409", async () => {
    routes[`PUT /v2/cob/${TXID}`] = () => ({ status: 409, body: { nome: "txid_duplicado" } });
    routes[`GET /v2/cob/${TXID}`] = () => ({ status: 200, body: activeCob });
    expect((await efiProvider.createCharge(chargeRequest())).pixCopyPaste).toBe("000201EFI");
  });

  it("links the platform split before returning the Pix code", async () => {
    routes[`PUT /v2/cob/${TXID}`] = () => ({ status: 201, body: activeCob });
    routes[`PUT /v2/gn/split/cob/${TXID}/vinculo/${splitConfigIdFor(SCHOOL_ID)}`] = () => ({ status: 204, body: null });
    await efiProvider.createCharge(chargeRequest(1000));
    expect(calls.map((c) => `${c.method} ${c.path}`)).toContain(`PUT /v2/gn/split/cob/${TXID}/vinculo/${splitConfigIdFor(SCHOOL_ID)}`);
  });

  it("fails without leaking the response body and refreshes an expired token once", async () => {
    routes[`PUT /v2/cob/${TXID}`] = () => ({ status: 500, body: { detail: "secret detail" } });
    await expect(efiProvider.createCharge(chargeRequest())).rejects.toThrow(/^efi cob failed: 500$/);

    let first = true;
    routes[`PUT /v2/cob/${TXID}`] = () => {
      if (first) {
        first = false;
        return { status: 401, body: null };
      }
      return { status: 201, body: activeCob };
    };
    await efiProvider.createCharge(chargeRequest());
    expect(calls.filter((c) => c.path === "/oauth/token")).toHaveLength(2);
  });

  it("names the missing credential reference, never a value", async () => {
    await expect(efiProvider.createCharge({ ...chargeRequest(), accountRef: "EFI_MISSING_REF" })).rejects.toThrow(/EFI_MISSING_REF/);
  });
});

describe("efi getCharge and parseWebhook", () => {
  it("maps a concluded charge to paid with the gateway's time and amount", async () => {
    routes[`GET /v2/cob/${TXID}`] = () => ({ status: 200, body: paidCob });
    expect(await efiProvider.getCharge(TXID, REF)).toMatchObject({
      status: "paid",
      amountCents: 1350,
      paidAt: new Date("2030-03-04T10:00:00.000Z"),
    });
  });

  const hook = (body: unknown, token = SECRET) =>
    efiProvider.parseWebhook({ headers: {}, query: { token, ignorar: "/pix" }, rawBody: JSON.stringify(body), secret: SECRET, accountRef: REF });

  it("rejects a wrong token and accepts the registration ping", async () => {
    await expect(hook({ pix: [] }, "wrong-token-0123456789abcdefghijklmn")).rejects.toMatchObject({ code: "invalid_signature" });
    expect(await hook({ evento: "teste_webhook" })).toEqual([]);
  });

  it("trusts the charge lookup, not the notification body", async () => {
    routes[`GET /v2/cob/${TXID}`] = () => ({ status: 200, body: paidCob });
    const events = await hook({ pix: [{ endToEndId: "E123", txid: TXID, valor: "99.99", horario: "2020-01-01T00:00:00Z" }] });
    expect(events).toEqual([
      { eventId: "E123", kind: "charge_paid", chargeId: TXID, amountCents: 1350, paidAt: new Date("2030-03-04T10:00:00.000Z") },
    ]);
  });

  it("ignores payments without txid and charges not yet concluded", async () => {
    routes[`GET /v2/cob/${TXID}`] = () => ({ status: 200, body: activeCob });
    expect(await hook({ pix: [{ endToEndId: "E1", valor: "1.00" }, { endToEndId: "E2", txid: TXID, valor: "13.50" }] })).toEqual([
      { eventId: "E1", kind: "ignored", chargeId: null },
      { eventId: "E2", kind: "ignored", chargeId: TXID },
    ]);
  });

  it("ignores a malformed txid without calling Efí", async () => {
    const bad = ["../token", "abc", `${TXID}/devolucao`, "a".repeat(36), "txid com espaco 0123456789abc"];
    expect(await hook({ pix: bad.map((txid, i) => ({ endToEndId: `E${i}`, txid })) })).toEqual(
      bad.map((_, i) => ({ eventId: `E${i}`, kind: "ignored", chargeId: null })),
    );
    expect(calls).toEqual([]);
  });

  it("rejects a concluded charge whose pix time is not a valid date", async () => {
    routes[`GET /v2/cob/${TXID}`] = () => ({
      status: 200,
      body: { ...paidCob, pix: [{ ...paidCob.pix[0], horario: "not-a-date" }] },
    });
    await expect(efiProvider.getCharge(TXID, REF)).rejects.toThrow("efi returned an unexpected charge body");
    await expect(hook({ pix: [{ endToEndId: "E123", txid: TXID }] })).rejects.toThrow("efi returned an unexpected charge body");
  });

  it("uses the endToEndId from Efí's charge, not the notification's, as the event id", async () => {
    routes[`GET /v2/cob/${TXID}`] = () => ({ status: 200, body: paidCob });
    expect(await hook({ pix: [{ endToEndId: "E-FORGED", txid: TXID }] })).toEqual([
      { eventId: "E123", kind: "charge_paid", chargeId: TXID, amountCents: 1350, paidAt: new Date("2030-03-04T10:00:00.000Z") },
    ]);
  });
});
