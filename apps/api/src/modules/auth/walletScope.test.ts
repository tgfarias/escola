import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { adminDb, createSchool, guardianCookie, internalRequest, seedFamily } from "../../../test/helpers";
import { buildApp } from "../../app";

describe("wallet magic-link scope", () => {
  it("issues a 7-day wallet link and exchanges it for a wallet session", async () => {
    const schoolId = await createSchool();
    const fam = await seedFamily(schoolId, ["Léo"]);
    const app = buildApp();
    const res = await app.inject(internalRequest("POST", `/internal/v1/schools/${schoolId}/magic-links`, { guardian_id: fam.guardianId, scope: "wallet" }));
    expect(res.statusCode).toBe(200);
    const { rows } = await sql<{ days: number; scope: string; serviceDate: string | null }>`
      SELECT round(extract(epoch FROM expires_at - created_at) / 86400)::int AS days, scope, service_date
      FROM magic_links WHERE guardian_id = ${fam.guardianId}`.execute(adminDb());
    expect(rows).toEqual([{ days: 7, scope: "wallet", serviceDate: null }]);
    const token = (res.json().link_url as string).split("#")[1]!;
    const exchange = await app.inject({ method: "POST", url: "/api/v1/auth/exchange", payload: { token, deviceSecret: "d".repeat(43) } });
    expect(exchange.json()).toEqual({ status: "ok", scope: "wallet" });
    const withDate = await app.inject(
      internalRequest("POST", `/internal/v1/schools/${schoolId}/magic-links`, { guardian_id: fam.guardianId, scope: "wallet", service_date: "2031-01-02" }),
    );
    expect(withDate.statusCode).toBe(400);
  });

  it("lets a wallet session use only the wallet and /me", async () => {
    const schoolId = await createSchool();
    const fam = await seedFamily(schoolId, ["Léo"]);
    const app = buildApp();
    const wallet = await guardianCookie(schoolId, fam.guardianId, "wallet");
    const get = (url: string, cookies = wallet) => app.inject({ method: "GET", url, cookies });
    expect((await get("/api/v1/wallet")).statusCode).toBe(200);
    expect((await get("/api/v1/me")).statusCode).toBe(200);
    expect((await get("/api/v1/service-days")).statusCode).toBe(403);
    expect((await get("/api/v1/documents")).statusCode).toBe(403);
    expect((await get("/api/v1/wallet", await guardianCookie(schoolId, fam.guardianId, "documents"))).statusCode).toBe(403);
  });
});
