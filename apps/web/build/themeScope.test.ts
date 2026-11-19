// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { preprocessCSS, resolveConfig } from "vite";
import { beforeAll, describe, expect, it } from "vitest";
import { THEME_SCOPE, scopeSelector, styleSelectors } from "./themeScope.ts";

describe("theme scope", () => {
  it("prefixes selectors and turns :root, html and body into the themed root", () => {
    expect(scopeSelector(".app-sidebar")).toBe("html.app-themed .app-sidebar");
    expect(scopeSelector(".btn-check:checked + .btn")).toBe("html.app-themed .btn-check:checked + .btn");
    expect(scopeSelector(".was-validated .form-control:valid")).toBe("html.app-themed .was-validated .form-control:valid");
    expect(scopeSelector(":root")).toBe("html.app-themed");
    expect(scopeSelector("html")).toBe("html.app-themed");
    expect(scopeSelector("body")).toBe("html.app-themed body");
    expect(scopeSelector("body .card.mb-3")).toBe("html.app-themed body .card.mb-3");
    expect(scopeSelector(".body-x")).toBe("html.app-themed .body-x");
    expect(scopeSelector("html.app-themed .x")).toBe("html.app-themed .x");
  });

  it("lists the top-level selectors of style rules, skipping keyframes and font faces", () => {
    const css = "@font-face{font-family:x}a,b{c:d}@media (min-width:1px){.e{f:g}}@keyframes k{0%{o:0}to{o:1}}";
    expect(styleSelectors(css)).toEqual(["a", "b", ".e"]);
    expect(styleSelectors(":is(a, b) > c, d{x:y}")).toEqual([":is(a, b) > c", "d"]);
  });

  describe("in the real Vite pipeline", () => {
    const processed: Record<string, string> = {};
    beforeAll(async () => {
      const root = fileURLToPath(new URL("..", import.meta.url));
      const config = await resolveConfig({ root, configFile: `${root}/vite.config.ts`, logLevel: "silent" }, "build");
      for (const name of ["theme", "base"]) {
        const file = `${root}/src/theme/${name}.scss`;
        processed[name] = (await preprocessCSS(readFileSync(file, "utf8"), file, config)).code;
      }
    }, 60_000);

    it("scopes every rule of theme.scss, so leaving /kds or /admin without a reload keeps the guardian look", () => {
      const selectors = styleSelectors(processed.theme!);
      expect(selectors).toContain(`${THEME_SCOPE} .app-sidebar`);
      expect(selectors).toContain(THEME_SCOPE);
      expect(selectors.filter((s) => s !== THEME_SCOPE && !s.startsWith(`${THEME_SCOPE} `))).toEqual([]);
    });

    it("leaves the guardian base stylesheet unscoped", () => {
      expect(styleSelectors(processed.base!).some((s) => s.includes(THEME_SCOPE))).toBe(false);
    });
  });
});
