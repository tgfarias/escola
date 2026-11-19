import { useCallback, useState } from "react";
import { useNavigate } from "react-router";
import { ApiError } from "../../app/api";
import { staffErrorMessage } from "../../ui/messages";

/** Erro numa tela da equipe: sessão vencida leva ao login; o resto vira mensagem. */
export function useStaffErrors() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const fail = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 401) {
        navigate("/admin/login", { replace: true });
        return;
      }
      setError(staffErrorMessage(err instanceof ApiError ? err.code : "internal_error"));
    },
    [navigate],
  );
  return { error, setError, fail };
}
