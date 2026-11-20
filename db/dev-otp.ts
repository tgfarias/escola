// Local only: prints the last OTP code for the Docker app (`pnpm app:up`), where no n8n sends it.
// Usage: pnpm app:otp            -> last code, if still valid (5 minutes)
//        pnpm app:otp --reset    -> clears the demo school's OTP challenges (lifts the 3/15 min and 10/day limits)
// A throttled request creates no code and still answers 200 (so it does not reveal the account): without this
// check the newest code printed would be an old one that the login screen rejects.
import pg from "pg";

const DEMO_SCHOOL_ID = "0193a3b0-0000-7000-8000-00000000de01";
const reset = process.argv[2] === "--reset";
if (process.argv[2] !== undefined && !reset) {
  console.error("usage: pnpm app:otp [--reset]");
  process.exit(1);
}

const adminUrl = process.env.DATABASE_ADMIN_URL ?? "postgres://postgres:postgres@localhost:5432/app_lanche";
const db = new pg.Client({ connectionString: adminUrl });
await db.connect();
try {
  if (reset) {
    const { rowCount } = await db.query("DELETE FROM otp_challenges WHERE school_id = $1", [DEMO_SCHOOL_ID]);
    console.log(`cleared ${rowCount ?? 0} OTP challenges of the demo school; request a new code now`);
  } else {
    const { rows } = await db.query<{ code: string | null; fresh: boolean }>(
      `SELECT data->>'code' AS code, occurred_at > now() - interval '5 minutes' AS fresh
       FROM outbox_events WHERE type = 'auth.otp_requested' ORDER BY occurred_at DESC LIMIT 1`,
    );
    const last = rows[0];
    if (last?.code && last.fresh) {
      console.log(last.code);
    } else {
      console.error(
        last
          ? "no code issued in the last 5 minutes: request one on the login screen first. If you just did, the\n" +
              "request hit the limit (3 per 15 min, 10 per day): run `pnpm app:otp --reset` and request again."
          : "no code issued yet: request one on the login screen first",
      );
      process.exitCode = 1;
    }
  }
} finally {
  await db.end();
}
