import {
  CheckoutListResponse,
  SHIFTS,
  type GuardianServiceDay,
  type MeResponse,
} from "@app-lanche/contracts";
import { useEffect, useState } from "react";
import { ApiError, apiFetch } from "../../app/api";
import { errorMessage } from "../../ui/messages";
import { ShiftOrder } from "./ShiftOrder";

const ACTIVE = new Set(["pending", "confirmed", "delivered"]);

export function DayOrder({ day, me }: { day: GuardianServiceDay; me: MeResponse }) {
  const [ordered, setOrdered] = useState<Map<string, string>>(new Map()); // studentId → checkoutId
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch(`/api/v1/checkouts?serviceDate=${day.serviceDate}`, CheckoutListResponse).then(
      (res) => {
        const map = new Map<string, string>();
        for (const c of res.checkouts) for (const o of c.orders) if (ACTIVE.has(o.status)) map.set(o.studentId, c.id);
        setOrdered(map);
      },
      (err) => setError(errorMessage(err instanceof ApiError ? err.code : "internal_error")),
    );
  }, [day.serviceDate]);

  const groups = SHIFTS.map((shift) => ({ shift, students: me.students.filter((s) => s.shift === shift) })).filter((g) => g.students.length > 0);
  return (
    <section>
      {groups.map((g) => (
        <ShiftOrder
          key={g.shift}
          serviceDate={day.serviceDate}
          items={day.items}
          shift={g.shift}
          info={day.shifts.find((s) => s.shift === g.shift)}
          students={g.students}
          ordered={ordered}
          labelled={groups.length > 1}
        />
      ))}
      {error && (
        <p role="alert" className="g-alert">
          {error}
        </p>
      )}
    </section>
  );
}
