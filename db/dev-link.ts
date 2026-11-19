// Local only: prints a guardian magic link for the Docker app (`pnpm app:up`).
// Usage: pnpm app:link <phone_e164> [order|documents|wallet]
// An order link is for the next open service day whose cutoff has not passed (create one in the admin area first).
// It reuses the n8n route (POST /internal/v1/schools/<id>/magic-links) signed like n8n does; no tenant bypass in the API.
// The guardian lookup uses the admin database user, outside the application, like seed-dev.
import pg from "pg";
import { signInternal } from "../apps/api/src/platform/hmac";

const [phone, scopeArg = "documents"] = process.argv.slice(2);
const scope = scopeArg === "order" || scopeArg === "documents" || scopeArg === "wallet" ? scopeArg : null;
if (!phone || !/^\+\d{8,15}$/.test(phone) || !scope) {
  console.error("usage: pnpm app:link <phone_e164> [order|documents|wallet]   e.g. pnpm app:link +5511900000001 documents");
  process.exit(1);
}

// Defaults are the literals in docker-compose.yml.
const adminUrl = process.env.DATABASE_ADMIN_URL ?? "postgres://postgres:postgres@localhost:5432/app_lanche";
const apiUrl = process.env.API_URL ?? "http://localhost:8080";
const serviceToken = process.env.INTERNAL_SERVICE_TOKEN ?? "local-service-token-with-at-least-32-chars";
const hmacSecret = process.env.INTERNAL_HMAC_SECRET ?? "local-hmac-secret-with-at-least-32-chars!!";

const db = new pg.Client({ connectionString: adminUrl });
await db.connect();
let found: { guardian_id: string; school_id: string; next_day: string | null }[];
try {
  // An order link expires at the cutoff of its service day: pick the next day still open for orders.
  ({ rows: found } = await db.query(
    `SELECT g.id AS guardian_id, g.school_id,
       (SELECT d.service_date::text FROM service_days d
        WHERE d.school_id = g.school_id AND d.status = 'open' AND d.cutoff_at > now()
        ORDER BY d.service_date LIMIT 1) AS next_day
     FROM guardians g WHERE g.phone_e164 = $1`,
    [phone],
  ));
} finally {
  await db.end();
}
if (found.length !== 1) {
  console.error(found.length === 0 ? "no guardian with this phone" : "more than one school has a guardian with this phone");
  process.exit(1);
}
const { guardian_id, school_id, next_day } = found[0]!;
if (scope === "order" && next_day === null) {
  console.error("no open service day with a future cutoff: create one in the admin area first");
  process.exit(1);
}

const path = `/internal/v1/schools/${school_id}/magic-links`;
const body = JSON.stringify(scope === "order" ? { guardian_id, scope, service_date: next_day } : { guardian_id, scope });
const timestamp = new Date().toISOString();
const res = await fetch(`${apiUrl}${path}`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${serviceToken}`,
    "content-type": "application/json",
    "idempotency-key": crypto.randomUUID(),
    "x-timestamp": timestamp,
    "x-signature": signInternal(hmacSecret, { method: "POST", path, timestamp, body }),
  },
  body,
});
if (!res.ok) {
  console.error(`API answered ${res.status}: ${await res.text()}`);
  process.exit(1);
}
const { link_url } = (await res.json()) as { link_url: string };
console.log(link_url);
