import { z } from "zod";
import { closeDb, withTenant } from "../db/index";
import { efiCall, loadCredentials } from "../modules/payments/efi/client";
import { splitConfigIdFor } from "../modules/payments/efi/efiProvider";
import { bpsToPercent } from "../modules/payments/efi/money";
import { config } from "../platform/config";
import { getSecret } from "../platform/secrets";

// Registers the Efí webhook and the platform split for one school. Prints only each step's outcome:
// never the webhook URL (it carries the token) nor credentials.
const [schoolIdArg, apiBaseUrlArg] = process.argv.slice(2);
const schoolId = z.uuid().safeParse(schoolIdArg);
const apiBaseUrl = z.url().safeParse(apiBaseUrlArg);
if (!schoolId.success || !apiBaseUrl.success) {
  console.error("usage: cli:efi-setup <school_id> <api_base_url>");
  process.exit(1);
}

class StepError extends Error {}

function ok(status: number, step: string): void {
  if (status < 200 || status >= 300) throw new StepError(`${step}: failed with HTTP ${status}`);
}

try {
  const cfg = config();
  const school = await withTenant(schoolId.data, (trx) =>
    trx
      .selectFrom("schools")
      .select(["paymentAccountRef", "paymentWebhookSecretRef", "platformFeeBps"])
      .where("id", "=", schoolId.data)
      .executeTakeFirst(),
  );
  if (!school) throw new StepError("school not found");
  if (!school.paymentAccountRef || !school.paymentWebhookSecretRef) {
    throw new StepError("school has no payment_account_ref or payment_webhook_secret_ref");
  }
  const credentials = loadCredentials(school.paymentAccountRef);
  const secret = getSecret(school.paymentWebhookSecretRef);
  if (!/^[A-Za-z0-9_-]{32,}$/.test(secret)) {
    throw new StepError("the webhook secret must be at least 32 characters of A-Z, a-z, 0-9, _ or -");
  }

  const base = apiBaseUrl.data.replace(/\/+$/, "");
  const webhookUrl = `${base}/webhooks/payments/efi/${schoolId.data}?token=${secret}&ignorar=`;
  const hook = await efiCall(
    credentials,
    "PUT",
    `/v2/webhook/${encodeURIComponent(credentials.pix_key)}`,
    { webhookUrl },
    { "x-skip-mtls-checking": "true" },
  );
  ok(hook.status, "webhook");
  console.log("webhook: ok");

  const fee = school.platformFeeBps;
  if (fee > 0) {
    const platform = cfg.efiPlatformAccount;
    if (!platform) throw new StepError("EFI_PLATFORM_ACCOUNT is required when platform_fee_bps > 0");
    const configId = splitConfigIdFor(schoolId.data);
    const split = await efiCall(credentials, "PUT", `/v2/gn/split/config/${configId}`, {
      descricao: "Taxa da plataforma",
      lancamento: { imediato: true },
      split: {
        divisaoTarifa: "assumir_total",
        minhaParte: { tipo: "porcentagem", valor: bpsToPercent(10_000 - fee) },
        repasses: [
          {
            tipo: "porcentagem",
            valor: bpsToPercent(fee),
            favorecido: { [platform.documentType]: platform.document, conta: platform.account },
          },
        ],
      },
    });
    ok(split.status, "split");
    console.log(`split: ok (config ${configId})`);
  } else {
    console.log("split: skipped (platform_fee_bps = 0)");
  }
} catch (err) {
  console.error(err instanceof StepError ? err.message : `efi-setup failed: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
