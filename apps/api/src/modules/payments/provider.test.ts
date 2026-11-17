import { afterEach, describe, expect, it } from "vitest";
import { fakeFailNextCreate, fakeMarkPaid, fakeProvider, fakeReset } from "./fakeProvider";
import { defaultProviderName, getProvider } from "./registry";

const SECRET = "s".repeat(40);
const req = (paymentId = "0193a3b0-0000-7000-8000-000000000001") => ({
  paymentId,
  schoolId: "0193a3b0-0000-7000-8000-000000000002",
  amountCents: 1350,
  expiresAt: new Date("2030-03-04T10:30:00Z"),
  description: "Lanche 2030-03-04",
  accountRef: null,
  platformFeeBps: 0,
});

afterEach(() => fakeReset());

describe("fake provider", () => {
  it("creates one charge per payment id and reports it", async () => {
    const a = await fakeProvider.createCharge(req());
    const b = await fakeProvider.createCharge(req());
    expect(b).toEqual(a);
    expect(a).toMatchObject({ status: "pending", amountCents: 1350, paidAt: null });
    expect(a.pixCopyPaste).toContain(a.chargeId);
    fakeMarkPaid(a.chargeId, new Date("2030-03-04T10:00:00Z"));
    expect(await fakeProvider.getCharge(a.chargeId, null)).toMatchObject({ status: "paid", paidAt: new Date("2030-03-04T10:00:00Z") });
  });

  it("can simulate an unavailable gateway", async () => {
    fakeFailNextCreate();
    await expect(fakeProvider.createCharge(req())).rejects.toThrow();
    await expect(fakeProvider.createCharge(req())).resolves.toMatchObject({ status: "pending" });
  });

  const hook = (rawBody: string, headers: Record<string, string> = { "x-fake-token": SECRET }) =>
    fakeProvider.parseWebhook({ headers, query: {}, rawBody, secret: SECRET, accountRef: null });

  it("parses a paid webhook with the right token", async () => {
    const rawBody = JSON.stringify({ id: "evt-1", event: "charge.paid", charge_id: "fake_x", amount_cents: 1350, paid_at: "2030-03-04T10:00:00Z" });
    expect(await hook(rawBody)).toEqual([
      { eventId: "evt-1", kind: "charge_paid", chargeId: "fake_x", amountCents: 1350, paidAt: new Date("2030-03-04T10:00:00Z") },
    ]);
  });

  it("ignores other events and rejects a wrong token or a bad body", async () => {
    const other = JSON.stringify({ id: "evt-2", event: "charge.created", charge_id: "fake_x" });
    expect(await hook(other)).toEqual([{ eventId: "evt-2", kind: "ignored", chargeId: "fake_x" }]);
    await expect(hook(other, { "x-fake-token": "nope" })).rejects.toMatchObject({ code: "invalid_signature" });
    await expect(hook(other, {})).rejects.toMatchObject({ code: "invalid_signature" });
    const bad = JSON.stringify({ id: "evt-3", event: "charge.paid", charge_id: "fake_x" });
    await expect(hook(bad)).rejects.toMatchObject({ code: "validation_failed" });
  });
});

describe("provider registry", () => {
  it("returns the fake provider when enabled", () => {
    expect(defaultProviderName()).toBe("fake");
    expect(getProvider("fake")).toBe(fakeProvider);
    expect(() => getProvider("asaas")).toThrow(expect.objectContaining({ code: "not_found" }));
  });
});
