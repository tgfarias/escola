import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const DB = "postgres://app_user:app_user@localhost:5432/app_lanche_e2e";

export default defineConfig({
  testDir: ".",
  timeout: 60_000,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  globalSetup: "./global-setup.ts",
  use: { baseURL: "http://localhost:4173", timezoneId: "America/Sao_Paulo", trace: "retain-on-failure", ...devices["Desktop Chrome"] },
  // Os webServers sobem antes do globalSetup recriar o banco: a API só abre conexões com o Postgres
  // na primeira requisição (pool preguiçoso), e o /healthz não toca o banco.
  webServer: [
    {
      command: "pnpm --filter @app-lanche/api exec tsx src/server.ts",
      url: "http://localhost:8080/healthz",
      reuseExistingServer: false,
      env: {
        DATABASE_URL: DB,
        INTERNAL_SERVICE_TOKEN: "e2e-service-token-with-at-least-32-chars",
        INTERNAL_HMAC_SECRET: "e2e-hmac-secret-with-at-least-32-chars!!",
        SESSION_SECRET: "e2e-session-secret-with-at-least-32-chars",
        JOBS_TOKEN: "e2e-jobs-token-with-at-least-32-chars!!!",
        APP_BASE_URL: "http://localhost:4173",
        PAYMENT_PROVIDER: "fake",
        ENABLE_FAKE_PAYMENTS: "true",
        STORAGE_DRIVER: "local",
        ENABLE_LOCAL_STORAGE: "true",
        LOCAL_STORAGE_DIR: join(tmpdir(), "app-lanche-e2e-docs"),
        PORT: "8080",
      },
    },
    {
      command: "pnpm --filter @app-lanche/web build && pnpm --filter @app-lanche/web exec vite preview --port 4173 --strictPort",
      url: "http://localhost:4173",
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
