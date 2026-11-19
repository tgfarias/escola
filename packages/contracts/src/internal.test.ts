import { describe, expect, it } from "vitest";
import {
  DeliveriesRequest,
  InternalMagicLinkRequest,
  InternalMagicLinkResponse,
  RemindersPrepareRequest,
  RemindersPrepareResponse,
  ScheduleDueResponse,
} from "./internal";

const G = "0193a3b0-0000-7000-8000-000000000001";

describe("internal contracts", () => {
  it("accepts the magic-link examples from spec 6.2", () => {
    const req = { guardian_id: G, scope: "order", service_date: "2026-11-17" };
    expect(InternalMagicLinkRequest.parse(req)).toEqual(req);
    const res = { link_url: "https://app.example/l#Zk3", expires_at: "2026-11-17T07:30:00-03:00" };
    expect(InternalMagicLinkResponse.parse(res)).toEqual(res);
  });

  it("rejects a school_id in the body and a date on document links", () => {
    expect(() => InternalMagicLinkRequest.parse({ school_id: G, guardian_id: G, scope: "order", service_date: "2026-11-17" })).toThrow();
    expect(() => InternalMagicLinkRequest.parse({ guardian_id: G, scope: "documents", service_date: "2026-11-17" })).toThrow();
    expect(() => InternalMagicLinkRequest.parse({ guardian_id: G, scope: "order" })).toThrow();
    expect(InternalMagicLinkRequest.parse({ guardian_id: G, scope: "wallet" })).toEqual({ guardian_id: G, scope: "wallet" });
    expect(() => InternalMagicLinkRequest.parse({ guardian_id: G, scope: "wallet", service_date: "2026-11-17" })).toThrow();
  });

  it("accepts the schedule example from spec 6.2", () => {
    const example = {
      due: [
        { action: "send_reminders", school_id: G, service_date: "2026-11-17" },
        { action: "close_service_day", school_id: G, service_date: "2026-11-17" },
        { action: "send_debt_notices", school_id: G, service_date: "2026-11-17" },
      ],
    };
    expect(ScheduleDueResponse.parse(example)).toEqual(example);
  });

  it("does not expose the top-up reconciliation to n8n", () => {
    expect(() => ScheduleDueResponse.parse({ due: [{ action: "reconcile_topups", school_id: G, service_date: "2026-11-17" }] })).toThrow();
  });

  it("accepts a negative wallet balance in reminders", () => {
    const r = { guardian_id: G, phone: "+5511999990000", first_name: "Ana", students: ["Léo"], link_url: "https://app.example/l#Zk3", wallet_balance_cents: -1200, cutoff_at: "2026-11-17T07:30:00-03:00", cutoff_local_time: "07:30" };
    expect(RemindersPrepareResponse.parse({ batch_id: G, next_cursor: null, recipients: [r] }).recipients[0]!.wallet_balance_cents).toBe(-1200);
  });

  it("accepts the reminder examples from spec 6.2", () => {
    const req = { service_date: "2026-11-17", cursor: null };
    expect(RemindersPrepareRequest.parse(req)).toEqual(req);
    const res = {
      batch_id: G,
      next_cursor: null,
      recipients: [
        {
          guardian_id: G,
          phone: "+5511999990000",
          first_name: "Ana",
          students: ["Léo", "Bia"],
          link_url: "https://app.example/l#Zk3",
          wallet_balance_cents: 1200,
          cutoff_at: "2026-11-17T07:30:00-03:00",
          cutoff_local_time: "07:30",
        },
      ],
    };
    expect(RemindersPrepareResponse.parse(res)).toEqual(res);
    const deliveries = {
      results: [
        { guardian_id: G, status: "sent", wa_message_id: "wamid.X" },
        { guardian_id: G, status: "failed", error: "invalid_number" },
      ],
    };
    expect(DeliveriesRequest.parse(deliveries)).toEqual(deliveries);
  });

  it("rejects a free-text delivery error", () => {
    expect(() => DeliveriesRequest.parse({ results: [{ guardian_id: G, status: "failed", error: "Número inválido +55" }] })).toThrow();
  });
});
