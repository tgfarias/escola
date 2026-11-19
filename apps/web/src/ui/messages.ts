const MESSAGES: Record<string, string> = {
  invalid_token: "Este link expirou. Peça um novo pelo WhatsApp da escola.",
  otp_invalid: "Código incorreto. Confira e tente de novo.",
  otp_expired: "Este código expirou. Abra o link novamente para receber outro.",
  otp_too_many_attempts: "Muitas tentativas. Aguarde alguns minutos e abra o link novamente.",
  unauthenticated: "Sua sessão expirou. Abra o link novamente.",
  insufficient_scope: "Você não tem acesso a esta área.",
  cutoff_passed: "O horário de pedidos para este dia já encerrou.",
  order_already_exists: "Já existe um pedido para este aluno neste dia.",
  invalid_order: "Não foi possível montar o pedido. Atualize a página e tente de novo.",
  checkout_not_cancellable: "Este pedido não pode mais ser cancelado.",
  not_found: "Não encontramos este pedido.",
  network_error: "Sem conexão. Verifique a internet e tente de novo.",
  wallet_no_debt: "Não há débito para pagar.",
};

export function errorMessage(code: string): string {
  return MESSAGES[code] ?? "Algo deu errado. Tente de novo em instantes.";
}

const STAFF_MESSAGES: Record<string, string> = {
  otp_expired: "Este código expirou. Peça um novo código.",
  otp_too_many_attempts: "Muitas tentativas. Aguarde alguns minutos e peça um novo código.",
  unauthenticated: "Sua sessão expirou. Entre novamente.",
  cutoff_passed: "O horário de corte deste dia já passou.",
  service_day_locked: "Este dia já tem pedidos ou está fechado; o cardápio não pode mudar.",
  service_day_open: "O dia só pode ser fechado depois do horário de corte.",
  menu_item_name_taken: "Já existe um item com esse nome.",
  validation_failed: "Confira os dados e tente de novo.",
  not_found: "Não encontrado. Atualize a página.",
  document_template_invalid: "O modelo usa variáveis que não existem. Corrija as marcadas abaixo.",
  document_template_outdated: "Este modelo foi alterado por outra pessoa. Recarregue a página para editar a versão mais recente.",
  document_missing_data: "Faltam dados de alguns alunos ou responsáveis. Corrija em Alunos e responsáveis e tente de novo.",
  document_batch_not_ready: "Ainda há documentos sem PDF. Aguarde a geração ou descarte os que falharam.",
  document_batch_published: "Este lote já foi publicado.",
  insufficient_balance: "Saldo insuficiente: o lançamento passa do limite de débito.",
  wallet_no_debt: "Este responsável não tem débito.",
  invalid_order: "Aluno ou item indisponível. Atualize a página e tente de novo.",
  request_rejected: "Não foi possível concluir esta ação. Atualize a página e tente de novo.",
};

export function staffErrorMessage(code: string): string {
  return STAFF_MESSAGES[code] ?? errorMessage(code);
}
