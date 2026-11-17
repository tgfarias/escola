export interface ChargeRequest {
  paymentId: string; // chave de idempotência no gateway
  schoolId: string;
  amountCents: number;
  expiresAt: Date;
  description: string; // sem dado pessoal
  accountRef: string | null; // schools.payment_account_ref (subconta)
  platformFeeBps: number; // split da plataforma
}
export type ChargeStatus = "pending" | "paid" | "expired";
export interface Charge {
  chargeId: string;
  status: ChargeStatus;
  amountCents: number;
  paidAt: Date | null;
  pixCopyPaste: string | null;
  pixQrPngBase64: string | null;
}
export type WebhookEvent =
  | { eventId: string; kind: "charge_paid"; chargeId: string; amountCents: number; paidAt: Date }
  | { eventId: string; kind: "ignored"; chargeId: string | null };
export interface WebhookInput {
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | undefined>;
  rawBody: string;
  secret: string; // segredo de webhook da escola
  accountRef: string | null; // schools.payment_account_ref, para o provedor consultar o gateway
}
export interface PaymentProvider {
  readonly name: string;
  createCharge(req: ChargeRequest): Promise<Charge>;
  getCharge(chargeId: string, accountRef: string | null): Promise<Charge>;
  /**
   * Valida a autenticidade com o segredo da escola (lança DomainError("invalid_signature")) e devolve os eventos
   * da notificação (pode ser vários, ou nenhum). Roda fora de transação: um provedor que não assina o corpo
   * (Efí) consulta a cobrança no gateway aqui e só devolve `charge_paid` com valor e horário vindos do gateway.
   */
  parseWebhook(input: WebhookInput): Promise<WebhookEvent[]>;
}
