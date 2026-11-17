import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/dev-dist/**", "apps/api/src/db/types.ts"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // getDb ignora o tenant: só a camada db, o repo de auth e testes podem usá-lo (spec 4.4).
    files: ["apps/api/**/*.ts"],
    ignores: [
      "apps/api/src/db/**",
      "apps/api/src/modules/auth/repo.ts",
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
              message: "getDb só é permitido em src/db, modules/auth/repo.ts e testes. Use withTenant.",
            },
          ],
        },
      ],
    },
  },
);
