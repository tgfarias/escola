import { describe, expect, it } from "vitest";
import { OutboxEnvelope, OutboxEvent } from "./events";

describe("outbox event contracts", () => {
  it("accepts the payment.late_credited example from spec 6.3", () => {
    const example = {
      id: "0193a3b0-0000-7000-8000-000000000001",
      type: "payment.late_credited",
      school_id: "0193a3b0-0000-7000-8000-000000000002",
      occurred_at: "2026-11-17T07:32:10-03:00",
      data: {
        guardian_id: "0193a3b0-0000-7000-8000-000000000003",
        phone: "+5511999990000",
        first_name: "Ana",
        amount_cents: 1800,
        wallet_balance_cents: 1800,
      },
    };
    expect(OutboxEnvelope.parse(example)).toEqual(example);
    expect(OutboxEvent.parse({ type: example.type, data: example.data })).toEqual({ type: example.type, data: example.data });
  });

  it("accepts the document.published example from spec 6.3", () => {
    const example = {
      id: "0193a3b0-0000-7000-8000-000000000011",
      type: "document.published",
      school_id: "0193a3b0-0000-7000-8000-000000000002",
      occurred_at: "2026-11-18T10:15:00-03:00",
      data: {
        guardian_id: "0193a3b0-0000-7000-8000-000000000003",
        phone: "+5511999990000",
        first_name: "Ana",
        batch_id: "0193a3b0-0000-7000-8000-000000000012",
        template_name: "Autorização de passeio",
        students: ["Bia", "Léo"],
      },
    };
    expect(OutboxEnvelope.parse(example)).toEqual(example);
    expect(OutboxEvent.parse({ type: example.type, data: example.data })).toEqual({ type: example.type, data: example.data });
    expect(OutboxEvent.safeParse({ type: example.type, data: { ...example.data, students: [] } }).success).toBe(false);
  });

  it("accepts the wallet event examples from spec 6.3", () => {
    const base = { school_id: "0193a3b0-0000-7000-8000-000000000002", occurred_at: "2026-11-19T10:05:00-03:00" };
    const contact = { guardian_id: "0193a3b0-0000-7000-8000-000000000003", phone: "+5511999990000", first_name: "Ana" };
    const examples = [
      { ...base, id: "0193a3b0-0000-7000-8000-000000000021", type: "wallet.debt_notice", data: { ...contact, amount_due_cents: 1350 } },
      { ...base, id: "0193a3b0-0000-7000-8000-000000000022", type: "wallet.payment_requested", data: { ...contact, amount_due_cents: 1350 } },
      { ...base, id: "0193a3b0-0000-7000-8000-000000000023", type: "wallet.topup_confirmed", data: { ...contact, amount_cents: 5000, wallet_balance_cents: 3650 } },
    ];
    for (const e of examples) {
      expect(OutboxEnvelope.parse(e)).toEqual(e);
      expect(OutboxEvent.parse({ type: e.type, data: e.data })).toEqual({ type: e.type, data: e.data });
    }
    expect(OutboxEvent.safeParse({ type: "wallet.debt_notice", data: { ...contact, amount_due_cents: 0 } }).success).toBe(false);
    expect(
      OutboxEvent.parse({ type: "payment.late_credited", data: { ...contact, amount_cents: 900, wallet_balance_cents: -300 } }).type,
    ).toBe("payment.late_credited");
  });

  it("rejects a payment.confirmed event without students", () => {
    const result = OutboxEvent.safeParse({
      type: "payment.confirmed",
      data: {
        guardian_id: "0193a3b0-0000-7000-8000-000000000003",
        phone: "+5511999990000",
        first_name: "Ana",
        checkout_id: "0193a3b0-0000-7000-8000-000000000004",
        service_date: "2026-11-17",
        students: [],
        total_cents: 900,
      },
    });
    expect(result.success).toBe(false);
  });
});
