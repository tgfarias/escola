import { useCallback, useRef } from "react";

/**
 * Idempotency-Key de uma ação do usuário. A chave fica guardada enquanto a entrada é a mesma e a ação não deu certo:
 * repetir depois de uma falha (rede, 500) reaproveita a chave e não cria um segundo registro. Depois do sucesso, ou com
 * outra entrada, nasce uma chave nova. `once` ignora um segundo clique enquanto o primeiro ainda está no ar.
 */
export function useRequestKey() {
  const held = useRef<{ input: string; key: string } | null>(null);
  const inFlight = useRef(false);

  const keyFor = useCallback((input: unknown) => {
    const fingerprint = JSON.stringify(input);
    if (held.current?.input !== fingerprint) held.current = { input: fingerprint, key: crypto.randomUUID() };
    return held.current.key;
  }, []);

  const succeeded = useCallback(() => {
    held.current = null;
  }, []);

  const once = useCallback(async (action: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      await action();
    } finally {
      inFlight.current = false;
    }
  }, []);

  return { keyFor, succeeded, once };
}
