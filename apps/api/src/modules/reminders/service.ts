import type { DeliveriesRequest, RemindersPrepareRequest, RemindersPrepareResponse } from "@app-lanche/contracts";
import { withTenant } from "../../db/index";
import { DomainError } from "../../platform/errors";
import * as auth from "../auth/service";
import * as catalog from "../catalog/service";
import * as wallet from "../wallet/service";
import * as repo from "./repo";

export const REMINDER_PAGE_SIZE = 200;

export async function prepareReminders(schoolId: string, body: RemindersPrepareRequest): Promise<RemindersPrepareResponse> {
  return withTenant(schoolId, async (trx) => {
    const day = await catalog.lockServiceDayByDate(trx, body.service_date, "share");
    if (!day) throw new DomainError("not_found");
    if (day.status !== "open" || !day.beforeCutoff) throw new DomainError("cutoff_passed");

    const batchId = await repo.ensureBatch(trx, schoolId, body.service_date);
    const rows = await repo.candidates(trx, { batchId, serviceDate: body.service_date, cursor: body.cursor, limit: REMINDER_PAGE_SIZE });
    const page = rows.slice(0, REMINDER_PAGE_SIZE);
    const hasMore = rows.length > REMINDER_PAGE_SIZE;
    const cutoffLocal = await repo.cutoffLocalTime(trx, day.id);

    const recipients = [];
    for (const g of page) {
      const link = await auth.createMagicLink(trx, { schoolId, guardianId: g.guardianId, scope: "order", serviceDate: body.service_date });
      recipients.push({
        guardian_id: g.guardianId,
        phone: g.phone,
        first_name: g.firstName,
        students: g.students,
        link_url: link.url,
        wallet_balance_cents: await wallet.balanceOf(trx, g.guardianId),
        cutoff_at: day.cutoffAt.toISOString(),
        cutoff_local_time: cutoffLocal,
      });
    }
    await repo.markPrepared(trx, schoolId, batchId, page.map((g) => g.guardianId));
    // O lote só termina quando não sobra ninguém a lembrar nem resultado pendente: um `prepared` sem
    // resultado volta depois que o arrendamento de 15 min vence.
    if (page.length === 0 && body.cursor === null && !(await repo.hasPrepared(trx, batchId))) await repo.completeBatch(trx, batchId);
    return { batch_id: batchId, next_cursor: hasMore ? page[page.length - 1]!.guardianId : null, recipients };
  });
}

export async function recordDeliveries(schoolId: string, batchId: string, body: DeliveriesRequest): Promise<void> {
  await withTenant(schoolId, async (trx) => {
    if (!(await repo.batchExists(trx, batchId))) throw new DomainError("not_found");
    for (const r of body.results) {
      await repo.recordResult(trx, batchId, {
        guardianId: r.guardian_id,
        status: r.status,
        waMessageId: r.status === "sent" ? r.wa_message_id : null,
        error: r.status === "failed" ? r.error : null,
      });
    }
  });
}
