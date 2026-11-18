// Agenda (a cada 5 min): lembretes e fechamento do dia (spec 6.2).
async function closeDay(ctx, a) {
  const res = await api(ctx, "POST", `/internal/v1/service-days/${a.school_id}/${a.service_date}/close`);
  if (res.status === 409) return { closed: false, reason: res.body && res.body.error ? res.body.error.code : "conflict" };
  const m = ensureOk(res, "close");
  // O resumo da cozinha sai do evento service_day.closed (fluxo de eventos), qualquer que seja o fechamento.
  return { closed: true, orders: m.totals.orders };
}

async function sendReminders(ctx, a) {
  let cursor = null;
  let sent = 0;
  let failed = 0;
  for (let page = 0; page < 50; page += 1) {
    const res = await api(ctx, "POST", `/internal/v1/schools/${a.school_id}/reminders/prepare`, { service_date: a.service_date, cursor });
    if (res.status === 409) break;
    const body = ensureOk(res, "prepare");
    const results = [];
    for (const r of body.recipients) {
      const out = await whatsapp(ctx, r.phone, $env.WA_TEMPLATE_REMINDER, [
        r.first_name,
        joinNames(r.students),
        r.cutoff_local_time,
        brl(r.wallet_balance_cents),
        r.link_url,
      ]);
      if (out.ok) {
        sent += 1;
        results.push({ guardian_id: r.guardian_id, status: "sent", wa_message_id: out.id });
      } else {
        failed += 1;
        results.push({ guardian_id: r.guardian_id, status: "failed", error: out.error });
      }
    }
    if (results.length > 0) {
      ensureOk(await api(ctx, "POST", `/internal/v1/schools/${a.school_id}/reminders/${body.batch_id}/deliveries`, { results }), "deliveries");
    }
    cursor = body.next_cursor;
    if (!cursor) break;
  }
  return { sent, failed };
}

const due = ensureOk(await api(this, "GET", "/internal/v1/schedule/due"), "schedule").due;
const out = [];
for (const a of due) {
  const base = { action: a.action, school_id: a.school_id, service_date: a.service_date };
  try {
    const result = a.action === "close_service_day" ? await closeDay(this, a) : await sendReminders(this, a);
    out.push({ json: { ...base, ok: true, ...result } });
  } catch (err) {
    out.push({ json: { ...base, ok: false, error: String((err && err.message) || err).slice(0, 200) } });
  }
}
return out.length > 0 ? out : [{ json: { idle: true } }];
