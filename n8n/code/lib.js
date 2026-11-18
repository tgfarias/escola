// ---- lib.js (gerado em cada Code node por n8n/build.mjs; edite em n8n/code/lib.js) ----
const crypto = require("crypto");
const API = String($env.APP_LANCHE_API_URL || "").replace(/\/+$/, "");

function sign(secret, method, pathWithQuery, timestamp, body) {
  return crypto
    .createHmac("sha256", secret)
    .update(`${method.toUpperCase()}\n${pathWithQuery}\n${timestamp}\n${body}`)
    .digest("hex");
}

function parseBody(body) {
  if (body === undefined || body === null || body === "") return null;
  if (Buffer.isBuffer(body)) body = body.toString("utf8");
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }
  return body;
}

/** Chamada assinada à API (spec 6.1). Devolve { status, body }. */
async function api(ctx, method, path, payload) {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const timestamp = new Date().toISOString();
  const headers = {
    authorization: `Bearer ${$env.APP_LANCHE_SERVICE_TOKEN}`,
    "x-timestamp": timestamp,
    "x-signature": sign($env.APP_LANCHE_HMAC_SECRET, method, path, timestamp, body),
  };
  if (method === "POST") headers["idempotency-key"] = crypto.randomUUID();
  if (body !== "") headers["content-type"] = "application/json";
  const res = await ctx.helpers.httpRequest({
    method,
    url: API + path,
    headers,
    body: body === "" ? undefined : body,
    json: false,
    returnFullResponse: true,
    ignoreHttpStatusErrors: true,
  });
  return { status: res.statusCode, body: parseBody(res.body) };
}

function ensureOk(res, what) {
  if (res.status < 200 || res.status >= 300) {
    const code = res.body && res.body.error ? res.body.error.code : "unknown";
    throw new Error(`${what} failed: ${res.status} ${code}`);
  }
  return res.body;
}

/** WhatsApp Cloud API, mensagem de modelo. Parâmetros sem quebra de linha. */
async function whatsapp(ctx, to, template, params, extraComponents) {
  const components = [
    { type: "body", parameters: params.map((p) => ({ type: "text", text: String(p).replace(/\s+/g, " ").trim() })) },
    ...(extraComponents || []),
  ];
  const res = await ctx.helpers.httpRequest({
    method: "POST",
    url: `https://graph.facebook.com/${$env.WHATSAPP_API_VERSION || "v21.0"}/${$env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    headers: { authorization: `Bearer ${$env.WHATSAPP_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: String(to).replace(/^\+/, ""),
      type: "template",
      template: { name: template, language: { code: "pt_BR" }, components },
    }),
    json: false,
    returnFullResponse: true,
    ignoreHttpStatusErrors: true,
  });
  const body = parseBody(res.body);
  if (res.statusCode >= 200 && res.statusCode < 300) {
    const id = body && body.messages && body.messages[0] && body.messages[0].id;
    return { ok: true, id: id || "unknown" };
  }
  const code = body && body.error && body.error.code;
  return { ok: false, error: code === 131026 || code === 100 ? "invalid_number" : typeof code === "number" ? `wa_${code}` : "send_failed" };
}

/** Centavos inteiros → "R$ 1.234,56" (sem ponto flutuante). */
function brl(cents) {
  const abs = Math.abs(cents);
  const reais = String(Math.trunc(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${cents < 0 ? "-" : ""}R$ ${reais},${String(abs % 100).padStart(2, "0")}`;
}

function joinNames(names) {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} e ${names[names.length - 1]}`;
}

/** "2026-11-17" → "17/11". */
function dayMonth(isoDate) {
  const [, m, d] = isoDate.split("-");
  return `${d}/${m}`;
}
// ---- fim de lib.js ----
