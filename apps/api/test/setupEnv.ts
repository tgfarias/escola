import { afterAll, inject } from "vitest";
import { closeDb } from "../src/db/index";
import { closeAdminDb } from "./helpers";

process.env.DATABASE_ADMIN_URL = inject("adminUrl");
process.env.DATABASE_URL = inject("appUrl");
process.env.INTERNAL_SERVICE_TOKEN = "test-service-token-with-at-least-32-chars";
process.env.INTERNAL_HMAC_SECRET = "test-hmac-secret-with-at-least-32-chars";
process.env.SESSION_SECRET = "test-session-secret-with-at-least-32-chars";
process.env.APP_BASE_URL = "https://app.test";

afterAll(async () => {
  await closeDb();
  await closeAdminDb();
});
