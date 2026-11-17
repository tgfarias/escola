const MESSAGES: Record<string, string> = {
  invalid_token: "Este link expirou. Peça um novo pelo WhatsApp da escola.",
  otp_invalid: "Código incorreto. Confira e tente de novo.",
  otp_expired: "Este código expirou. Abra o link novamente para receber outro.",
  otp_too_many_attempts: "Muitas tentativas. Abra o link novamente para receber outro código.",
  unauthenticated: "Sua sessão expirou. Abra o link novamente.",
  insufficient_scope: "Você não tem acesso a esta área.",
  network_error: "Sem conexão. Verifique a internet e tente de novo.",
};

export function errorMessage(code: string): string {
  return MESSAGES[code] ?? "Algo deu errado. Tente de novo em instantes.";
}
