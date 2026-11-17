import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/globalSetup.ts"],
    setupFiles: ["./test/setupEnv.ts"],
    testTimeout: 20_000,
    hookTimeout: 120_000,
  },
});
