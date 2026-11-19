// @vitest-environment node
import { fileURLToPath } from "node:url";
import { compile } from "sass";
import { describe, expect, it } from "vitest";
import { SASS_SILENCED } from "../../build/sass";

const options = {
  loadPaths: [fileURLToPath(new URL("../../node_modules", import.meta.url))],
  quietDeps: true,
  silenceDeprecations: SASS_SILENCED,
};
const build = (file: string) => compile(fileURLToPath(new URL(file, import.meta.url)), options).css;
const theme = build("./theme.scss");
const base = build("./base.scss");

/** Corpo da última regra com exatamente esse seletor (o SCSS do App Lanche vem por último). */
function rule(css: string, selector: string): string {
  const start = css.lastIndexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`${selector} not found`);
  return css.slice(start, css.indexOf("}", start));
}

describe("theme stylesheets", () => {
  it("builds the admin and kitchen theme with the ArchitectUI layout", () => {
    for (const selector of [".app-sidebar", ".app-header", ".metismenu-link", ".app-page-title", ".kds-card", ".skip-link"]) {
      expect(theme).toContain(selector);
    }
  });

  it("keeps the theme layout out of the guardian base", () => {
    for (const marker of [".app-sidebar", ".app-header", ".metismenu", ".kds-", "pe-7s-"]) expect(base).not.toContain(marker);
    expect(base).toContain(".btn-primary");
    expect(base).toContain(".form-control");
  });

  it("uses the school palette with AA text colors", () => {
    expect(rule(theme, ".btn-primary")).toContain("--bs-btn-bg: #047c37");
    expect(rule(theme, ".btn-primary")).toContain("--bs-btn-color: #fff");
    for (const selector of [".btn-success", ".btn-warning", ".btn-info"]) expect(rule(theme, selector)).toContain("--bs-btn-color: #212529");
    expect(rule(theme, ".text-bg-success")).toContain("color: #212529");
    expect(rule(theme, ".app-header")).toContain("background: #047c37");
    expect(theme).toMatch(/\.metismenu-link\.active \{\s*color: #035d29;/);
    expect(rule(base, ".btn-primary")).toContain("--bs-btn-bg: #047c37");
  });
});
