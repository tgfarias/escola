import { z } from "zod";

const secret = z.string().min(32);

const Env = z.object({
  DATABASE_URL: z.string().min(1),
  INTERNAL_SERVICE_TOKEN: secret,
  INTERNAL_HMAC_SECRET: secret,
  SESSION_SECRET: secret,
  APP_BASE_URL: z.url(),
  PAYMENT_PROVIDER: z.enum(["fake"]).default("fake"),
  ENABLE_FAKE_PAYMENTS: z.enum(["true", "false"]).default("false"),
});

export interface Config {
  databaseUrl: string;
  internalServiceToken: string;
  internalHmacSecret: string;
  sessionSecret: string;
  appBaseUrl: string;
  paymentProvider: "fake";
  fakePaymentsEnabled: boolean;
}

let cached: Config | undefined;

/** Valida process.env uma vez e guarda o resultado. Falha listando só os NOMES das variáveis. */
export function config(): Config {
  if (cached) return cached;
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))];
    throw new Error(`invalid environment: ${names.join(", ")}`);
  }
  const env = parsed.data;
  if (env.PAYMENT_PROVIDER === "fake" && env.ENABLE_FAKE_PAYMENTS !== "true") {
    throw new Error("invalid environment: PAYMENT_PROVIDER");
  }
  cached = {
    databaseUrl: env.DATABASE_URL,
    internalServiceToken: env.INTERNAL_SERVICE_TOKEN,
    internalHmacSecret: env.INTERNAL_HMAC_SECRET,
    sessionSecret: env.SESSION_SECRET,
    appBaseUrl: env.APP_BASE_URL.replace(/\/+$/, ""),
    paymentProvider: env.PAYMENT_PROVIDER,
    fakePaymentsEnabled: env.ENABLE_FAKE_PAYMENTS === "true",
  };
  return cached;
}

/** Apenas para testes. */
export function resetConfigForTests(): void {
  cached = undefined;
}
