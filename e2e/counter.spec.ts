import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { SCHOOL_ID } from "./global-setup";

const DB = "postgres://postgres:postgres@localhost:5432/app_lanche_e2e";
const SYNCED = /^0 pendentes · última sincronização \d{2}:\d{2}$/;
const CODE = "KDSE2E67";

async function query<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: DB });
  await c.connect();
  try {
    return (await c.query<T>(sql, params)).rows;
  } finally {
    await c.end();
  }
}

/** A secretaria debita no servidor enquanto o tablet está sem rede (o tablet não fica sabendo). */
async function serverDebit(guardianId: string, cents: number): Promise<void> {
  await query(`INSERT INTO wallets (id, school_id, guardian_id) VALUES (gen_random_uuid(), $1, $2) ON CONFLICT DO NOTHING`, [SCHOOL_ID, guardianId]);
  await query(
    `INSERT INTO wallet_entries (id, school_id, wallet_id, kind, amount_cents, source_type, source_id)
     SELECT gen_random_uuid(), $1, w.id, 'manual_adjustment', $3, 'adjustment', gen_random_uuid() FROM wallets w WHERE w.guardian_id = $2`,
    [SCHOOL_ID, guardianId, -cents],
  );
  await query(`UPDATE wallets SET balance_cents = balance_cents - $2 WHERE guardian_id = $1`, [guardianId, cents]);
}

test("sells offline at the counter, debits the wallet once and flags the limit", async ({ browser }) => {
  await query(`UPDATE schools SET debt_limit_cents = 1000 WHERE id = $1`, [SCHOOL_ID]);
  await query(
    `INSERT INTO devices (id, school_id, kind, pairing_code_hash, pairing_expires_at) VALUES (gen_random_uuid(), $1, 'kitchen', $2, now() + interval '30 minutes')`,
    [SCHOOL_ID, createHash("sha256").update(CODE).digest("hex")],
  );
  const [day] = await query<{ date: string }>(`SELECT service_date::text AS date FROM service_days WHERE school_id = $1`, [SCHOOL_ID]);
  const students = await query<{ id: string; first_name: string; guardian_id: string }>(
    `SELECT s.id, s.first_name, gs.guardian_id FROM students s JOIN guardian_students gs ON gs.student_id = s.id AND gs.financial WHERE s.school_id = $1`,
    [SCHOOL_ID],
  );
  const leo = students.find((s) => s.first_name === "Léo")!;
  const bia = students.find((s) => s.first_name === "Bia")!;
  const [item] = await query<{ id: string }>(`SELECT id FROM menu_items WHERE school_id = $1 AND name = 'Misto quente'`, [SCHOOL_ID]);
  const balance = async () =>
    (await query<{ b: number }>(`SELECT balance_cents::int AS b FROM wallets WHERE guardian_id = $1`, [leo.guardian_id]))[0]?.b ?? 0;
  const charges = () =>
    query<{ id: string; over_limit: boolean; total: number }>(
      `SELECT cs.id, cs.over_limit, cs.total_cents::int AS total FROM counter_sales cs WHERE cs.school_id = $1`,
      [SCHOOL_ID],
    );

  const context = await browser.newContext({ timezoneId: "America/Sao_Paulo" });
  const page = await context.newPage();
  await page.goto(`/kds?date=${day!.date}`);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.getByTestId("kds-pair-code").fill(CODE);
  await page.getByTestId("kds-pair-submit").click();
  await page.getByTestId("kds-tab-counter").click();
  await expect(page.getByTestId(`kds-counter-student-${leo.id}`)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("kds-badge")).toHaveText(SYNCED, { timeout: 20_000 });

  // 1. Sem rede. No servidor, a conta de Ana passa a -R$ 5,00; o tablet ainda acha que está zerada.
  await context.setOffline(true);
  await serverDebit(leo.guardian_id, 500);
  await page.getByTestId(`kds-counter-student-${leo.id}`).click();
  await page.getByTestId(`kds-counter-item-${item!.id}-plus`).click();
  await expect(page.getByTestId("kds-counter-balance-after")).toHaveText("-R$ 9,00");
  await page.getByTestId("kds-counter-submit").click();
  await expect(page.getByTestId("kds-badge")).toContainText("1 pendente");

  // 2. Com o saldo local (-R$ 9,00), outro lanche passaria do limite de R$ 10,00: botão desligado.
  await page.getByTestId(`kds-counter-student-${bia.id}`).click();
  await page.getByTestId(`kds-counter-item-${item!.id}-plus`).click();
  await expect(page.getByTestId("kds-counter-submit")).toBeDisabled();
  await expect(page.getByTestId("kds-counter-over-limit")).toHaveText("Saldo insuficiente: peça à secretaria");

  // 3. Recarrega offline (service worker + IndexedDB): o lançamento continua pendente; nada chegou ao servidor.
  await page.reload();
  await page.getByTestId("kds-tab-counter").click();
  await expect(page.getByTestId("kds-badge")).toContainText("1 pendente");
  expect(await charges()).toEqual([]);

  // 4. Rede de volta: o lançamento entra uma vez, acima do limite no servidor (-R$ 14,00), e fica marcado.
  await context.setOffline(false);
  await expect(page.getByTestId("kds-badge")).toHaveText(SYNCED, { timeout: 30_000 });
  const stored = await charges();
  expect(stored).toEqual([{ id: expect.any(String), over_limit: true, total: 900 }]);
  expect(await balance()).toBe(-1400);
  await expect(page.getByTestId(`kds-counter-student-${leo.id}`)).toContainText("Saldo: -R$ 14,00");

  // 5. Reenviar o mesmo lançamento (com o cookie do tablet) é aceito sem debitar de novo.
  const replay = await page.evaluate(async (body) => {
    const res = await fetch("/api/kds/v1/counter-sales", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as { accepted: string[]; rejected: string[] } };
  }, { sales: [{ id: stored[0]!.id, studentId: leo.id, items: [{ menuItemId: item!.id, qty: 1 }], occurredAt: new Date().toISOString() }] });
  expect(replay).toEqual({ status: 200, json: { accepted: [stored[0]!.id], rejected: [] } });
  expect(await balance()).toBe(-1400);
  const entries = await query<{ n: number }>(`SELECT count(*)::int AS n FROM wallet_entries WHERE school_id = $1 AND kind = 'counter_charge'`, [SCHOOL_ID]);
  expect(entries[0]!.n).toBe(1);
  await context.close();
});

test("undoes a counter sale offline and the void leaves the outbox once synced", async ({ browser }) => {
  const code = "KDSE2E89";
  // Limite alto: Ana já está devendo pelo teste anterior e a venda precisa passar no tablet.
  await query(`UPDATE schools SET debt_limit_cents = 100000 WHERE id = $1`, [SCHOOL_ID]);
  await query(
    `INSERT INTO devices (id, school_id, kind, pairing_code_hash, pairing_expires_at) VALUES (gen_random_uuid(), $1, 'kitchen', $2, now() + interval '30 minutes')`,
    [SCHOOL_ID, createHash("sha256").update(code).digest("hex")],
  );
  const [day] = await query<{ date: string }>(`SELECT service_date::text AS date FROM service_days WHERE school_id = $1`, [SCHOOL_ID]);
  const [caio] = await query<{ id: string; guardian_id: string }>(
    `SELECT s.id, gs.guardian_id FROM students s JOIN guardian_students gs ON gs.student_id = s.id AND gs.financial WHERE s.school_id = $1 AND s.first_name = 'Caio'`,
    [SCHOOL_ID],
  );
  const [item] = await query<{ id: string }>(`SELECT id FROM menu_items WHERE school_id = $1 AND name = 'Misto quente'`, [SCHOOL_ID]);
  const balance = async () => (await query<{ b: number }>(`SELECT balance_cents::int AS b FROM wallets WHERE guardian_id = $1`, [caio!.guardian_id]))[0]?.b ?? 0;
  const sales = () =>
    query<{ id: string; voided: boolean }>(`SELECT id, voided_at IS NOT NULL AS voided FROM counter_sales WHERE school_id = $1 AND student_id = $2`, [SCHOOL_ID, caio!.id]);
  const voids = async (saleId: string) =>
    (await query<{ n: number }>(`SELECT count(*)::int AS n FROM wallet_entries WHERE school_id = $1 AND kind = 'counter_void' AND source_id = $2`, [SCHOOL_ID, saleId]))[0]!.n;

  const context = await browser.newContext({ timezoneId: "America/Sao_Paulo" });
  const page = await context.newPage();
  await page.goto(`/kds?date=${day!.date}`);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.getByTestId("kds-pair-code").fill(code);
  await page.getByTestId("kds-pair-submit").click();
  await page.getByTestId("kds-tab-counter").click();
  await expect(page.getByTestId(`kds-counter-student-${caio!.id}`)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("kds-badge")).toHaveText(SYNCED, { timeout: 20_000 });
  const before = await balance();

  // 1. Com rede: o lançamento sai na próxima rodada e o servidor debita.
  await page.getByTestId(`kds-counter-student-${caio!.id}`).click();
  await page.getByTestId(`kds-counter-item-${item!.id}-plus`).click();
  await page.getByTestId("kds-counter-submit").click();
  await expect.poll(sales, { timeout: 30_000 }).toEqual([{ id: expect.any(String), voided: false }]);
  const [sale] = await sales();
  await expect(page.getByTestId(`kds-counter-sale-${sale!.id}`)).toContainText("enviado", { timeout: 20_000 });
  await expect(page.getByTestId("kds-badge")).toHaveText(SYNCED);
  expect(await balance()).toBe(before - 900);

  // 2. Sem rede: "Desfazer" grava o estorno na outbox e devolve o saldo local.
  await context.setOffline(true);
  page.once("dialog", (d) => void d.accept());
  await page.getByTestId(`kds-counter-undo-${sale!.id}`).click();
  await expect(page.getByTestId(`kds-counter-sale-${sale!.id}`)).toContainText("estornado");
  await expect(page.getByTestId("kds-badge")).toContainText("1 pendente");
  expect(await sales()).toEqual([{ id: sale!.id, voided: false }]);

  // 3. Rede de volta: o servidor responde pelo saleId e o estorno sai da outbox (0 pendentes), uma vez só.
  await context.setOffline(false);
  await expect(page.getByTestId("kds-badge")).toHaveText(SYNCED, { timeout: 30_000 });
  expect(await sales()).toEqual([{ id: sale!.id, voided: true }]);
  expect(await balance()).toBe(before);
  expect(await voids(sale!.id)).toBe(1);

  // 4. Reenviar o estorno é aceito sem creditar de novo.
  const replay = await page.evaluate(async (body) => {
    const res = await fetch("/api/kds/v1/counter-voids", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as { accepted: string[]; rejected: string[] } };
  }, { voids: [{ saleId: sale!.id, occurredAt: new Date().toISOString() }] });
  expect(replay).toEqual({ status: 200, json: { accepted: [sale!.id], rejected: [] } });
  expect(await balance()).toBe(before);
  expect(await voids(sale!.id)).toBe(1);
  await context.close();
});

test("keeps an undo made during a sync round behind its sale", async ({ browser }) => {
  test.setTimeout(120_000); // até três rodadas de 15 s
  const code = "KDSE2E45";
  await query(`UPDATE schools SET debt_limit_cents = 100000 WHERE id = $1`, [SCHOOL_ID]);
  await query(
    `INSERT INTO devices (id, school_id, kind, pairing_code_hash, pairing_expires_at) VALUES (gen_random_uuid(), $1, 'kitchen', $2, now() + interval '30 minutes')`,
    [SCHOOL_ID, createHash("sha256").update(code).digest("hex")],
  );
  const [day] = await query<{ date: string }>(`SELECT service_date::text AS date FROM service_days WHERE school_id = $1`, [SCHOOL_ID]);
  const [bia] = await query<{ id: string }>(`SELECT id FROM students WHERE school_id = $1 AND first_name = 'Bia'`, [SCHOOL_ID]);
  const [item] = await query<{ id: string }>(`SELECT id FROM menu_items WHERE school_id = $1 AND name = 'Misto quente'`, [SCHOOL_ID]);
  const sales = () =>
    query<{ id: string; voided: boolean }>(
      `SELECT id, voided_at IS NOT NULL AS voided FROM counter_sales WHERE school_id = $1 AND student_id = $2 ORDER BY occurred_at`,
      [SCHOOL_ID, bia!.id],
    );

  const context = await browser.newContext({ timezoneId: "America/Sao_Paulo" });
  const page = await context.newPage();
  await page.goto(`/kds?date=${day!.date}`);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.getByTestId("kds-pair-code").fill(code);
  await page.getByTestId("kds-pair-submit").click();
  await page.getByTestId("kds-tab-counter").click();
  await expect(page.getByTestId(`kds-counter-student-${bia!.id}`)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("kds-badge")).toHaveText(SYNCED, { timeout: 20_000 });

  // 1. O envio do primeiro lançamento fica preso na rede lenta (a rodada está em andamento).
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let intercepted!: () => void;
  const sent = new Promise<void>((r) => (intercepted = r));
  await page.route("**/api/kds/v1/counter-sales", async (route) => {
    intercepted();
    await held;
    await route.continue();
  });
  const sell = async () => {
    await page.getByTestId(`kds-counter-student-${bia!.id}`).click();
    await page.getByTestId(`kds-counter-item-${item!.id}-plus`).click();
    await page.getByTestId("kds-counter-submit").click();
  };
  await sell();
  await sent;

  // 2. Durante a rodada, outro lançamento e o "Desfazer" dele (correção de aluno errado).
  await sell();
  page.once("dialog", (d) => void d.accept());
  await page.locator('[data-testid^="kds-counter-undo-"]').first().click();
  await expect(page.getByTestId("kds-badge")).toContainText("3 pendentes");

  // 3. A rede volta: o estorno espera o lançamento e o desfazer não se perde.
  release(); // as rodadas seguintes passam direto pelo handler
  await expect(page.getByTestId("kds-badge")).toHaveText(SYNCED, { timeout: 45_000 });
  const stored = await sales();
  expect(stored.map((s) => s.voided)).toEqual([false, true]);
  const [second] = stored.slice(1);
  await expect(page.getByTestId(`kds-counter-sale-${second!.id}`)).toContainText("estornado");
  await context.close();
});
