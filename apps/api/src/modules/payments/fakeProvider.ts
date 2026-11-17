import { z } from "zod";
import { DomainError } from "../../platform/errors";
import { safeEqual } from "../../platform/hmac";
import type { Charge, ChargeRequest, PaymentProvider, WebhookEvent, WebhookInput } from "./provider";

type FakeCharge = { chargeId: string; amountCents: number; status: Charge["status"]; paidAt: Date | null };

const charges = new Map<string, FakeCharge>();
let failures = 0;

const FakeWebhook = z.object({
  id: z.string().min(1).max(100),
  event: z.string().min(1).max(50),
  charge_id: z.string().min(1).max(100).nullable(),
  amount_cents: z.number().int().positive().optional(),
  paid_at: z.string().datetime({ offset: true }).optional(),
});

function view(c: FakeCharge): Charge {
  return { ...c, pixCopyPaste: `00020101FAKE${c.chargeId}`, pixQrPngBase64: null };
}

function header(headers: Record<string, string | string[] | undefined>, name: string): string {
  const v = headers[name];
  return typeof v === "string" ? v : "";
}

/** Provedor de desenvolvimento e testes. Nunca habilitado em produção (ENABLE_FAKE_PAYMENTS). */
export const fakeProvider: PaymentProvider = {
  name: "fake",

  async createCharge(req: ChargeRequest): Promise<Charge> {
    if (failures > 0) {
      failures -= 1;
      throw new Error("fake gateway unavailable");
    }
    const chargeId = `fake_${req.paymentId}`;
    const existing = charges.get(chargeId);
    if (existing) return view(existing);
    const created: FakeCharge = { chargeId, amountCents: req.amountCents, status: "pending", paidAt: null };
    charges.set(chargeId, created);
    return view(created);
  },

  async getCharge(chargeId: string): Promise<Charge> {
    const c = charges.get(chargeId);
    if (!c) throw new Error("unknown fake charge");
    return view(c);
  },

  async parseWebhook({ headers, rawBody, secret }: WebhookInput): Promise<WebhookEvent[]> {
    if (!safeEqual(header(headers, "x-fake-token"), secret)) throw new DomainError("invalid_signature");
    let parsed: z.infer<typeof FakeWebhook>;
    try {
      parsed = FakeWebhook.parse(JSON.parse(rawBody));
    } catch {
      throw new DomainError("validation_failed");
    }
    if (parsed.event !== "charge.paid") return [{ eventId: parsed.id, kind: "ignored", chargeId: parsed.charge_id }];
    if (!parsed.charge_id || parsed.amount_cents === undefined || parsed.paid_at === undefined) {
      throw new DomainError("validation_failed");
    }
    return [
      {
        eventId: parsed.id,
        kind: "charge_paid",
        chargeId: parsed.charge_id,
        amountCents: parsed.amount_cents,
        paidAt: new Date(parsed.paid_at),
      },
    ];
  },
};

export function fakeMarkPaid(chargeId: string, paidAt: Date): void {
  const c = charges.get(chargeId);
  if (!c) throw new Error("unknown fake charge");
  c.status = "paid";
  c.paidAt = paidAt;
}

export function fakeFailNextCreate(times = 1): void {
  failures = times;
}

export function fakeReset(): void {
  charges.clear();
  failures = 0;
}
