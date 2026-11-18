import { createHash } from "node:crypto";
import pg from "pg";
import { migrate } from "../db/migrate";

const ADMIN = "postgres://postgres:postgres@localhost:5432";
export const PAIRING_CODE = "KDSE2E23";
export const SCHOOL_ID = "0193a3b0-0000-7000-8000-00000000e2e1";

export default async function globalSetup(): Promise<void> {
  const root = new pg.Client({ connectionString: `${ADMIN}/postgres` });
  await root.connect();
  await root.query("DROP DATABASE IF EXISTS app_lanche_e2e WITH (FORCE)");
  await root.query("CREATE DATABASE app_lanche_e2e");
  await root.end();
  await migrate({ adminUrl: `${ADMIN}/app_lanche_e2e`, appPassword: "app_user" });

  const db = new pg.Client({ connectionString: `${ADMIN}/app_lanche_e2e` });
  await db.connect();
  try {
    await db.query(`INSERT INTO schools (id, name) VALUES ($1, 'Escola E2E')`, [SCHOOL_ID]);
    // Dia de hoje (fuso da escola), já depois do corte e ainda aberto, com 3 pedidos confirmados: o KDS mostra a prévia;
    // o teste fecha o dia pela rota interna (como o n8n), e o romaneio é gravado pelo serviço real.
    const { rows: [day] } = await db.query<{ id: string; date: string }>(`
      INSERT INTO service_days (id, school_id, service_date, cutoff_at, freeze_at)
      VALUES (gen_random_uuid(), $1, (now() AT TIME ZONE 'America/Sao_Paulo')::date, now() - interval '30 minutes', now() - interval '25 minutes')
      RETURNING id, service_date::text AS date`, [SCHOOL_ID]);
    const { rows: [cls] } = await db.query<{ id: string }>(`INSERT INTO classes (id, school_id, name) VALUES (gen_random_uuid(), $1, 'Infantil 3A') RETURNING id`, [SCHOOL_ID]);
    const { rows: [guardian] } = await db.query<{ id: string }>(`INSERT INTO guardians (id, school_id, phone_e164, first_name) VALUES (gen_random_uuid(), $1, '+5511999990099', 'Ana') RETURNING id`, [SCHOOL_ID]);
    const { rows: [item] } = await db.query<{ id: string }>(`INSERT INTO menu_items (id, school_id, name, price_cents) VALUES (gen_random_uuid(), $1, 'Misto quente', 900) RETURNING id`, [SCHOOL_ID]);
    await db.query(`INSERT INTO service_day_items (school_id, service_day_id, menu_item_id, price_cents) VALUES ($1, $2, $3, 900)`, [SCHOOL_ID, day!.id, item!.id]);
    const { rows: [checkout] } = await db.query<{ id: string }>(
      `INSERT INTO checkouts (id, school_id, guardian_id, service_day_id, status, total_cents) VALUES (gen_random_uuid(), $1, $2, $3, 'paid', 2700) RETURNING id`,
      [SCHOOL_ID, guardian!.id, day!.id],
    );
    for (const [i, name] of ["Léo", "Bia", "Caio"].entries()) {
      const { rows: [student] } = await db.query<{ id: string }>(
        `INSERT INTO students (id, school_id, class_id, external_code, first_name) VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING id`,
        [SCHOOL_ID, cls!.id, `E2E-${i}`, name],
      );
      await db.query(`INSERT INTO guardian_students (school_id, guardian_id, student_id) VALUES ($1, $2, $3)`, [SCHOOL_ID, guardian!.id, student!.id]);
      const { rows: [order] } = await db.query<{ id: string }>(
        `INSERT INTO orders (id, school_id, checkout_id, student_id, service_date, status) VALUES (gen_random_uuid(), $1, $2, $3, $4::date, 'confirmed') RETURNING id`,
        [SCHOOL_ID, checkout!.id, student!.id, day!.date],
      );
      await db.query(`INSERT INTO order_items (id, school_id, order_id, menu_item_id, qty, unit_price_cents) VALUES (gen_random_uuid(), $1, $2, $3, 1, 900)`, [SCHOOL_ID, order!.id, item!.id]);
    }
    await db.query(
      `INSERT INTO devices (id, school_id, kind, pairing_code_hash, pairing_expires_at) VALUES (gen_random_uuid(), $1, 'kitchen', $2, now() + interval '30 minutes')`,
      [SCHOOL_ID, createHash("sha256").update(PAIRING_CODE).digest("hex")],
    );
  } finally {
    await db.end();
  }
}
