import type { WalletEntryKind } from "@app-lanche/contracts";

export const ENTRY_LABELS: Record<WalletEntryKind, string> = {
  checkout_hold: "Usado em pedido",
  hold_release: "Devolução de saldo reservado",
  late_payment_credit: "Pagamento após o horário",
  cancel_credit: "Pedido cancelado",
  refund: "Reembolso",
  manual_adjustment: "Ajuste da escola",
  counter_charge: "Lanche no balcão",
  counter_void: "Estorno de lanche no balcão",
  topup_credit: "Recarga por Pix",
};

/** "Lanche no balcão — Bia" quando a entrada é de um aluno. */
export function entryLabel(kind: WalletEntryKind, studentFirstName: string | null): string {
  return studentFirstName ? `${ENTRY_LABELS[kind]} — ${studentFirstName}` : ENTRY_LABELS[kind];
}
