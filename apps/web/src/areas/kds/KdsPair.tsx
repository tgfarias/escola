import { useState, type FormEvent } from "react";
import { Alert, Button, Card, CardBody, Form, FormGroup, Input, Label } from "reactstrap";
import { ApiError } from "../../app/api";
import { LOGO_ALT, LOGO_URL, PRODUCT_NAME } from "../../theme/brand";
import * as sync from "./sync";

export function KdsPair({ onPaired, disconnected = false }: { onPaired: () => void; disconnected?: boolean }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await sync.pair(code);
      onPaired();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 0
          ? "Sem conexão. O pareamento precisa de internet."
          : "Código inválido ou vencido. Peça um novo código à secretaria.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="kds-pair">
      <Card className="main-card">
        <CardBody className="p-4">
          <img className="kds-pair__logo" src={LOGO_URL} alt={LOGO_ALT} />
          <h1 className="h4 text-center mb-1">Parear tablet da cozinha</h1>
          <p className="text-center mb-4">{PRODUCT_NAME}</p>
          {disconnected && (
            <Alert color="warning" fade={false}>
              Este tablet foi desconectado. Peça um novo código à secretaria; as entregas ainda não enviadas serão mantidas.
            </Alert>
          )}
          <Form onSubmit={submit}>
            <FormGroup>
              <Label for="kds-pair-code">Código de pareamento</Label>
              <Input
                id="kds-pair-code"
                data-testid="kds-pair-code"
                className="kds-pair__code"
                bsSize="lg"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoCapitalize="characters"
                maxLength={8}
              />
            </FormGroup>
            <Button data-testid="kds-pair-submit" color="primary" size="lg" type="submit" className="w-100" disabled={busy || code.trim().length !== 8}>
              Parear
            </Button>
          </Form>
          {error && (
            <Alert color="danger" fade={false} className="mt-3 mb-0">
              {error}
            </Alert>
          )}
        </CardBody>
      </Card>
    </main>
  );
}
