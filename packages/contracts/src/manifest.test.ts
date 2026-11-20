import { describe, expect, it } from "vitest";
import { ManifestResponse, ServiceDayCloseResponse } from "./manifest";

const MORNING = {
  shift: "matutino",
  status: "closed",
  closed_at: "2026-11-17T07:35:02-03:00",
  manifest_version: 1,
  kitchen_phone: "+5511988880000",
  totals: { orders: 142, by_item: [{ item: "Misto quente", qty: 61 }] },
  by_class: [
    {
      class: "Infantil 3A",
      orders: [{ order_id: "0193a3b0-0000-7000-8000-000000000001", student: "Léo", items: ["Misto quente"], restrictions: "sem lactose" }],
    },
  ],
  late_credits: 3,
};

describe("manifest contract", () => {
  it("accepts the close example from spec 6.2", () => {
    const example = { service_date: "2026-11-17", status: "open", shifts: [MORNING] };
    expect(ServiceDayCloseResponse.parse(example)).toEqual(example);
    expect(ManifestResponse.parse(MORNING)).toEqual(MORNING);
    expect(ManifestResponse.parse({ ...MORNING, status: "finished" }).status).toBe("finished");
    expect(() => ManifestResponse.parse({ ...MORNING, status: "open" })).toThrow();
    expect(() => ManifestResponse.parse({ ...MORNING, shift: undefined })).toThrow();
  });
});
