import { toast } from "react-toastify";

/** Aviso de sucesso visível (toast). O mesmo texto vai num <StatusNotice> da página, para leitores de tela. */
export function announce(message: string): void {
  toast.success(message, { toastId: message });
}

/** Região role="status" sempre presente; o texto fica só para leitores de tela (o toast é a parte visível). */
export function StatusNotice({ message }: { message: string | null }) {
  return (
    <p role="status" className="visually-hidden">
      {message ?? ""}
    </p>
  );
}
