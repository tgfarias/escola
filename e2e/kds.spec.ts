import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { PAIRING_CODE, SCHOOL_ID } from "./global-setup";

test.describe.configure({ mode: "serial" });

const DB = "postgres://postgres:postgres@localhost:5432/app_lanche_e2e";

async function query<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: DB });
  await c.connect();
  try {
    return (await c.query<T>(sql, params)).rows;
  } finally {
    await c.end();
  }
}

async function closeDay(date: string): Promise<void> {
  const path = `/internal/v1/service-days/${SCHOOL_ID}/${date}/close`;
  const timestamp = new Date().toISOString();
  const signature = createHmac("sha256", "e2e-hmac-secret-with-at-least-32-chars!!").update(`POST\n${path}\n${timestamp}\n`).digest("hex");
  const res = await fetch(`http://localhost:8080${path}`, {
    method: "POST",
    headers: { authorization: "Bearer e2e-service-token-with-at-least-32-chars", "x-timestamp": timestamp, "x-signature": signature },
  });
  expect(res.status).toBe(200);
}

test("marks deliveries offline and syncs them without loss or duplicates", async ({ page, context }) => {
  const [day] = await query<{ date: string }>(`SELECT service_date::text AS date FROM service_days WHERE school_id = $1`, [SCHOOL_ID]);
  const date = day!.date;
  const orders = await query<{ id: string }>(`SELECT id FROM orders WHERE school_id = $1 ORDER BY id`, [SCHOOL_ID]);

  // 1. Pareia online e vê a prévia com marcação desabilitada.
  await page.goto(`/kds?date=${date}`);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.getByTestId("kds-pair-code").fill(PAIRING_CODE.toLowerCase());
  await page.getByTestId("kds-pair-submit").click();
  await expect(page.getByTestId("kds-waiting")).toBeVisible();
  await expect(page.getByTestId(`kds-order-${orders[0]!.id}`)).toBeDisabled();

  // 2. Fecha o dia; a próxima sincronização baixa o romaneio congelado.
  await closeDay(date);
  await page.reload();
  await expect(page.getByTestId("kds-waiting")).toBeHidden({ timeout: 20_000 });
  await expect(page.getByTestId("kds-badge")).toContainText("0 pendentes");

  // 3. Sem rede: marca, desmarca e remarca; recarrega a página offline (service worker + IndexedDB).
  await context.setOffline(true);
  await page.getByTestId(`kds-order-${orders[0]!.id}`).click();
  await page.getByTestId(`kds-order-${orders[1]!.id}`).click();
  await page.getByTestId(`kds-order-${orders[1]!.id}`).click();
  await page.getByTestId(`kds-order-${orders[2]!.id}`).click();
  await expect(page.getByTestId("kds-badge")).toContainText("4 pendentes");
  await page.reload();
  await expect(page.getByTestId(`kds-order-${orders[0]!.id}`)).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId(`kds-order-${orders[1]!.id}`)).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("kds-badge")).toContainText("4 pendentes");

  // 4. Desparear é recusado com outbox pendente.
  await page.getByTestId("kds-unpair").click();
  await expect(page.getByRole("alert")).toContainText("não sincronizadas");

  // 5. Rede de volta: a outbox esvazia e o servidor tem exatamente os 4 eventos.
  await context.setOffline(false);
  await expect(page.getByTestId("kds-badge")).toContainText("0 pendentes", { timeout: 30_000 });
  const events = await query<{ n: string }>(`SELECT count(*) AS n FROM delivery_events WHERE school_id = $1`, [SCHOOL_ID]);
  expect(Number(events[0]!.n)).toBe(4);
  const status = await query<{ id: string; status: string }>(`SELECT id, status FROM orders WHERE school_id = $1`, [SCHOOL_ID]);
  expect(Object.fromEntries(status.map((s) => [s.id, s.status]))).toEqual({
    [orders[0]!.id]: "delivered",
    [orders[1]!.id]: "confirmed",
    [orders[2]!.id]: "delivered",
  });

  // 6. Uma segunda rodada não duplica nada.
  await page.reload();
  await expect(page.getByTestId("kds-badge")).toContainText("0 pendentes");
  const again = await query<{ n: string }>(`SELECT count(*) AS n FROM delivery_events WHERE school_id = $1`, [SCHOOL_ID]);
  expect(Number(again[0]!.n)).toBe(4);
});

test("a second tablet sees deliveries made on the first", async ({ browser }) => {
  // Pareia um segundo contexto com um novo código inserido aqui e confere aria-pressed dos pedidos já entregues.
  const second = "KDSE2E45";
  const { createHash } = await import("node:crypto");
  await query(
    `INSERT INTO devices (id, school_id, kind, pairing_code_hash, pairing_expires_at) VALUES (gen_random_uuid(), $1, 'kitchen', $2, now() + interval '30 minutes')`,
    [SCHOOL_ID, createHash("sha256").update(second).digest("hex")],
  );
  const [day] = await query<{ date: string }>(`SELECT service_date::text AS date FROM service_days WHERE school_id = $1`, [SCHOOL_ID]);
  const date = day!.date;
  const delivered = await query<{ id: string }>(`SELECT id FROM orders WHERE school_id = $1 AND status = 'delivered' ORDER BY id`, [SCHOOL_ID]);
  const context = await browser.newContext({ timezoneId: "America/Sao_Paulo" });
  const page = await context.newPage();
  await page.goto(`/kds?date=${date}`);
  await page.getByTestId("kds-pair-code").fill(second);
  await page.getByTestId("kds-pair-submit").click();
  for (const o of delivered) {
    await expect(page.getByTestId(`kds-order-${o.id}`)).toHaveAttribute("aria-pressed", "true", { timeout: 20_000 });
  }
  await context.close();
});
