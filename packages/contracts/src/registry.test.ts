import { describe, expect, it } from "vitest";
import { ClassListResponse, SetClassShiftRequest } from "./registry";

describe("class shift contracts", () => {
  it("parses the class list with shifts", () => {
    const fixture = {
      classes: [
        { id: "0193a000-0000-7000-8000-000000000001", name: "Infantil 3A", shift: "matutino" },
        { id: "0193a000-0000-7000-8000-000000000002", name: "Infantil 4B", shift: "vespertino" },
      ],
    };
    expect(ClassListResponse.parse(fixture)).toEqual(fixture);
    expect(() => ClassListResponse.parse({ classes: [{ id: fixture.classes[0]!.id, name: "X" }] })).toThrow();
  });

  it("accepts only a known shift and no extra keys", () => {
    expect(SetClassShiftRequest.parse({ shift: "vespertino" })).toEqual({ shift: "vespertino" });
    expect(() => SetClassShiftRequest.parse({ shift: "noite" })).toThrow();
    expect(() => SetClassShiftRequest.parse({ shift: "matutino", x: 1 })).toThrow();
  });
});
