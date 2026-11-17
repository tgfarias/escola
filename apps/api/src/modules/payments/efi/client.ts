import https from "node:https";
import { z } from "zod";
import { config } from "../../../platform/config";
import { getSecret } from "../../../platform/secrets";

const Credentials = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  pix_key: z.string().min(1),
  certificate_p12_base64: z.string().min(1),
  certificate_passphrase: z.string().optional(),
});
export type EfiCredentials = z.infer<typeof Credentials>;

export type EfiTransport = (req: {
  credentials: EfiCredentials;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}) => Promise<{ status: number; body: unknown }>;

const HOSTS = { production: "pix.api.efipay.com.br", homologacao: "pix-h.api.efipay.com.br" } as const;
const TIMEOUT_MS = 15_000;
const agents = new Map<string, https.Agent>();
const tokens = new Map<string, { value: string; expiresAt: number }>();

export function loadCredentials(ref: string): EfiCredentials {
  const raw = getSecret(ref);
  try {
    return Credentials.parse(JSON.parse(raw));
  } catch {
    throw new Error(`secret ${ref} is not valid Efí credentials JSON`);
  }
}

function agentFor(c: EfiCredentials): https.Agent {
  let agent = agents.get(c.client_id);
  if (!agent) {
    agent = new https.Agent({
      pfx: Buffer.from(c.certificate_p12_base64, "base64"),
      passphrase: c.certificate_passphrase ?? "",
      keepAlive: true,
    });
    agents.set(c.client_id, agent);
  }
  return agent;
}

const httpsTransport: EfiTransport = (req) =>
  new Promise((resolve, reject) => {
    const r = https.request(
      {
        host: HOSTS[config().efiEnv],
        path: req.path,
        method: req.method,
        headers: { ...req.headers, ...(req.body ? { "content-type": "application/json" } : {}) },
        agent: agentFor(req.credentials),
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: unknown;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            body = null;
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    r.on("timeout", () => r.destroy(new Error("efi request timed out")));
    r.on("error", reject);
    if (req.body) r.write(req.body);
    r.end();
  });

let transport: EfiTransport = httpsTransport;

export function setEfiTransportForTests(t: EfiTransport | null): void {
  transport = t ?? httpsTransport;
}

export function resetEfiForTests(): void {
  tokens.clear();
  for (const a of agents.values()) a.destroy();
  agents.clear();
}

async function accessToken(c: EfiCredentials): Promise<string> {
  const cached = tokens.get(c.client_id);
  // Relógio local só para validade do token OAuth, nunca para regra de negócio.
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const res = await transport({
    credentials: c,
    method: "POST",
    path: "/oauth/token",
    headers: { authorization: `Basic ${Buffer.from(`${c.client_id}:${c.client_secret}`).toString("base64")}` },
    body: JSON.stringify({ grant_type: "client_credentials" }),
  });
  const parsed = z.object({ access_token: z.string().min(1), expires_in: z.number().int().positive() }).safeParse(res.body);
  if (res.status !== 200 || !parsed.success) throw new Error(`efi oauth failed: ${res.status}`);
  tokens.set(c.client_id, { value: parsed.data.access_token, expiresAt: Date.now() + (parsed.data.expires_in - 300) * 1000 });
  return parsed.data.access_token;
}

export async function efiCall(
  c: EfiCredentials,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const send = async () =>
    transport({
      credentials: c,
      method,
      path,
      headers: { ...headers, authorization: `Bearer ${await accessToken(c)}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const res = await send();
  if (res.status !== 401) return res;
  tokens.delete(c.client_id);
  return send();
}
