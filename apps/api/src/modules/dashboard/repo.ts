import type { DashboardPeriod } from "@app-lanche/contracts";
import { sql } from "kysely";
import type { Trx } from "../../db/index";

export type Period = { from: string; to: string; fromTs: Date; toTs: Date };

/** Datas locais da escola (inclusivas) e o intervalo de instantes [fromTs, toTs), pelo relógio do banco. */
export async function resolvePeriod(trx: Trx, period: DashboardPeriod): Promise<Period> {
  const { rows } = await sql<{ from: string; to: string; fromTs: Date; toTs: Date }>`
    WITH s AS (
      SELECT timezone AS tz, (now() AT TIME ZONE timezone)::date AS today FROM schools WHERE id = app_school_id()
    ), b AS (
      SELECT tz, today,
        CASE ${period}::text
          WHEN 'today' THEN today
          WHEN '7d' THEN today - 6
          ELSE date_trunc('month', today)::date
        END AS from_date
      FROM s
    )
    SELECT from_date::text AS "from", today::text AS "to",
      (from_date::timestamp AT TIME ZONE tz) AS from_ts,
      ((today + 1)::timestamp AT TIME ZONE tz) AS to_ts
    FROM b`.execute(trx);
  return rows[0]!;
}

export async function snackCounts(trx: Trx, p: Period) {
  const { rows } = await sql<{ paidOrders: number; deliveredOrders: number; notCollectedOrders: number; counterSales: number }>`
    SELECT
      (SELECT count(*) FROM orders WHERE service_date BETWEEN ${p.from}::date AND ${p.to}::date
         AND status IN ('confirmed', 'delivered', 'not_collected')) AS paid_orders,
      (SELECT count(*) FROM orders WHERE service_date BETWEEN ${p.from}::date AND ${p.to}::date
         AND status = 'delivered') AS delivered_orders,
      (SELECT count(*) FROM orders WHERE service_date BETWEEN ${p.from}::date AND ${p.to}::date
         AND status = 'not_collected') AS not_collected_orders,
      (SELECT count(*) FROM counter_sales WHERE voided_at IS NULL
         AND occurred_at >= ${p.fromTs} AND occurred_at < ${p.toTs}) AS counter_sales`.execute(trx);
  return rows[0]!;
}

export async function topItems(trx: Trx, p: Period) {
  const { rows } = await sql<{ name: string; qty: number }>`
    SELECT m.name, sum(x.qty)::bigint AS qty
    FROM (
      SELECT oi.menu_item_id, oi.qty FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.service_date BETWEEN ${p.from}::date AND ${p.to}::date
        AND o.status IN ('confirmed', 'delivered', 'not_collected')
      UNION ALL
      SELECT ci.menu_item_id, ci.qty FROM counter_sale_items ci JOIN counter_sales c ON c.id = ci.sale_id
      WHERE c.voided_at IS NULL AND c.occurred_at >= ${p.fromTs} AND c.occurred_at < ${p.toTs}
    ) x
    JOIN menu_items m ON m.id = x.menu_item_id
    GROUP BY m.id, m.name
    ORDER BY qty DESC, m.name
    LIMIT 5`.execute(trx);
  return rows;
}

export async function documentCounts(trx: Trx, p: Period) {
  const { rows } = await sql<{ published: number; viewed: number; batchesRendering: number; batchesWithFailures: number }>`
    SELECT
      (SELECT count(*) FROM documents d JOIN document_batches b ON b.id = d.batch_id
         WHERE b.status = 'published' AND b.published_at >= ${p.fromTs} AND b.published_at < ${p.toTs}
           AND d.status = 'rendered') AS published,
      (SELECT count(*) FROM documents d JOIN document_batches b ON b.id = d.batch_id
         WHERE b.status = 'published' AND b.published_at >= ${p.fromTs} AND b.published_at < ${p.toTs}
           AND d.status = 'rendered' AND EXISTS (SELECT 1 FROM document_views v WHERE v.document_id = d.id)) AS viewed,
      (SELECT count(*) FROM document_batches WHERE status = 'rendering') AS batches_rendering,
      (SELECT count(DISTINCT batch_id) FROM documents WHERE status = 'failed' AND discarded_at IS NULL) AS batches_with_failures`.execute(trx);
  return rows[0]!;
}

export async function moneyTotals(trx: Trx, p: Period) {
  const { rows } = await sql<{ pixReceivedCents: number; counterCents: number; creditsCents: number; debtCents: number; debtors: number }>`
    SELECT
      -- Só status 'paid': pagamentos estornados ficam de fora de propósito (valor líquido recebido).
      (SELECT coalesce(sum(amount_cents), 0)::bigint FROM payments
         WHERE status = 'paid' AND paid_at >= ${p.fromTs} AND paid_at < ${p.toTs}) AS pix_received_cents,
      (SELECT coalesce(sum(total_cents), 0)::bigint FROM counter_sales
         WHERE voided_at IS NULL AND occurred_at >= ${p.fromTs} AND occurred_at < ${p.toTs}) AS counter_cents,
      (SELECT coalesce(sum(balance_cents) FILTER (WHERE balance_cents > 0), 0)::bigint FROM wallets) AS credits_cents,
      (SELECT coalesce(-sum(balance_cents) FILTER (WHERE balance_cents < 0), 0)::bigint FROM wallets) AS debt_cents,
      (SELECT count(*) FROM wallets WHERE balance_cents < 0) AS debtors`.execute(trx);
  return rows[0]!;
}
