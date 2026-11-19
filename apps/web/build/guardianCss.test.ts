import { describe, expect, it } from "vitest";
import { entryStylesheets, guardianCssProblems } from "./guardianCss.ts";

const HTML =
  '<!doctype html><html><head><script type="module" crossorigin src="/assets/index-a.js"></script>' +
  '<link rel="stylesheet" crossorigin href="/assets/index-a.css"></head><body></body></html>';

const NOTICE = "/*! ArchitectUI (MIT) © DashboardPack — see LICENSE-ArchitectUI.txt */";

describe("guardian css guard", () => {
  it("finds the stylesheets index.html loads up front", () => {
    expect(entryStylesheets(HTML)).toEqual(["/assets/index-a.css"]);
  });

  it("accepts a guardian entry without the theme layout", () => {
    expect(guardianCssProblems(HTML, { "assets/index-a.css": "body{margin:0}", "assets/AdminArea-b.css": `${NOTICE}.app-sidebar{width:280px}` })).toEqual([]);
  });

  it("flags theme layout in the guardian entry", () => {
    expect(guardianCssProblems(HTML, { "assets/index-a.css": `${NOTICE}.app-sidebar{}.app-header{}`, "assets/x.css": `${NOTICE}.app-sidebar{}` })).toEqual([
      "/assets/index-a.css contém .app-sidebar",
      "/assets/index-a.css contém .app-header",
    ]);
  });

  it("flags a theme stylesheet that lost the ArchitectUI legal notice in minification", () => {
    expect(guardianCssProblems(HTML, { "assets/index-a.css": "body{}", "assets/brand-b.css": ".app-sidebar{}" })).toEqual([
      "assets/brand-b.css perdeu o aviso de licença do ArchitectUI",
    ]);
  });

  it("flags a build without the theme", () => {
    expect(guardianCssProblems(HTML, { "assets/index-a.css": "body{}" })).toEqual(["o CSS do tema não foi gerado"]);
  });
});
