// @vitest-environment node
import { readFileSync } from "node:fs";
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

/** Corpos de todas as regras (também dentro de @media) cuja lista de seletores inclui `selector`, juntos. */
function bodiesOf(css: string, selector: string): string {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => m[1]!.split(",").map((s) => s.trim()).includes(selector))
    .map((m) => m[2])
    .join("\n");
}

describe("theme stylesheets", () => {
  it("builds the admin and kitchen theme with the ArchitectUI layout", () => {
    for (const selector of [".app-sidebar", ".app-header", ".metismenu-link", ".app-page-title", ".kds-card", ".skip-link"]) {
      expect(theme).toContain(selector);
    }
  });

  it("puts the open mobile drawer above its overlay", () => {
    const overlay = Number(/z-index:\s*(\d+)/.exec(bodiesOf(theme, ".sidebar-mobile-overlay"))![1]);
    const drawer = Number(/z-index:\s*(\d+)/.exec(rule(theme, ".sidebar-mobile-open .app-sidebar"))![1]);
    expect(drawer).toBeGreaterThan(overlay);
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

describe("layout polish", () => {
  const link = ".vertical-nav-menu .metismenu-container .metismenu-link";

  it("does not underline sidebar links until hover or keyboard focus, keeping the focus ring", () => {
    expect(bodiesOf(theme, link)).toContain("text-decoration: none");
    expect(bodiesOf(theme, `${link}:hover`)).toContain("text-decoration: underline");
    expect(bodiesOf(theme, `${link}:focus-visible`)).toContain("text-decoration: underline");
    expect(bodiesOf(theme, ":focus-visible")).toContain("outline: 2px solid #047c37");
  });

  it("paints the white sidebar column to the bottom of long pages and scrolls the menu on its own", () => {
    const column = bodiesOf(theme, ".fixed-sidebar .app-main::before");
    expect(column).toContain("bottom: 0");
    expect(column).toContain("width: 280px");
    expect(column).toContain("background: #fff");
    expect(bodiesOf(theme, ".fixed-sidebar.closed-sidebar .app-main::before")).toContain("width: 80px");
    const inner = bodiesOf(theme, ".fixed-sidebar .app-sidebar .app-sidebar__inner");
    expect(inner).toContain("max-height: calc(100vh - 60px)");
    expect(inner).toContain("overflow-y: auto");
  });

  it("keeps the school name inside a 390 px header, truncated, next to the logo badge", () => {
    expect(bodiesOf(theme, ".app-header .app-header__content")).toContain("padding: 0 0 0 1rem");
    expect(bodiesOf(theme, ".app-header .app-header__content")).toContain("min-width: 0");
    expect(bodiesOf(theme, ".app-header .app-header-left")).toContain("min-width: 0");
    const school = bodiesOf(theme, ".app-header .app-header__school");
    expect(school).toContain("text-overflow: ellipsis");
    expect(school).toContain("overflow: hidden");
    expect(bodiesOf(theme, ".app-header .app-header-right")).toContain("flex: 0 0 auto");
    expect(bodiesOf(theme, ".app-header__mobile-badge")).toMatch(/display: none[\s\S]*display: inline-flex/);
  });

  it("leaves room for the fixed header when scrolling to a home section", () => {
    for (const id of ["importar", "cardapio", "dias", "tablets"]) expect(bodiesOf(theme, `#${id}`)).toContain("scroll-margin-top: 76px");
  });

  it("marks disabled KDS cards without fading the text", () => {
    const disabled = bodiesOf(theme, ".kds-card:disabled");
    expect(disabled).not.toContain("opacity");
    expect(disabled).toContain("border-style: dashed");
    expect(disabled).toContain("background: #f8f9fa");
  });

  it("gives the KDS pills and the unpair button 44 px touch targets", () => {
    expect(bodiesOf(theme, ".kds-filters .nav-link")).toMatch(/min-height: (4[4-9]|[5-9]\d)px/);
    expect(bodiesOf(theme, ".kds-topbar .btn")).toContain("min-height: 44px");
  });

  it("drops the Bootstrap 4 table-head variables and keeps the ArchitectUI legal notice", () => {
    const variables = readFileSync(fileURLToPath(new URL("./scss/_theme-variables.scss", import.meta.url)), "utf8");
    expect(variables).not.toMatch(/\$table-head-(bg|color)/);
    expect(theme).toContain("/*! ArchitectUI (MIT) © DashboardPack — see LICENSE-ArchitectUI.txt */");
  });
});
