import { ExchangeResponse, OtpVerifyResponse, type GuardianScope } from "@app-lanche/contracts";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { ApiError, apiFetch } from "../../app/api";
import { errorMessage } from "../../ui/messages";
import { getDeviceSecret } from "./device";

type State =
  | { step: "loading" }
  | { step: "otp"; otpToken: string; error?: string; busy: boolean }
  | { step: "error"; message: string };

const DESTINATION: Record<GuardianScope, string> = { order: "/pedido", documents: "/documentos" };

function codeOf(err: unknown): string {
  return err instanceof ApiError ? err.code : "internal_error";
}

export function LinkLanding() {
  const navigate = useNavigate();
  const started = useRef(false);
  const [state, setState] = useState<State>({ step: "loading" });
  const [code, setCode] = useState("");

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = window.location.hash.slice(1);
    window.history.replaceState(null, "", window.location.pathname);
    if (!token) {
      setState({ step: "error", message: errorMessage("invalid_token") });
      return;
    }
    apiFetch("/api/v1/auth/exchange", ExchangeResponse, {
      method: "POST",
      body: { token, deviceSecret: getDeviceSecret() },
    }).then(
      (res) => {
        if (res.status === "ok") navigate(DESTINATION[res.scope], { replace: true });
        else setState({ step: "otp", otpToken: res.otpToken, busy: false });
      },
      (err) => setState({ step: "error", message: errorMessage(codeOf(err)) }),
    );
  }, [navigate]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (state.step !== "otp") return;
    setState({ ...state, busy: true, error: undefined });
    try {
      const res = await apiFetch("/api/v1/auth/otp/verify", OtpVerifyResponse, {
        method: "POST",
        body: { otpToken: state.otpToken, code },
      });
      navigate(DESTINATION[res.scope], { replace: true });
    } catch (err) {
      const errorCode = codeOf(err);
      if (errorCode === "otp_invalid" || errorCode === "network_error") {
        setState({ ...state, busy: false, error: errorMessage(errorCode) });
      } else {
        setState({ step: "error", message: errorMessage(errorCode) });
      }
    }
  }

  if (state.step === "loading") return <main><p>Abrindo…</p></main>;
  if (state.step === "error") return <main><p role="alert">{state.message}</p></main>;

  return (
    <main>
      <h1>Confirme que é você</h1>
      <p>Enviamos um código para o seu WhatsApp, porque este aparelho ainda não foi usado.</p>
      <form onSubmit={submit}>
        <label htmlFor="otp">Código de 6 dígitos</label>
        <input
          id="otp"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
          required
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        {state.error && <p role="alert">{state.error}</p>}
        <button type="submit" disabled={state.busy}>Confirmar</button>
      </form>
    </main>
  );
}
