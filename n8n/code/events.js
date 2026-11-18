// Webhook de eventos da outbox (spec 6.3). Erro → resposta 500 → o dispatcher tenta de novo.
const MAX_SKEW_MS = 5 * 60 * 1000;
const item = $input.first();
const headers = item.json.headers || {};
const raw = (await this.helpers.getBinaryDataBuffer(0, "data")).toString("utf8");
const timestamp = String(headers["x-timestamp"] || "");
const signature = String(headers["x-signature"] || "");
const expected = sign($env.APP_LANCHE_EVENTS_SECRET, "POST", $env.APP_LANCHE_EVENTS_PATH, timestamp, raw);
const skew = Math.abs(Date.now() - Date.parse(timestamp));
const a = Buffer.from(signature);
const b = Buffer.from(expected);
if (!(Number.isFinite(skew) && skew <= MAX_SKEW_MS && a.length === b.length && crypto.timingSafeEqual(a, b))) {
  throw new Error("invalid signature");
}

const event = JSON.parse(raw);
const seen = $getWorkflowStaticData("global");
seen.events = seen.events || {};
const now = Date.now();
for (const [id, at] of Object.entries(seen.events)) if (now - at > 3 * 24 * 3600 * 1000) delete seen.events[id];
if (seen.events[event.id]) return [{ json: { ok: true, duplicate: true, email: null } }];

const d = event.data;
let email = null;
async function send(to, template, params, extra) {
  const res = await whatsapp(this, to, template, params, extra);
  if (!res.ok) throw new Error(`whatsapp failed: ${res.error}`);
}

switch (event.type) {
  case "auth.otp_requested":
    if (d.channel === "email") {
      email = { to: d.to, subject: "Seu código de acesso", text: `Seu código de acesso é ${d.code}. Ele vale por 5 minutos.` };
    } else {
      await send.call(this, d.to, $env.WA_TEMPLATE_OTP, [d.code], [
        { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: d.code }] },
      ]);
    }
    break;
  case "payment.confirmed":
    await send.call(this, d.phone, $env.WA_TEMPLATE_PAYMENT_CONFIRMED, [d.first_name, joinNames(d.students), dayMonth(d.service_date), brl(d.total_cents)]);
    break;
  case "payment.late_credited":
    await send.call(this, d.phone, $env.WA_TEMPLATE_LATE_CREDIT, [d.first_name, brl(d.amount_cents), brl(d.wallet_balance_cents)]);
    break;
  case "service_day.closed": {
    // Resumo da cozinha para qualquer fechamento (n8n, segurança, equipe); falha → 500 → nova tentativa da outbox.
    const m = ensureOk(await api(this, "GET", `/internal/v1/service-days/${event.school_id}/${d.service_date}/manifest`), "manifest");
    if (m.kitchen_phone && $env.WA_TEMPLATE_KITCHEN) {
      const items = m.totals.by_item.map((i) => `${i.qty}x ${i.item}`).join("; ") || "nenhum item";
      await send.call(this, m.kitchen_phone, $env.WA_TEMPLATE_KITCHEN, [dayMonth(d.service_date), m.totals.orders, items]);
    }
    break;
  }
  default:
    // Tipos futuros: aceitos sem mensagem.
    break;
}
// E-mail sai no nó seguinte; não entra na deduplicação (código repetido é inofensivo).
if (!email) seen.events[event.id] = now;
return [{ json: { ok: true, type: event.type, email } }];
