import { StaffOtpRequestResponse, StaffOtpVerifyResponse } from "@app-lanche/contracts";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { Alert, Button, Card, CardBody, Form, FormGroup, Input, Label } from "reactstrap";
import { ApiError, apiFetch } from "../../app/api";
import { LOGO_ALT, LOGO_URL, PRODUCT_NAME } from "../../theme/brand";
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

  const errorAlert = error && (
    <Alert color="danger" fade={false}>
      {error}
    </Alert>
  );

  return (
    <main className="app-login">
      <Card className="main-card">
        <CardBody className="p-4">
          <img className="app-login__logo" src={LOGO_URL} alt={LOGO_ALT} />
          <h1 className="h4 text-center mb-1">Área da escola</h1>
          <p className="text-center mb-4">{PRODUCT_NAME}</p>
          {otpToken === null ? (
            <Form onSubmit={requestCode}>
              <FormGroup>
                <Label for="email">E-mail</Label>
                <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
              </FormGroup>
              {errorAlert}
              <Button color="primary" type="submit" className="w-100" disabled={busy}>
                Enviar código
              </Button>
            </Form>
          ) : (
            <>
              <p>Se o e-mail estiver cadastrado, você receberá um código em instantes.</p>
              <Form onSubmit={verify}>
                <FormGroup>
                  <Label for="code">Código de 6 dígitos</Label>
                  <Input
                    id="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="\d{6}"
                    maxLength={6}
                    required
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                  />
                </FormGroup>
                {errorAlert}
                <Button color="primary" type="submit" className="w-100 mb-2" disabled={busy}>
                  Entrar
                </Button>
                <Button
                  color="link"
                  type="button"
                  className="w-100"
                  onClick={() => {
                    setOtpToken(null);
                    setCode("");
                    setError(null);
                  }}
                >
                  Usar outro e-mail
                </Button>
              </Form>
            </>
          )}
        </CardBody>
      </Card>
    </main>
  );
}
