import { StaffOtpRequestResponse, StaffOtpVerifyResponse } from "@app-lanche/contracts";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { ApiError, apiFetch } from "../../app/api";
import { staffErrorMessage } from "../../ui/messages";

export function AdminLogin() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [otpToken, setOtpToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(staffErrorMessage(err instanceof ApiError ? err.code : "internal_error"));
    } finally {
      setBusy(false);
    }
  }

  function requestCode(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const res = await apiFetch("/api/admin/v1/auth/otp/request", StaffOtpRequestResponse, {
        method: "POST",
        body: { email: email.trim() },
      });
      setOtpToken(res.otpToken);
    });
  }

  function verify(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      await apiFetch("/api/admin/v1/auth/otp/verify", StaffOtpVerifyResponse, {
        method: "POST",
        body: { otpToken, code: code.trim() },
      });
      navigate("/admin", { replace: true });
    });
  }

  if (otpToken === null) {
    return (
      <main>
        <h1>Área da escola</h1>
        <form onSubmit={requestCode}>
          <label htmlFor="email">E-mail</label>
          <input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          {error && <p role="alert">{error}</p>}
          <button type="submit" disabled={busy}>Enviar código</button>
        </form>
      </main>
    );
  }

  return (
    <main>
      <h1>Área da escola</h1>
      <p>Se o e-mail estiver cadastrado, você receberá um código em instantes.</p>
      <form onSubmit={verify}>
        <label htmlFor="code">Código de 6 dígitos</label>
        <input
          id="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
          required
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={busy}>Entrar</button>
        <button
          type="button"
          onClick={() => {
            setOtpToken(null);
            setCode("");
            setError(null);
          }}
        >
          Usar outro e-mail
        </button>
      </form>
    </main>
  );
}
