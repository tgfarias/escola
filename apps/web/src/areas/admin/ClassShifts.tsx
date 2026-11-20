import { SHIFTS, type ClassListResponse, type Shift } from "@app-lanche/contracts";
import { useState } from "react";
import { Card, CardBody, CardHeader, Input, Table } from "reactstrap";
import { z } from "zod";
import { apiFetch } from "../../app/api";
import { announce } from "../../theme/notify";
import { SHIFT_LABELS } from "../../ui/shifts";

type Props = { classes: ClassListResponse["classes"]; onChanged: () => Promise<void>; onError: (err: unknown) => void };

/** Turno de cada turma (spec F5C, B.1). Mudar não move pedidos já feitos. */
export function ClassShifts({ classes, onChanged, onError }: Props) {
  const [busy, setBusy] = useState<string | null>(null);

  async function change(id: string, name: string, shift: Shift) {
    setBusy(id);
    try {
      await apiFetch(`/api/admin/v1/classes/${id}/shift`, z.undefined(), { method: "PUT", body: { shift } });
      announce(`${name}: turno da ${SHIFT_LABELS[shift].toLowerCase()}.`);
      await onChanged();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(null);
    }
  }

  if (classes.length === 0) return null;
  return (
    <Card tag="section" className="main-card mb-3">
      <CardHeader tag="h2" className="h6 mb-0">
        Turmas e turnos
      </CardHeader>
      <CardBody>
        <Table responsive hover striped className="mb-0">
          <thead>
            <tr>
              <th>Turma</th>
              <th>Turno</th>
            </tr>
          </thead>
          <tbody>
            {classes.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td>
                  <Input
                    type="select"
                    aria-label={`Turno de ${c.name}`}
                    value={c.shift}
                    disabled={busy === c.id}
                    onChange={(e) => void change(c.id, c.name, e.target.value as Shift)}
                  >
                    {SHIFTS.map((s) => (
                      <option key={s} value={s}>
                        {SHIFT_LABELS[s]}
                      </option>
                    ))}
                  </Input>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </CardBody>
    </Card>
  );
}
