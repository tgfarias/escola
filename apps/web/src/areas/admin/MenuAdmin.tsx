import { MenuItem, MenuItemListResponse } from "@app-lanche/contracts";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Alert, Button, Card, CardBody, CardHeader, Col, Form, FormGroup, Input, Label, Row, Table } from "reactstrap";
import { ApiError, apiFetch } from "../../app/api";
import { StatusBadge } from "../../theme/StatusBadge";
import { staffErrorMessage } from "../../ui/messages";
import { formatCents, parsePriceToCents } from "../../ui/money";

export function MenuAdmin() {
  const [items, setItems] = useState<MenuItem[]>([]);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const keyRef = useRef<string | null>(null);

  useEffect(() => {
    apiFetch("/api/admin/v1/menu-items", MenuItemListResponse).then(
      (res) => setItems(res.items),
      (err) => setError(staffErrorMessage(err instanceof ApiError ? err.code : "internal_error")),
    );
  }, []);

  async function add(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const priceCents = parsePriceToCents(price);
    if (priceCents === null) {
      setError("Preço inválido.");
      return;
    }
    setBusy(true);
    keyRef.current ??= crypto.randomUUID();
    try {
      const created = await apiFetch("/api/admin/v1/menu-items", MenuItem, {
        method: "POST",
        body: { name: name.trim(), priceCents },
        idempotencyKey: keyRef.current,
      });
      keyRef.current = null;
      setItems((prev) => [...prev, created]);
      setName("");
      setPrice("");
    } catch (err) {
      setError(staffErrorMessage(err instanceof ApiError ? err.code : "internal_error"));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(item: MenuItem) {
    setError(null);
    try {
      const updated = await apiFetch(`/api/admin/v1/menu-items/${item.id}`, MenuItem, {
        method: "PATCH",
        body: { active: !item.active },
      });
      setItems((prev) => prev.map((i) => (i.id === updated.id ? updated : i)));
    } catch (err) {
      setError(staffErrorMessage(err instanceof ApiError ? err.code : "internal_error"));
    }
  }

  return (
    <Card tag="section" id="cardapio" className="main-card mb-3">
      <CardHeader tag="h2" className="h6 mb-0">
        Cardápio
      </CardHeader>
      <CardBody>
        {items.length === 0 ? (
          <p>Nenhum item no cardápio.</p>
        ) : (
          <Table responsive hover striped className="mb-4">
            <thead>
              <tr>
                <th>Item</th>
                <th>Situação</th>
                <th>
                  <span className="visually-hidden">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td>{`${i.name} — ${formatCents(i.priceCents)}${i.active ? "" : " (inativo)"}`}</td>
                  <td>
                    <StatusBadge tone={i.active ? "success" : "secondary"}>{i.active ? "Ativo" : "Inativo"}</StatusBadge>
                  </td>
                  <td className="text-end">
                    <Button size="sm" outline color={i.active ? "secondary" : "primary"} type="button" onClick={() => toggle(i)}>
                      {i.active ? "Desativar" : "Ativar"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <Form onSubmit={add}>
          <h3 className="h6">Novo item</h3>
          <Row className="g-2 align-items-end">
            <Col md={6}>
              <FormGroup>
                <Label for="menu-name">Nome</Label>
                <Input
                  id="menu-name"
                  required
                  maxLength={80}
                  value={name}
                  onChange={(e) => {
                    keyRef.current = null;
                    setName(e.target.value);
                  }}
                />
              </FormGroup>
            </Col>
            <Col md={3}>
              <FormGroup>
                <Label for="menu-price">Preço (R$)</Label>
                <Input
                  id="menu-price"
                  required
                  inputMode="decimal"
                  value={price}
                  onChange={(e) => {
                    keyRef.current = null;
                    setPrice(e.target.value);
                  }}
                />
              </FormGroup>
            </Col>
            <Col md={3}>
              <FormGroup>
                <Button color="primary" type="submit" className="w-100" disabled={busy}>
                  Adicionar
                </Button>
              </FormGroup>
            </Col>
          </Row>
        </Form>
        {error && (
          <Alert color="danger" fade={false}>
            {error}
          </Alert>
        )}
      </CardBody>
    </Card>
  );
}
