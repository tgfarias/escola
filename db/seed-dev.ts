// CPFs are well-known fictitious test numbers with valid check digits.
// Local only: a demo school to click around in. Idempotent (fixed ids + ON CONFLICT DO NOTHING).
// Personal fields are only backfilled when empty: a value staff changed survives `pnpm app:up`; a cleared one is filled again.
// Runs with the admin database user, outside the application, like cli:create-school.
import pg from "pg";

const adminUrl = process.env.DATABASE_ADMIN_URL;
const adminEmail = (process.env.DEV_ADMIN_EMAIL ?? "admin@escola.local").toLowerCase();
if (!adminUrl) {
  console.error("DATABASE_ADMIN_URL is required");
  process.exit(1);
}

const SCHOOL = "0193a3b0-0000-7000-8000-00000000de01";
const id = (n: number) => `0193a3b0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

const classes = [
  { id: id(0xc1), name: "Infantil 3A" },
  { id: id(0xc2), name: "Infantil 4B" },
];
const guardians: { id: string; first: string; full: string | null; cpf: string | null; phone: string }[] = [
  { id: id(0xa1), first: "Ana", full: "Ana Paula Souza", cpf: "52998224725", phone: "+5511900000001" },
  { id: id(0xa2), first: "Bruno", full: "Bruno Lima", cpf: "11144477735", phone: "+5511900000002" },
  { id: id(0xa3), first: "Carla", full: "Carla Alves", cpf: "12345678909", phone: "+5511900000003" },
  { id: id(0xa4), first: "Diego", full: null, cpf: null, phone: "+5511900000004" },
];
const students = [
  { id: id(0xb1), cls: 0, code: "DEMO-1", first: "Léo", full: "Leonardo Souza", birth: "2021-03-15", guardian: 0 },
  { id: id(0xb2), cls: 0, code: "DEMO-2", first: "Bia", full: "Beatriz Souza", birth: "2022-07-02", guardian: 0 },
  { id: id(0xb3), cls: 1, code: "DEMO-3", first: "Caio", full: "Caio Lima", birth: "2021-11-20", guardian: 1 },
  { id: id(0xb4), cls: 1, code: "DEMO-4", first: "Duda", full: "Maria Eduarda Alves", birth: "2020-05-08", guardian: 2 },
];
const items = [
  { id: id(0xe1), name: "Misto quente", cents: 900 },
  { id: id(0xe2), name: "Suco de laranja", cents: 600 },
  { id: id(0xe3), name: "Salada de frutas", cents: 750 },
];

const db = new pg.Client({ connectionString: adminUrl });
await db.connect();
try {
  await db.query("BEGIN");
  await db.query("INSERT INTO schools (id, name) VALUES ($1, 'Escola Demonstração') ON CONFLICT DO NOTHING", [SCHOOL]);
  // Pix simulado (`pnpm app:pay`): o webhook do provedor fake confere o segredo da variável DEMO_WEBHOOK_SECRET da API.
  await db.query(
    "UPDATE schools SET payment_webhook_secret_ref = 'DEMO_WEBHOOK_SECRET' WHERE id = $1 AND payment_webhook_secret_ref IS NULL",
    [SCHOOL],
  );
  await db.query(
    "INSERT INTO staff_users (id, school_id, email, role) VALUES ($1, $2, $3, 'admin') ON CONFLICT DO NOTHING",
    [id(0xf1), SCHOOL, adminEmail],
  );
  for (const c of classes) {
    await db.query("INSERT INTO classes (id, school_id, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [c.id, SCHOOL, c.name]);
  }
  for (const g of guardians) {
    await db.query(
      `INSERT INTO guardians (id, school_id, phone_e164, first_name, full_name, cpf) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET full_name = coalesce(guardians.full_name, EXCLUDED.full_name), cpf = coalesce(guardians.cpf, EXCLUDED.cpf)`,
      [g.id, SCHOOL, g.phone, g.first, g.full, g.cpf],
    );
  }
  for (const s of students) {
    await db.query(
      `INSERT INTO students (id, school_id, class_id, external_code, first_name, full_name, birth_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET full_name = coalesce(students.full_name, EXCLUDED.full_name), birth_date = coalesce(students.birth_date, EXCLUDED.birth_date)`,
      [s.id, SCHOOL, classes[s.cls]!.id, s.code, s.first, s.full, s.birth],
    );
    // The first and only guardian of each seeded student is the financial one; the target-less ON CONFLICT also
    // covers an older database where migration 0010 already marked it.
    await db.query(
      "INSERT INTO guardian_students (school_id, guardian_id, student_id, financial) VALUES ($1, $2, $3, true) ON CONFLICT DO NOTHING",
      [SCHOOL, guardians[s.guardian]!.id, s.id],
    );
  }
  // Diego sees Léo's snacks, without Ana's wallet.
  await db.query("INSERT INTO guardian_students (school_id, guardian_id, student_id, financial) VALUES ($1, $2, $3, false) ON CONFLICT DO NOTHING", [SCHOOL, guardians[3]!.id, students[0]!.id]);
  for (const m of items) {
    await db.query(
      "INSERT INTO menu_items (id, school_id, name, price_cents) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
      [m.id, SCHOOL, m.name, m.cents],
    );
  }
  // Saldos de demonstração. Cada lançamento entra uma vez (ids fixos + ON CONFLICT) e o saldo só muda se ele entrou,
  // mantendo saldo = soma dos lançamentos.
  async function post(entryId: string, guardianId: string, kind: string, amountCents: number, sourceType: string, sourceId: string, note: string | null) {
    await db.query("INSERT INTO wallets (id, school_id, guardian_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [id(0xd0 + guardians.findIndex((g) => g.id === guardianId)), SCHOOL, guardianId]);
    const { rowCount } = await db.query(
      `INSERT INTO wallet_entries (id, school_id, wallet_id, kind, amount_cents, source_type, source_id, note)
       SELECT $1, $2, w.id, $4, $5, $6, $7, $8 FROM wallets w WHERE w.school_id = $2 AND w.guardian_id = $3
       ON CONFLICT DO NOTHING`,
      [entryId, SCHOOL, guardianId, kind, amountCents, sourceType, sourceId, note],
    );
    if (rowCount === 1) {
      await db.query("UPDATE wallets SET balance_cents = balance_cents + $3 WHERE school_id = $1 AND guardian_id = $2", [SCHOOL, guardianId, amountCents]);
    }
  }
  // Ana: R$ 30,00 de crédito.
  await post(id(0x5a1), guardians[0]!.id, "manual_adjustment", 3000, "adjustment", id(0x5a2), "Saldo de demonstração");
  // Bruno: lanche de Caio lançado pela secretaria (misto quente + suco), saldo -R$ 15,00.
  const sale = id(0x5b1);
  await post(id(0x5b2), guardians[1]!.id, "counter_charge", -1500, "counter_sale", sale, null);
  await db.query(
    `INSERT INTO counter_sales (id, school_id, student_id, guardian_id, source, staff_user_id, occurred_at, total_cents, over_limit, wallet_entry_id)
     VALUES ($1, $2, $3, $4, 'staff', $5, now(), 1500, false, $6) ON CONFLICT DO NOTHING`,
    [sale, SCHOOL, students[2]!.id, guardians[1]!.id, id(0xf1), id(0x5b2)],
  );
  for (const [item, price] of [[items[0]!, 900], [items[1]!, 600]] as const) {
    await db.query(
      "INSERT INTO counter_sale_items (school_id, sale_id, menu_item_id, qty, unit_price_cents) VALUES ($1, $2, $3, 1, $4) ON CONFLICT DO NOTHING",
      [SCHOOL, sale, item.id, price],
    );
  }
  await db.query("COMMIT");
  console.log("demo school ready");
} catch (err) {
  await db.query("ROLLBACK").catch(() => undefined);
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.end();
}
