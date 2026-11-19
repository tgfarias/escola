import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, inject } from "vitest";
import { closeDb } from "../src/db/index";
import { closeAdminDb } from "./helpers";

process.env.DATABASE_ADMIN_URL = inject("adminUrl");
process.env.DATABASE_URL = inject("appUrl");
process.env.INTERNAL_SERVICE_TOKEN = "test-service-token-with-at-least-32-chars";
process.env.INTERNAL_HMAC_SECRET = "test-hmac-secret-with-at-least-32-chars";
process.env.SESSION_SECRET = "test-session-secret-with-at-least-32-chars";
process.env.JOBS_TOKEN = "test-jobs-token-with-at-least-32-chars";
process.env.APP_BASE_URL = "https://app.test";
process.env.ENABLE_FAKE_PAYMENTS = "true";
process.env.PAYMENT_WEBHOOK_SECRET_TEST = "test-payment-webhook-secret-with-32-chars";
process.env.STORAGE_DRIVER = "local";
process.env.ENABLE_LOCAL_STORAGE = "true";
process.env.LOCAL_STORAGE_DIR = mkdtempSync(join(tmpdir(), "app-lanche-docs-"));

afterAll(async () => {
  await closeDb();
  await closeAdminDb();
});
