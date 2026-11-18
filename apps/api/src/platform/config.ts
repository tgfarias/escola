import { z } from "zod";

const secret = z.string().min(32);

const PlatformAccount = z.object({
  document_type: z.enum(["cpf", "cnpj"]),
  document: z.string().regex(/^\d+$/),
  account: z.string().min(1),
});

const Env = z.object({
  DATABASE_URL: z.string().min(1),
  INTERNAL_SERVICE_TOKEN: secret,
  INTERNAL_HMAC_SECRET: secret,
  SESSION_SECRET: secret,
  APP_BASE_URL: z.url(),
  PAYMENT_PROVIDER: z.enum(["fake", "efi"]).default("fake"),
  EFI_ENV: z.enum(["production", "homologacao"]).default("homologacao"),
  EFI_PLATFORM_ACCOUNT: z
    .string()
    .optional()
    .transform((text, ctx) => {
      if (text === undefined || text === "") return null;
      try {
        return PlatformAccount.parse(JSON.parse(text));
      } catch {
        ctx.addIssue({ code: "custom", message: "invalid" });
        return z.NEVER;
      }
    }),
  ENABLE_FAKE_PAYMENTS: z.enum(["true", "false"]).default("false"),
  JOBS_TOKEN: secret,
  N8N_EVENTS_URL: z.url().optional(),
  N8N_HMAC_SECRET: secret.optional(),
});

export interface Config {
  databaseUrl: string;
  internalServiceToken: string;
  internalHmacSecret: string;
  sessionSecret: string;
  appBaseUrl: string;
  paymentProvider: "fake" | "efi";
  fakePaymentsEnabled: boolean;
  efiEnv: "production" | "homologacao";
  efiPlatformAccount: { documentType: "cpf" | "cnpj"; document: string; account: string } | null;
  jobsToken: string;
  n8nEventsUrl: string | null;
  n8nHmacSecret: string | null;
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
  if ((env.N8N_EVENTS_URL === undefined) !== (env.N8N_HMAC_SECRET === undefined)) {
    throw new Error("invalid environment: N8N_EVENTS_URL, N8N_HMAC_SECRET");
  }
  cached = {
    databaseUrl: env.DATABASE_URL,
    internalServiceToken: env.INTERNAL_SERVICE_TOKEN,
    internalHmacSecret: env.INTERNAL_HMAC_SECRET,
    sessionSecret: env.SESSION_SECRET,
    appBaseUrl: env.APP_BASE_URL.replace(/\/+$/, ""),
    paymentProvider: env.PAYMENT_PROVIDER,
    fakePaymentsEnabled: env.ENABLE_FAKE_PAYMENTS === "true",
    efiEnv: env.EFI_ENV,
    efiPlatformAccount: env.EFI_PLATFORM_ACCOUNT
      ? {
          documentType: env.EFI_PLATFORM_ACCOUNT.document_type,
          document: env.EFI_PLATFORM_ACCOUNT.document,
          account: env.EFI_PLATFORM_ACCOUNT.account,
        }
      : null,
    jobsToken: env.JOBS_TOKEN,
    n8nEventsUrl: env.N8N_EVENTS_URL ?? null,
    n8nHmacSecret: env.N8N_HMAC_SECRET ?? null,
  };
  return cached;
}

/** Apenas para testes. */
export function resetConfigForTests(): void {
  cached = undefined;
}
