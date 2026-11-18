import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/dev-dist/**", "apps/api/src/db/types.ts", "n8n/code/**", "test-results/**", "playwright-report/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // getDb ignora o tenant: só a camada db, os repo.ts que chamam funções SECURITY DEFINER e testes podem usá-lo (spec 4.4).
    files: ["apps/api/**/*.ts"],
    ignores: [
      "apps/api/src/db/**",
      "apps/api/src/modules/auth/repo.ts",
      "apps/api/src/modules/serviceDays/repo.ts",
      "apps/api/src/modules/outbox/repo.ts",
      "**/*.test.ts",
      "apps/api/test/**",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/db", "**/db/index", "**/db/index.ts"],
              importNames: ["getDb"],
              message: "getDb só é permitido em src/db, nos repo.ts que chamam funções SECURITY DEFINER e em testes. Use withTenant.",
            },
          ],
        },
      ],
    },
  },
);
