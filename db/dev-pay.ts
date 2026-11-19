// Local only: simulates the Pix being paid for the Docker app (`pnpm app:up`, provider `fake`).
// Usage: pnpm app:pay            -> pays the most recent pending fake charge
//        pnpm app:pay <id>       -> pays the pending charge of that top-up or checkout id
// It posts the same webhook a gateway would (POST /webhooks/payments/fake/<school_id>, header x-fake-token), so the
// payment is confirmed by the real confirmPayment path. The charge lookup uses the admin database user, like seed-dev.
import { randomUUID } from "node:crypto";
import pg from "pg";

const target = process.argv[2];
if (target !== undefined && !/^[0-9a-f-]{36}$/i.test(target)) {
  console.error("usage: pnpm app:pay [topup_or_checkout_id]");
  process.exit(1);
}

// Defaults are the literals in docker-compose.yml.
const adminUrl = process.env.DATABASE_ADMIN_URL ?? "postgres://postgres:postgres@localhost:5432/app_lanche";
const apiUrl = process.env.API_URL ?? "http://localhost:8080";
const secret = process.env.DEMO_WEBHOOK_SECRET ?? "local-fake-webhook-secret-with-at-least-32-chars";

const db = new pg.Client({ connectionString: adminUrl });
await db.connect();
let rows: { school_id: string; provider_charge_id: string; amount_cents: string }[];
try {
  ({ rows } = await db.query(
    `SELECT school_id, provider_charge_id, amount_cents FROM payments
     WHERE provider = 'fake' AND status = 'pending' AND provider_charge_id IS NOT NULL
       AND ($1::uuid IS NULL OR topup_id = $1::uuid OR checkout_id = $1::uuid)
     ORDER BY created_at DESC LIMIT 1`,
    [target ?? null],
  ));
} finally {
  await db.end();
}
const charge = rows[0];
if (!charge) {
  console.error("no pending fake charge found (generate the Pix first)");
  process.exit(1);
}

const res = await fetch(`${apiUrl}/webhooks/payments/fake/${charge.school_id}`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-fake-token": secret },
  body: JSON.stringify({
    id: `dev-${randomUUID()}`,
    event: "charge.paid",
    charge_id: charge.provider_charge_id,
    amount_cents: Number(charge.amount_cents),
    paid_at: new Date().toISOString(),
  }),
});
console.log(res.ok ? `paid R$ ${(Number(charge.amount_cents) / 100).toFixed(2)}` : `webhook answered ${res.status}`);
if (!res.ok) process.exitCode = 1;
