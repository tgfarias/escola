import { z } from "zod";
import { DomainError } from "../../../platform/errors";
import { safeEqual } from "../../../platform/hmac";
import type { Charge, ChargeRequest, PaymentProvider, WebhookEvent, WebhookInput } from "../provider";
import { efiCall, loadCredentials } from "./client";
import { centsToReais, reaisToCents } from "./money";

export const txidFor = (paymentId: string): string => paymentId.replace(/-/g, "");
export const splitConfigIdFor = (schoolId: string): string => `sp${schoolId.replace(/-/g, "")}`;

const Cob = z.object({
  txid: z.string(),
  status: z.string(),
  valor: z.object({ original: z.string() }),
  pixCopiaECola: z.string().optional(),
  pix: z.array(z.object({ endToEndId: z.string(), valor: z.string(), horario: z.string() })).optional(),
});
type Cob = z.infer<typeof Cob>;

const Notification = z.object({
  pix: z.array(z.object({ endToEndId: z.string().min(1), txid: z.string().optional() })).optional(),
});

const is2xx = (status: number) => status >= 200 && status < 300;

function credentialsFor(accountRef: string | null) {
  if (!accountRef) throw new Error("school has no payment account reference");
  return loadCredentials(accountRef);
}

function toCharge(cob: Cob): Charge {
  const base = { chargeId: cob.txid, pixCopyPaste: cob.pixCopiaECola ?? null, pixQrPngBase64: null };
  if (cob.status === "ATIVA") return { ...base, status: "pending", amountCents: reaisToCents(cob.valor.original), paidAt: null };
  if (cob.status === "CONCLUIDA") {
    const pix = cob.pix?.[0];
    if (!pix) throw new Error("efi concluded charge without pix");
    return { ...base, status: "paid", amountCents: reaisToCents(pix.valor), paidAt: new Date(pix.horario) };
  }
  if (cob.status === "REMOVIDA_PELO_USUARIO_RECEBEDOR" || cob.status === "REMOVIDA_PELO_PSP") {
    return { ...base, status: "expired", amountCents: reaisToCents(cob.valor.original), paidAt: null };
  }
  throw new Error("efi charge in unknown status");
}

function parseCob(body: unknown): Cob {
  const parsed = Cob.safeParse(body);
  if (!parsed.success) throw new Error("efi returned an unexpected charge body");
  return parsed.data;
}

export const efiProvider: PaymentProvider = {
  name: "efi",

  async createCharge(req: ChargeRequest): Promise<Charge> {
    const c = credentialsFor(req.accountRef);
    const txid = txidFor(req.paymentId);
    const expiracao = Math.max(60, Math.floor((req.expiresAt.getTime() - Date.now()) / 1000));
    const put = await efiCall(c, "PUT", `/v2/cob/${txid}`, {
      calendario: { expiracao },
      valor: { original: centsToReais(req.amountCents) },
      chave: c.pix_key,
      solicitacaoPagador: req.description,
    });
    let cob: Cob;
    if (is2xx(put.status)) cob = parseCob(put.body);
    else if (put.status === 409) {
      const got = await efiCall(c, "GET", `/v2/cob/${txid}`);
      if (!is2xx(got.status)) throw new Error(`efi cob failed: ${got.status}`);
      cob = parseCob(got.body);
    } else throw new Error(`efi cob failed: ${put.status}`);
    if (cob.valor.original !== centsToReais(req.amountCents)) throw new Error("efi charge amount differs");

    if (req.platformFeeBps > 0) {
      const link = await efiCall(c, "PUT", `/v2/gn/split/cob/${txid}/vinculo/${splitConfigIdFor(req.schoolId)}`);
      if (!is2xx(link.status)) throw new Error(`efi split link failed: ${link.status}`);
    }
    return toCharge(cob);
  },

  async getCharge(chargeId: string, accountRef: string | null): Promise<Charge> {
    const res = await efiCall(credentialsFor(accountRef), "GET", `/v2/cob/${chargeId}`);
    if (!is2xx(res.status)) throw new Error(`efi cob lookup failed: ${res.status}`);
    return toCharge(parseCob(res.body));
  },

  /** A Efí não assina a notificação: exige o token da URL e confirma cada cobrança consultando a própria Efí. */
  async parseWebhook({ query, rawBody, secret, accountRef }: WebhookInput): Promise<WebhookEvent[]> {
    if (!safeEqual(query.token ?? "", secret)) throw new DomainError("invalid_signature");
    let parsed: z.infer<typeof Notification>;
    try {
      parsed = Notification.parse(JSON.parse(rawBody));
    } catch {
      throw new DomainError("validation_failed");
    }
    const events: WebhookEvent[] = [];
    for (const item of parsed.pix ?? []) {
      if (!item.txid) {
        events.push({ eventId: item.endToEndId, kind: "ignored", chargeId: null });
        continue;
      }
      const charge = await efiProvider.getCharge(item.txid, accountRef);
      events.push(
        charge.status === "paid" && charge.paidAt
          ? { eventId: item.endToEndId, kind: "charge_paid", chargeId: item.txid, amountCents: charge.amountCents, paidAt: charge.paidAt }
          : { eventId: item.endToEndId, kind: "ignored", chargeId: item.txid },
      );
    }
    return events;
  },
};
