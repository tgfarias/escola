import js from "@eslint/js";
import tseslint from "typescript-eslint";

const THEME_ONLY_IMPORTS = [
  "**/theme/styles*",
  "**/theme.scss",
  "**/theme/layout/**",
  "**/theme/notify*",
  "reactstrap",
  "reactstrap/**",
  "react-toastify",
  "react-toastify/**",
];
// Mesma lista para import() dinâmico, que no-restricted-imports não examina.
const THEME_ONLY_REGEX = String.raw`/(^|\/)theme\/(styles|layout\/|notify)|theme\.scss$|^(reactstrap|react-toastify)(\/|$)/`;
const THEME_ONLY_MESSAGE =
  "O tema (theme/styles, theme.scss, theme/layout, theme/notify, reactstrap, react-toastify) é só do admin e do KDS.";

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
  {
    // O tema (layout, CSS, toasts, reactstrap) é só do admin e do KDS, carregados sob demanda. A área dos responsáveis,
    // o App e src/ui não o importam, nem de forma estática nem com import(); theme/brand continua permitido.
    files: ["apps/web/src/areas/guardian/**", "apps/web/src/app/**", "apps/web/src/ui/**"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ group: THEME_ONLY_IMPORTS, message: THEME_ONLY_MESSAGE }] }],
      "no-restricted-syntax": [
        "error",
        { selector: `ImportExpression > Literal[value=${THEME_ONLY_REGEX}]`, message: THEME_ONLY_MESSAGE },
      ],
    },
  },
);
