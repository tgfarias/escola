import pg from "pg";
import { uuidv7 } from "uuidv7";

// Platform operation: runs with the admin database user, outside the application.
const [name, email] = process.argv.slice(2);
const adminUrl = process.env.DATABASE_ADMIN_URL;
const parts = email?.split("@") ?? [];
const emailOk = parts.length === 2 && parts[0] !== "" && parts[1] !== "";
if (!name?.trim() || !email || !emailOk || !adminUrl) {
  console.error('usage: DATABASE_ADMIN_URL=... cli:create-school "<school name>" <admin email>');
  process.exit(1);
}

const client = new pg.Client({ connectionString: adminUrl });
await client.connect();
try {
  const schoolId = uuidv7();
  await client.query("BEGIN");
  await client.query("INSERT INTO schools (id, name) VALUES ($1, $2)", [schoolId, name]);
  await client.query(
    "INSERT INTO staff_users (id, school_id, email, role) VALUES ($1, $2, lower($3), 'admin')",
    [uuidv7(), schoolId, email],
  );
  await client.query("COMMIT");
  console.log(`school created: ${schoolId}`);
} catch (err) {
  await client.query("ROLLBACK").catch(() => {});
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await client.end();
}
